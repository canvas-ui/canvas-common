import { isRuleFile, transformRuleFile, mapRulePaths, rulePathMapper } from '../../../runtimes/workspace/services/hooks/rule-paths.js';
'use strict';

import { runBackfillBatch, BackfillRequestError, BACKFILL_MAX_LIMIT, BACKFILL_JOB_LIMIT } from '../../../runtimes/workspace/services/hooks/backfill.js';

import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { HOOK_EVENTS, HOOK_ACTIONS, CLASSIFIER_SURFACE, HOOK_CONTEXT_API, generateHookSkeleton } from '../../../runtimes/workspace/services/hooks/meta.js';
import { resolveRuleFiles, loadRuleFile, explainRule } from '../../../runtimes/workspace/services/hooks/rules.js';
import { resolveHookFiles } from '../../../runtimes/workspace/services/hooks/files.js';
import { classifyDocument, normalizeSchemaId } from '../../../runtimes/workspace/db/classifier.js';

function sendBackfillError(request, reply, error) {
  const response = new ResponseObject();
  if (error instanceof BackfillRequestError) {
    if (error.statusCode === 404) response.notFound(error.message);
    else response.badRequest(error.message);
  } else {
    request.log.error(error);
    response.serverError(`Backfill failed: ${error.message}`);
  }
  return reply.code(response.statusCode).send(response.getResponse());
}

function normalizePathSegments(inputPath = '') {
  return String(inputPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

function validateHookPath(inputPath) {
  const segments = normalizePathSegments(inputPath);
  if (!segments.length) {
    return { error: 'Hook path is required' };
  }

  if (segments.includes('..')) {
    return { error: 'Invalid hook path' };
  }

  const normalized = segments.join('/');

  // Declarative rules: `rules.json` plus one level of `rules/{name}.json`.
  // An `example-`/`disabled-`/`_` prefix (inactive file) is allowed for toggling.
  if (normalized.endsWith('.json')) {
    const isRulesFile = /^(?:example-|disabled-|_)?rules\.json$/.test(normalized)
      || (normalized.startsWith('rules/') && segments.length === 2);
    if (!isRulesFile) {
      return { error: 'JSON files must be rules.json or rules/{name}.json' };
    }
    return { path: normalized };
  }

  if (!normalized.endsWith('.js')) {
    return { error: 'Only .js hook files and rules .json files are allowed' };
  }

  // Allowed shapes: `{event}.js` (single handler), `{event}/{name}.js`
  // (one of several handlers for an event), or shared modules under `lib/`.
  const isLibFile = normalized.startsWith('lib/');
  if (!isLibFile && segments.length > 2) {
    return { error: 'Hooks must be {event}.js, {event}/{name}.js, or files under lib/' };
  }

  return { path: normalized };
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statEntry(basePath, relativePath) {
  const stat = await fs.stat(path.join(basePath, relativePath));
  return { path: relativePath, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

// Lists root `{event}.js` files plus one level of subdirectory handlers
// (`{event}/*.js` and `lib/*.js`). Handlers for an event are grouped under its
// directory; clients render them grouped by event name. Declarative rule files
// (`rules.json`, `rules/*.json`) are included alongside.
async function listHookFiles(basePath) {
  const dirents = await fs.readdir(basePath, { withFileTypes: true });
  const entries = [];
  const isListable = (name, dirName = null) => name.endsWith('.js')
    || (dirName === null && /^(?:example-|disabled-|_)?rules\.json$/.test(name))
    || (dirName === 'rules' && name.endsWith('.json'));

  for (const dirent of dirents) {
    if (dirent.isFile() && isListable(dirent.name)) {
      entries.push(await statEntry(basePath, dirent.name));
      continue;
    }
    if (!dirent.isDirectory()) { continue; }

    const subDirents = await fs.readdir(path.join(basePath, dirent.name), { withFileTypes: true });
    for (const sub of subDirents) {
      if (sub.isFile() && isListable(sub.name, dirent.name)) {
        entries.push(await statEntry(basePath, `${dirent.name}/${sub.name}`));
      }
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function commitHooks(fastify, request, message) {
  try {
    await request.workspace.dotfiles.commitHooks(message);
  } catch (error) {
    request.log.debug(`Hook git commit skipped: ${error.message}`);
  }
}

export default async function workspaceHooksRoutes(fastify) {
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      await fs.mkdir(request.workspace.hooksPath, { recursive: true });
      // Lazily sync seed examples shipped after the repo was initialized.
      await request.workspace.dotfiles.backfillSeed()
        .catch((error) => request.log.debug(`Seed backfill skipped: ${error.message}`));
      const files = await listHookFiles(request.workspace.hooksPath);
      const response = new ResponseObject().found(files, 'Workspace hooks retrieved successfully', 200, files.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace hooks');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Hook authoring metadata for clients (event catalog, actions, classifier
  // surface) — the create-hook wizard is a thin client of this + /generate.
  fastify.get('/meta', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    // Schemas actually present in THIS workspace (schema feature bitmaps),
    // with live document counts — so pickers offer what the DB really holds
    // instead of a hand-maintained list.
    const schemas = await request.workspace.listBitmaps('data/schema/')
      .then((bitmaps) => bitmaps
        .filter((b) => b.size > 0)
        .map((b) => ({ id: b.key, name: b.key.replace(/^data\/schema\//, ''), count: b.size }))
        .sort((a, b) => b.count - a.count))
      .catch(() => []);
    const response = new ResponseObject().found({
      events: HOOK_EVENTS,
      actions: HOOK_ACTIONS.map(({ id, label, description }) => ({ id, label, description })),
      classifier: CLASSIFIER_SURFACE,
      contextApi: HOOK_CONTEXT_API,
      schemas,
    }, 'Workspace hook metadata retrieved successfully');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Generate an editable hook skeleton from event + actions and write it into
  // git/hooks (Create > select event > select actions > edit skeleton).
  fastify.post('/generate', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['event'],
        properties: {
          event: { type: 'string' },
          name: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { event, name, actions } = request.body || {};
      let skeleton;
      try {
        skeleton = generateHookSkeleton({ event, name, actions });
      } catch (error) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, skeleton.path);
      if (await fileExists(filePath)) {
        const response = new ResponseObject().conflict(`Hook ${skeleton.path} already exists`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, skeleton.content, 'utf-8');
      await commitHooks(fastify, request, `Create hook ${skeleton.path}`);

      const response = new ResponseObject().created(
        { path: skeleton.path, content: skeleton.content },
        'Workspace hook created successfully',
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to generate workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Run log: per-execution records (hook files + rules) from
  // {WORKSPACE_ROOT}/var/hooks/runs.jsonl, newest first.
  fastify.get('/runs', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          handler: { type: 'string' },
          event: { type: 'string' },
          failed: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const runLog = request.workspace.hooks.runLog;
      if (!runLog) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { limit, handler, event, failed } = request.query || {};
      const runs = (await runLog.query({ limit, handler, event, failed }))
        // The list is a table; the trace is per-run detail (GET /runs/:runId).
        .map(({ trace, ...rest }) => ({ ...rest, ...(Array.isArray(trace) ? { traceLines: trace.length } : {}) }));
      const response = new ResponseObject().found(runs, 'Workspace hook runs retrieved successfully', 200, runs.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace hook runs');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // One run in full: the record plus its execution trace (what the agent was
  // asked and answered, where a store/download landed, why an action skipped).
  fastify.get('/runs/:runId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: { params: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } } },
  }, async (request, reply) => {
    try {
      const runLog = request.workspace.hooks.runLog;
      if (!runLog) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const run = await runLog.get(request.params.runId);
      if (!run) {
        const response = new ResponseObject().notFound(`Run ${request.params.runId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().found(run, 'Workspace hook run retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to read workspace hook run');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Pending actions: approval-gated automation waiting for review. List,
  // detail, and decisions (approve — optionally amended — or decline).
  fastify.get('/pending', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'declined', 'failed', 'expired'] },
          handler: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const store = request.workspace.hooks.pending;
      if (!store) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const { status, handler, limit } = request.query || {};
      const storedActions = await store.query({ status, handler, limit });
      const transform = rulePathMapper(request.workspace, 'decode');
      const actions = storedActions.map(record => ({ ...record, actions: mapRulePaths({ then: record.actions }, transform).then }));
      const response = new ResponseObject().found(actions, 'Pending actions retrieved successfully', 200, actions.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list pending actions');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/pending/:actionId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const store = request.workspace.hooks.pending;
      const stored = await store?.get(request.params.actionId);
      const record = stored ? { ...stored, actions: mapRulePaths({ then: stored.actions }, rulePathMapper(request.workspace, 'decode')).then } : null;
      if (!record) {
        const response = new ResponseObject().notFound(`Pending action ${request.params.actionId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().found(record, 'Pending action retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to get pending action');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Bulk decisions. `approve` entries are actionId strings or
  // { actionId, amend: { '<editable json-path>': value } }; `decline` entries
  // are actionId strings. Per-entry outcomes — one bad id never blocks the
  // rest of a bulk approve.
  fastify.post('/pending/decisions', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        properties: {
          approve: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['actionId'],
                  properties: { actionId: { type: 'string' }, amend: { type: 'object' } },
                },
              ],
            },
          },
          decline: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const hookService = request.workspace.hooks;

      const { approve = [], decline = [] } = request.body || {};
      const decidedBy = request.user?.id ?? null;
      const results = [];

      for (const entry of approve) {
        const actionId = typeof entry === 'string' ? entry : entry.actionId;
        const amend = typeof entry === 'object' && entry.amend ? entry.amend : null;
        try {
          const record = await hookService.decidePending(actionId, { decision: 'approve', amend, decidedBy });
          results.push({ actionId, status: record?.status ?? 'approved', result: record?.result ?? null });
        } catch (error) {
          results.push({ actionId, status: 'error', error: error.message });
        }
      }
      for (const actionId of decline) {
        try {
          const record = await hookService.decidePending(actionId, { decision: 'decline', decidedBy });
          results.push({ actionId, status: record?.status ?? 'declined' });
        } catch (error) {
          results.push({ actionId, status: 'error', error: error.message });
        }
      }

      const failed = results.filter((r) => r.status === 'error' || r.status === 'failed').length;
      const response = new ResponseObject().success(
        { decided: results.length, failed, results },
        failed ? 'Decisions applied with errors' : 'Decisions applied',
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError(`Failed to apply decisions: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Explain: which rules and JS hooks would fire for a document + event, with
  // a matcher-by-matcher breakdown ("why didn't my rule run"). Path matchers
  // evaluate against `paths` from the body when given (simulating a landing);
  // otherwise against the document's live tree placements.
  fastify.post('/explain', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      body: {
        type: 'object',
        required: ['documentId'],
        properties: {
          documentId: { type: 'integer' },
          event: { type: 'string', default: 'document.inserted' },
          paths: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { documentId, event = 'document.inserted', paths = [] } = request.body || {};
      let document = null;
      try {
        document = await request.workspace.get(documentId);
      } catch (error) {
        request.log.debug(`explain: get(${documentId}) failed: ${error.message}`);
      }
      if (!document) {
        const response = new ResponseObject().notFound(`Document ${documentId} not found (workspace inactive or unknown id)`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Explicit body paths simulate a landing; otherwise evaluate against the
      // document's LIVE placements (same shape backfill uses).
      const treePaths = {};
      if (!paths.length) {
        const placements = await request.workspace.listDocumentPlacements(documentId).catch(() => []);
        for (const placement of placements) {
          if (!placement?.paths?.length) { continue; }
          const key = placement.type === 'context' ? 'context' : placement.tree;
          treePaths[key] = [...new Set([...(treePaths[key] || []), ...placement.paths])];
        }
      }
      const payload = { id: documentId, document, context: paths.length ? { paths } : null, treePaths };
      const classification = classifyDocument(document, payload);

      const rules = [];
      for (const filePath of resolveRuleFiles(request.workspace.hooksPath)) {
        for (const rule of loadRuleFile(filePath, null, request.log, request.workspace)) {
          const explained = explainRule(rule, event, classification);
          rules.push({ id: rule.id || '?', description: rule.description, cascade: rule.cascade === true, ...explained });
        }
      }

      const hooksRoot = request.workspace.hooksPath;
      const hooks = resolveHookFiles(hooksRoot, event)
        .map((p) => ({ path: path.relative(hooksRoot, p), note: 'JS hook — would be invoked; its own code decides what to do' }));

      const response = new ResponseObject().found({
        documentId,
        event,
        schema: document.schema,
        paths,
        rules,
        hooks,
      }, 'Explain evaluated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to explain hooks for document');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Backfill: run ONE rule or JS hook against existing documents, as if each
  // had just been inserted. dryRun evaluates matchers only (per-doc breakdown).
  // Run one JS hook by hand with a synthesized, document-less envelope —
  // the trigger for structural hooks (backend folder sync, housekeeping)
  // that bind to `started` and otherwise only fire when the workspace
  // (re)starts. Document-shaped hooks want /backfill instead (real
  // documents, one run each); this endpoint is deliberately single-shot.
  // Writes the hook makes carry origin:'manual' and are cascade-guarded.
  fastify.post('/run', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['hookFile'],
        properties: {
          hookFile: { type: 'string', minLength: 1 },
          // Event name the hook sees (ctx.eventName). Defaults to the event
          // the file is bound to by its location ({event}.js / {event}/x.js).
          event: { type: 'string' },
          payload: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { hookFile, event, payload = {} } = request.body || {};
      const hookService = request.workspace.hooks;
      const boundEvent = hookFile.includes('/') ? hookFile.split('/')[0] : hookFile.replace(/\.js$/, '');
      const eventName = event || boundEvent || 'manual';
      const envelope = {
        ...payload,
        workspaceId: request.workspace.id,
        manual: true,
        eventId: crypto.randomUUID(),
        origin: 'manual',
        depth: 0,
      };
      const t0 = Date.now();
      const outcome = await hookService.runTargeted(
        { hookFile }, eventName, envelope, { trigger: 'manual' },
      );
      // runTargeted swallows hook errors into the run log; surface the latest
      // record so the caller gets ok/error without a second round trip.
      const runs = await hookService.runLog?.query({ limit: 1, handler: hookFile }).catch(() => []);
      const run = Array.isArray(runs) && runs[0] && new Date(runs[0].ts).getTime() >= t0 - 1000 ? runs[0] : null;
      const response = new ResponseObject().success({
        target: { hookFile }, event: eventName, ...outcome,
        ...(run ? { status: run.status, error: run.error, durationMs: run.durationMs, runId: run.runId } : {}),
      }, 'Hook executed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      const notFound = /not found|escapes/i.test(error.message);
      const response = notFound
        ? new ResponseObject().notFound(error.message)
        : new ResponseObject().serverError(`Run failed: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // cascade-guarded like any automation. Each envelope carries the document's
  // LIVE tree placements (payload.treePaths), so `when.path` matchers — incl.
  // tree-qualified ones like 'backends:/github/x' — evaluate against where
  // the document is filed right now.
  fastify.post('/backfill', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        properties: {
          ruleId: { type: 'string' },
          hookFile: { type: 'string' },
          event: { type: 'string', default: 'document.inserted' },
          schema: { type: 'string' },
          // Batch size. 100 keeps an accidental click cheap; the webui exposes
          // the knob (Batch size) for deliberate bulk runs over a big index.
          limit: { type: 'integer', minimum: 1, maximum: BACKFILL_MAX_LIMIT, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          dryRun: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { dryRun = false } = request.body || {};
      const response = new ResponseObject().success(await runBackfillBatch(request.workspace, request.body || {}),
        dryRun ? 'Backfill dry-run evaluated' : 'Backfill executed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      return sendBackfillError(request, reply, error);
    }
  });

  // Whole-rule runs: the workspace walks every matching document itself, so
  // a run does not depend on the client that started it. Poll for progress.
  fastify.post('/backfill/jobs', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['ruleIds'],
        properties: {
          ruleIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          limit: { type: 'integer', minimum: 1, maximum: BACKFILL_MAX_LIMIT, default: BACKFILL_JOB_LIMIT },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const response = new ResponseObject().success(request.workspace.hooks.backfillJobs.start(request.body), 'Backfill started');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      return sendBackfillError(request, reply, error);
    }
  });

  fastify.get('/backfill/jobs', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    const jobs = request.workspace.hooks.backfillJobs.list();
    const response = new ResponseObject().found(jobs, 'Backfill jobs retrieved', 200, jobs.length);
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Ends between documents; job.finished reports `cancelled`.
  fastify.delete('/backfill/jobs/:jobId', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    const job = request.workspace.hooks.backfillJobs.cancel(request.params.jobId);
    const response = job ? new ResponseObject().found(job, 'Backfill job cancelling') : new ResponseObject().notFound('Backfill job not found');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  fastify.get('/backfill/jobs/:jobId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    const job = request.workspace.hooks.backfillJobs.get(request.params.jobId);
    const response = job ? new ResponseObject().found(job, 'Backfill job retrieved') : new ResponseObject().notFound('Backfill job not found');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Replay one logged run: reload the document(s) by id, rebuild the envelope
  // (fresh eventId, origin:'replay', causedBy = the original eventId) and
  // re-run the recorded handler.
  fastify.post('/runs/:runId/replay', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    try {
      const hookService = request.workspace.hooks;
      const runLog = hookService?.runLogFor(request.workspace);
      if (!runLog) {
        const response = new ResponseObject().serverError('Hook service unavailable');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const record = await runLog.get(request.params.runId);
      if (!record) {
        const response = new ResponseObject().notFound(`Run ${request.params.runId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (!record.replayEnvelope || record.handlerType === 'dispatch') {
        const response = new ResponseObject().badRequest('Run record carries no replayable envelope');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const basePayload = { ...(record.replayEnvelope.payload || {}) };
      const docId = basePayload.document?.id ?? basePayload.id ?? null;
      if (docId != null) {
        let document = null;
        try { document = await request.workspace.get(docId); }
        catch (error) { request.log.debug(`replay: get(${docId}) failed: ${error.message}`); }
        if (!document) {
          const response = new ResponseObject().notFound(`Document ${docId} no longer exists — cannot replay`);
          return reply.code(response.statusCode).send(response.getResponse());
        }
        basePayload.document = document;
      }

      const payload = {
        ...basePayload,
        eventId: crypto.randomUUID(),
        origin: 'replay',
        causedBy: record.eventId ?? null,
        depth: 0,
      };

      const target = record.handlerType === 'rule' ? { ruleId: record.handler } : { hookFile: record.handler };
      const outcome = await hookService.runTargeted(
        target, record.replayEnvelope.event, payload, { trigger: 'replay' },
      );

      const response = new ResponseObject().success({
        replayedRunId: record.runId,
        target,
        event: record.replayEnvelope.event,
        ...outcome,
      }, 'Run replayed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError(`Replay failed: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Empty rules.json body for workspaces that haven't saved any rules yet.
  // Returned virtually on GET so the UI can open Rules without a 404 toast;
  // the file is only written when something is actually saved (PUT).
  const EMPTY_RULES_JSON = `${JSON.stringify({ $schema: 'canvas.hook-rules/v1', rules: [] }, null, 2)}\n`;

  fastify.get('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, result.path);
      let content;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        if (error?.code === 'ENOENT' && result.path === 'rules.json') {
          content = EMPTY_RULES_JSON;
        } else {
          throw error;
        }
      }
      if (isRuleFile(result.path)) {
        try { content = transformRuleFile(content, request.workspace, 'decode'); }
        catch (error) { request.log.debug(`Rule file cannot be rendered: ${error.message}`); }
      }
      const response = new ResponseObject().found({ path: result.path, content }, 'Workspace hook retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace hook not found')
        : new ResponseObject().serverError('Failed to get workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.put('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const filePath = path.join(request.workspace.hooksPath, result.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const content = request.body?.content || '';
      let stored = content;
      if (isRuleFile(result.path)) {
        try { stored = transformRuleFile(content, request.workspace, 'encode'); }
        catch (error) {
          const response = new ResponseObject().badRequest(error.message);
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }
      await fs.writeFile(filePath, stored, 'utf-8');
      await commitHooks(fastify, request, `Update hook ${result.path}`);

      const response = new ResponseObject().success({ path: result.path }, 'Workspace hook saved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to save workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    try {
      const result = validateHookPath(request.params['*']);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fs.unlink(path.join(request.workspace.hooksPath, result.path));
      await commitHooks(fastify, request, `Delete hook ${result.path}`);
      const response = new ResponseObject().deleted({ path: result.path }, 'Workspace hook deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = error?.code === 'ENOENT'
        ? new ResponseObject().notFound('Workspace hook not found')
        : new ResponseObject().serverError('Failed to delete workspace hook');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
