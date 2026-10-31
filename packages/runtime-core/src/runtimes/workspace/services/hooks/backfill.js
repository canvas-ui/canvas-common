import crypto from 'node:crypto';
import { explainRule } from './rules.js';
import { classifyDocument, normalizeSchemaId } from '../../db/classifier.js';

// Hard ceiling on one batch; the webui's batch size knob goes up to this.
export const BACKFILL_MAX_LIMIT = 10000;
export const BACKFILL_JOB_LIMIT = 500;

export class BackfillRequestError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

export function requireBackfillRule(hooks, ruleId) {
    const rule = hooks.findRule(ruleId);
    if (!rule) throw new BackfillRequestError(404, `Rule "${ruleId}" not found`);
    if (rule.when?.eventPathExact !== undefined) {
        throw new BackfillRequestError(400, 'This rule requires the original insert/link destination. Current Context membership cannot reconstruct it; replay an original event instead.');
    }
    return rule;
}

// Discover the same subtree a rule's segment-bounded path matcher accepts.
// Directory membership is node-exact unless recursive is explicitly requested.
export async function discoverBackfillDocuments(workspace, { paths = [], recursive = true, schemas = [], limit = 100, offset = 0 } = {}) {
    const selectors = paths.length ? paths.map((raw) => {
        const value = String(raw || '');
        const qualifier = value.match(/^([A-Za-z][\w-]*):(?=\/|$)/);
        const tree = qualifier ? (({ ctx: 'context', dir: 'directory' })[qualifier[1]] || qualifier[1]) : 'context';
        const path = (qualifier ? value.slice(qualifier[0].length) : value) || '/';
        return tree === 'context' ? { context: path } : { directory: { tree, path, recursive } };
    }) : [{}];
    const featureSets = schemas.length ? schemas.map((key) => [key]) : [null];
    const single = selectors.length * featureSets.length === 1;
    const seen = new Set();
    for (const selector of selectors) {
        for (const features of featureSets) {
            const batch = await workspace.list({
                ...selector, ...(features ? { features } : {}),
                applyCanvasQuerySpec: false, order: 'asc',
                // For a union, count unique IDs before paging. Only hydrate
                // the selected page, not every document in every source path.
                idsOnly: !single,
                limit: single ? limit + 1 : 0,
                offset: single ? offset : 0,
            });
            if (batch?.error) throw new Error(String(batch.error));
            const data = Array.isArray(batch) ? batch : batch?.data || [];
            if (single) {
                return {
                    docs: data.slice(0, limit),
                    total: batch.totalCount ?? (data.length <= limit ? offset + data.length : undefined),
                    nextOffset: data.length > limit ? offset + limit : null,
                };
            }
            for (const id of data) seen.add(id);
        }
    }
    const ordered = [...seen].sort((a, b) => a - b);
    const ids = ordered.slice(offset, offset + limit);
    const batch = ids.length ? await workspace.list({ ids, applyCanvasQuerySpec: false, order: 'asc', limit: ids.length }) : [];
    if (batch?.error) throw new Error(String(batch.error));
    return {
        docs: Array.isArray(batch) ? batch : batch?.data || [],
        total: ordered.length,
        nextOffset: offset + limit < ordered.length ? offset + limit : null,
    };
}

// One page of documents through a rule or JS hook. `onResult` sees each
// document as it finishes; `shouldStop` ends the page early between documents.
export async function runBackfillBatch(workspace, { ruleId, hookFile, event = 'document.inserted', schema, limit = 100, offset = 0, dryRun = false }, { onResult, shouldStop } = {}) {
    if ((ruleId ? 1 : 0) + (hookFile ? 1 : 0) !== 1) throw new BackfillRequestError(400, 'Pass exactly one of ruleId or hookFile');
    const hooks = workspace.hooks;
    const rule = ruleId ? requireBackfillRule(hooks, ruleId) : null;

    // Discovery: schema filter from the request, else from the rule's own
    // matcher (short names → full ids via the classifier map — plain prefix
    // concat cannot reach hierarchical ids like data/schema/message/email).
    const ruleSchemas = rule?.when?.schema ? (Array.isArray(rule.when.schema) ? rule.when.schema : [rule.when.schema]) : [];
    const requested = (schema ? [schema] : ruleSchemas).map((s) => normalizeSchemaId(s)).filter(Boolean);

    // Hierarchical expansion against the schema bitmaps actually present:
    // a parent-schema rule ('message') must discover sub-schema docs
    // ('message/email'), mirroring the matcher's segment-bounded semantics.
    let schemas = requested;
    if (requested.length) {
        const available = await workspace.listBitmaps('data/schema/').then((bitmaps) => bitmaps.map((b) => b.key)).catch(() => null);
        if (available) {
            schemas = [...new Set(requested.flatMap((id) => {
                const matches = available.filter((key) => key === id || key.startsWith(`${id}/`));
                return matches.length ? matches : [id];
            }))];
        }
    }

    // A `path` condition scopes discovery to the documents actually filed
    // under those prefixes, so a rule on `/To Read` reaches its own folder
    // however large the index is. Same qualifier grammar as the matcher:
    // bare / ctx: = context tree, dir: = directory tree, any other `name:` =
    // that tree.
    const sourcePaths = rule?.when?.pathExact ?? rule?.when?.path;
    const rulePaths = sourcePaths ? (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]) : [];
    let page;
    try {
        page = await discoverBackfillDocuments(workspace, { paths: rulePaths, recursive: rule?.when?.pathExact === undefined, schemas, limit, offset });
    } catch (error) {
        throw new Error(`Document discovery failed (workspace active?): ${error.message}`);
    }
    const { docs, nextOffset, total } = page;

    const results = [];
    let matched = 0;
    let failed = 0;
    for (const document of docs) {
        if (shouldStop?.()) break;
        if (!document?.id) continue;
        // Live placements ({ treeName: [paths] }; context-type trees merged
        // under 'context' to mirror live-event payload shape).
        const treePaths = {};
        const placements = await workspace.listDocumentPlacements(document.id).catch(() => []);
        for (const placement of placements) {
            if (!placement?.paths?.length) continue;
            const key = placement.type === 'context' ? 'context' : placement.tree;
            treePaths[key] = [...new Set([...(treePaths[key] || []), ...placement.paths])];
        }
        const payload = {
            id: document.id, document, context: null, directory: null, treePaths,
            eventId: crypto.randomUUID(), origin: 'backfill', depth: 0, backfill: true,
        };

        if (dryRun) {
            const explained = rule
                ? explainRule(rule, event, classifyDocument(document, payload))
                : { matched: null, checks: [] }; // JS hooks decide in code
            if (explained.matched) matched++;
            results.push({ docId: document.id, schema: document.schema, matched: explained.matched, checks: explained.checks });
            continue;
        }

        const outcome = await hooks.runTargeted(ruleId ? { ruleId } : { hookFile }, event, payload, { trigger: 'backfill' });
        if (outcome.status !== 'skipped') matched++;
        if (outcome.status === 'error') failed++;
        results.push({ docId: document.id, schema: document.schema, ...outcome });
        onResult?.(outcome);
    }

    return {
        target: ruleId ? { ruleId } : { hookFile }, event, dryRun,
        processed: docs.length, total, nextOffset, matched, failed, results,
    };
}
