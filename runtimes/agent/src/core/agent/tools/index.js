'use strict';

import path from 'path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { CanvasApiClient } from './client.js';
import { createTreeTools } from './trees.js';
import {
    SCHEMA_HELP,
    extractSubtree,
    formatPaths,
    normalizePath,
    pickFields,
    renderDocument,
    resolveSchema,
    summarizeDocument,
    treeToPaths,
} from './render.js';

/*
 * Canvas tools — the agent's interface to user data.
 *
 * Tool contracts:
 *  - Query tools preserve native structured results and counts. Individual
 *    documents can be rendered as readable text or returned as raw JSON.
 *  - `canvas_context` is the orientation call: what am I bound to, which
 *    workspace/context/path, what sub-paths exist.
 *  - Filing paths are relative to the binding; native query selectors are
 *    workspace-absolute. Authorization constrains candidates independently.
 */

const DEFAULT_FIND_LIMIT = 20;
const DEFAULT_GET_MAX_CHARS = 12000;

function toolResult(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }], details: undefined };
}

function toolError(error) {
    if (error.code === 'INVALID_DOCUMENT' || Array.isArray(error.payload?.failed)) return toolResult({ code: error.code, statusCode: error.statusCode, message: error.message, ...error.payload });
    if (error.code === 'WORKSPACE_STOPPED') return toolResult({ code: error.code, statusCode: 423,
        retryable: false, reason: error.reason, stoppedAt: error.stoppedAt, hint: error.hint, message: error.message });
    return toolResult(`Error: ${error.message}${error.statusCode ? ` (HTTP ${error.statusCode})` : ''}`);
}

// Join a model-supplied path under the binding base. Server clamps again.
function scopedPath(basePath, requested) {
    const raw = String(requested ?? '/').trim() || '/';
    const joined = path.posix.normalize(path.posix.join(basePath || '/', raw.replace(/^\/+/, '')));
    return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * @param {Object} env - agent runtime env map (runtime-env.js)
 * @returns {Promise<Array>} pi tool definitions
 */
export async function createCanvasTools(env) {
    const client = new CanvasApiClient(env);
    const { payload: querySchema } = await client.get('/schemas/query');
    if (querySchema?.type !== 'object' || !querySchema.properties?.match) throw new Error('Server must publish the native document query schema at /schemas/query.');
    const workspaceId = env.CANVAS_WORKSPACE;
    const workspaceName = env.CANVAS_WORKSPACE_NAME || workspaceId;
    const isGlobal = workspaceId === '*';
    const basePath = normalizePath(env.CANVAS_BASE_PATH || '/');
    const bindingType = env.CANVAS_BINDING_TYPE || (isGlobal ? 'global' : 'workspace');
    const contextId = env.CANVAS_CONTEXT_ID || null;
    const contextUrl = env.CANVAS_CONTEXT_URL || null;
    const documentsBase = (workspace) => `/workspaces/${encodeURIComponent(workspace)}/documents`;
    async function readPermissions(workspace, signal) {
        const result = await client.get(`/workspaces/${encodeURIComponent(workspace)}`, { signal: signal || AbortSignal.timeout(10000) });
        const values = result.payload?.access?.permissions;
        return Array.isArray(values) ? values : null;
    }
    let permissions = null;
    if (isGlobal) {
        try { const values = JSON.parse(env.CANVAS_PERMISSIONS || 'null'); if (Array.isArray(values)) permissions = values; } catch { /* No permission snapshot. */ }
    } else {
        permissions = await readPermissions(workspaceId).catch(() => null);
    }


    // Global bindings (CANVAS_WORKSPACE '*') address workspaces explicitly;
    // bound agents keep the implicit workspace and no extra parameter.
    const workspaceParams = isGlobal
        ? { workspace: Type.String({ description: 'Workspace id or name (required in global mode; list with canvas_workspace_list)' }) }
        : {};
    const resolveWorkspace = (params) => {
        if (!isGlobal) return workspaceId;
        const workspace = String(params?.workspace || '').trim();
        if (!workspace) throw new Error('workspace is required in global mode (list with canvas_workspace_list)');
        return workspace;
    };

    // Every feature/tag/schema bitmap key the workspace has, with its document
    // count. A filter on a key that is not here matches nothing, so canvas_doc_find
    // rejects it instead of returning an empty page that reads as "no results".
    async function listFeatureKeys(workspace, signal) {
        const result = await client.get(`/workspaces/${encodeURIComponent(workspace)}/bitmaps`, { signal });
        const rows = Array.isArray(result.payload) ? result.payload : [];
        return rows.filter((row) => typeof row?.key === 'string' && !row.key.startsWith('internal/'))
            .map((row) => ({ key: row.key, size: Number(row.size) || 0 }));
    }
    function assertKnownFeatures(features, known) {
        const keys = new Set(known.map((f) => f.key));
        const unknown = features.filter((f) => f !== 'data/dataset/default' && !keys.has(f));
        if (!unknown.length) return;
        const suggestions = unknown.flatMap((f) => {
            const prefix = f.split('/').slice(0, -1).join('/');
            return known.filter((k) => prefix && k.key.startsWith(`${prefix}/`)).map((k) => k.key);
        });
        const valid = [...new Set(suggestions.length ? suggestions : known.filter((k) => k.key.startsWith('feature/')).map((k) => k.key))].sort();
        const error = new Error(`Unknown feature${unknown.length > 1 ? 's' : ''} in this workspace: ${unknown.join(', ')}. `
            + `Valid names${valid.length ? `: ${valid.join(', ')}` : ' — none under that prefix'}. Use canvas_features to list every feature with its document count.`);
        error.statusCode = 400;
        throw error;
    }

    const scopeDescription = isGlobal
        ? 'global (all workspaces; pass "workspace" to every tool)'
        : `${bindingType} binding: workspace "${workspaceName}", path ${basePath}`;

    async function fetchScopePaths(workspace, relativePath = '/', depth, signal) {
        const result = await client.get(`/workspaces/${workspace}/tree`, { signal });
        const scopeRoot = isGlobal ? '/' : basePath;
        const root = extractSubtree(result.payload, scopedPath(scopeRoot, relativePath));
        if (!root) return null;
        return treeToPaths(root, { depth });
    }

    const canvasContext = defineTool({
        name: 'canvas_context',
        label: 'Canvas Context',
        description:
            'Describe your current canvas scope: binding type, workspace, context (if bound to one), '
            + 'the base path every other tool is relative to, the sub-paths under it and how many '
            + 'documents it holds. Call this first when the user refers to "the current context", '
            + '"here", "this workspace" or before navigating paths. Canvas has bitmap context trees (path nodes are ANDed) and directory trees (exact folders, optionally recursive). Tree tools select context or directory trees by name or ID; context membership does not record where a document was explicitly filed.',
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal) {
            try {
                if (!isGlobal) permissions = await readPermissions(workspaceId, signal).catch(() => null);
                const lines = [`Scope: ${scopeDescription}`, `permissions: ${JSON.stringify(permissions)}`, permissions === null ? 'Permissions unavailable; write tools are disabled until the binding can be verified.' : permissions.includes('write') ? 'Writes permitted.' : 'Read-only: document mutation tools are unavailable.'];
                if (isGlobal) {
                    lines.push('There is no single current context in global mode. Use canvas_workspace_list to list '
                        + 'workspaces, then pass "workspace" to canvas_tree_paths / canvas_doc_find / canvas_doc_get_by_id / canvas_doc_insert / canvas_link.');
                    return toolResult(lines.join('\n'));
                }
                lines.push(`Workspace: ${workspaceName}${workspaceName !== workspaceId ? ` (${workspaceId})` : ''}`);
                if (bindingType === 'context') {
                    lines.push(`Context: ${contextUrl || contextId || '(unknown)'}${contextId && contextUrl ? `  (id ${contextId})` : ''}`);
                    lines.push('The server enforces the current context binding on every request.');
                }
                lines.push(`Base path: ${basePath}  (all tool paths are relative to this; "/" means the scope root)`);

                const [paths, listing] = await Promise.all([
                    fetchScopePaths(workspaceId, '/', undefined, signal).catch((error) => ({ error })),
                    client.get(documentsBase(workspaceId), { signal, query: { context: basePath, limit: 1 } }).catch((error) => ({ error })),
                ]);
                if (listing?.error?.code === 'WORKSPACE_STOPPED') throw listing.error;
                if (paths?.error?.code === 'WORKSPACE_STOPPED') throw paths.error;
                if (listing?.error) {
                    lines.push(`Documents in scope: unavailable (${listing.error.message})`);
                } else {
                    const total = listing.totalCount ?? listing.count ?? 0;
                    lines.push(`Documents in scope (including sub-paths): ${total}`);
                }
                lines.push('');
                if (paths?.error) {
                    lines.push(`Sub-paths: unavailable (${paths.error.message})`);
                } else if (paths === null) {
                    lines.push('Sub-paths: base path not present in the workspace tree (yet)');
                } else {
                    lines.push(`Sub-paths (${paths.length}):`);
                    lines.push(formatPaths(paths));
                }
                return toolResult(lines.join('\n'));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasFind = defineTool({
        name: 'canvas_doc_find',
        label: 'Canvas Document Find',
        description: 'Query documents using the complete native Synapsd spec. Paths in spec are workspace-absolute; your token scope is independently ANDed before counting, ranking and pagination. Use features allOf/anyOf/noneOf, filters such as t:content:2026-10-01..2026-10-31, relations, named context/directory trees, idsOnly or countOnly. query is text or vectors; match: exact preserves verbatim string search; a leading - or ! excludes a word, a "phrase" or a @predicate token; @predicate:value tokens inside query filter by relation (e.g. @authored-by:someone@example.com). Compound lines use native OR/AND. Call canvas_features for valid bitmap keys. Each hit is a compact summary (id, schema, title, from, date, preview, attachments); pass fields for other document properties or raw for whole documents, then canvas_doc_get_by_id to read one. count, totalCount and per-line counts come from the server without client filtering.',
        parameters: Type.Object({
            spec: { ...querySchema, description: 'Native search request. Omit query for bitmap-only listing or count. limit 0 returns every match.' },
            fields: Type.Optional(Type.Array(Type.String(), { description: 'Dotted document paths to return per hit instead of the summary, e.g. ["data.subject", "data.attachments", "metadata.contentType"]. id and schema are always included.' })),
            raw: Type.Optional(Type.Boolean({ description: 'Return whole documents (every header and field). Large; prefer fields.' })),
            ...workspaceParams,
        }),
        async execute(_id, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const spec = structuredClone(params.spec);
                const featureKeys = value => Array.isArray(value)
                    ? value.map(key => key.replace(/^[+!-]/, ''))
                    : Object.values(value || {}).flat();
                const features = [...featureKeys(spec.features), ...(spec.lines || []).flatMap(line => featureKeys(line.features))];
                if (features.length) assertKnownFeatures(features, await listFeatureKeys(workspace, signal));
                if (spec.limit === undefined && spec.options?.limit === undefined) spec.limit = DEFAULT_FIND_LIMIT;
                const result = await client.post(`${documentsBase(workspace)}/search`, { signal, body: spec });
                if (params.raw || !Array.isArray(result.payload)) return toolResult(result);
                const shape = params.fields?.length ? (doc) => pickFields(doc, params.fields) : summarizeDocument;
                // idsOnly/countOnly pages carry numbers; only documents get reshaped.
                return toolResult({ ...result, payload: result.payload.map((hit) => (hit && typeof hit === 'object' ? shape(hit) : hit)) });
            } catch (error) { return toolError(error); }
        },
    });

    const documentGetter = (name, properties, route) => defineTool({
        name,
        label: 'Canvas Get',
        description:
            'Read one document by ID or checksum, rendered as text (an email as headers + body + attachment list, '
            + 'a note as title + content, ...). Set "raw": true for the untouched JSON document.',
        parameters: Type.Object({
            ...properties,
            raw: Type.Optional(Type.Boolean({ description: 'Return raw JSON instead of rendered text' })),
            maxChars: Type.Optional(Type.Number({ description: `Cap on rendered body length (default ${DEFAULT_GET_MAX_CHARS})` })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get(`${documentsBase(resolveWorkspace(params))}${route(params)}`, { signal });
                let document = result.payload ?? null;
                if (!document) return toolResult('Document not found in your scope.');
                if (params.raw) return toolResult(document);
                if (document.schema === 'data/schema/message/email'
                    && typeof document.data?.body !== 'string' && typeof document.data?.bodyHtml !== 'string') {
                    const body = await client.get(`${documentsBase(resolveWorkspace(params))}/${document.id}/content`, { signal, query: { format: 'email' } });
                    document = { ...document, data: { ...document.data, ...body } };
                }
                const maxChars = Number.isFinite(Number(params.maxChars)) && Number(params.maxChars) > 0
                    ? Math.floor(Number(params.maxChars))
                    : DEFAULT_GET_MAX_CHARS;
                return toolResult(renderDocument(document, { maxChars }));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const docIdProperty = { docId: Type.Integer({ minimum: 1, description: 'Document ID' }) };
    const canvasGet = documentGetter('canvas_doc_get_by_id', docIdProperty, params => `/by-id/${params.docId}`);
    const canvasGetByHash = documentGetter('canvas_doc_get_by_hash', {
        algorithm: Type.String({ description: 'Checksum algorithm, e.g. sha256' }), hash: Type.String(),
    }, params => `/by-hash/${encodeURIComponent(params.algorithm)}/${encodeURIComponent(params.hash)}`);

    const canvasSchema = defineTool({
        name: 'canvas_schema',
        label: 'Canvas Schema',
        description: 'Get the authoritative document schema: required and optional fields, JSON Schema, an input example when available, and normalization rules. Use before inserting unfamiliar types. Link fields are uri/label; tab fields are url/title.',
        parameters: Type.Object({ schema: Type.String({ description: `Document type: ${SCHEMA_HELP}` }) }),
        async execute(_id, params, signal) {
            try {
                const schema = resolveSchema(params.schema);
                const result = await client.get(`/schemas/${schema.split('/').map(encodeURIComponent).join('/')}`, { signal });
                return toolResult(result.payload);
            } catch (error) { return toolError(error); }
        },
    });

    const canvasInsert = defineTool({
        name: 'canvas_doc_insert',
        label: 'Canvas Insert',
        description:
            'Insert a document into your scope. Provide "schema" (short name such as note, task, tab, link, '
            + 'event or a full data/schema/... id) and "data" (e.g. note: { title, content }; task: { title, '
            + 'description, status, dueDate (ISO timestamp or YYYY-MM-DD), priority (1 highest to 9 lowest) }; tab: { url, title }; link: { uri, label, tags }) plus an optional path relative to your scope. Call canvas_schema for fields and an example. The tasks timeline is derived automatically. Missing paths are created unless createPath is false. Returns id, created (true only for a new document), status and path. Changed content can create a new document; use canvas_link to file existing IDs without rewriting. Requires write permission.',
        parameters: Type.Object({
            schema: Type.String({ description: `Document type: ${SCHEMA_HELP}` }),
            data: Type.Object({}, { additionalProperties: true, description: 'Schema-specific document payload as a JSON object, not a JSON-encoded string. Call canvas_schema for required fields.' }),
            path: Type.Optional(Type.String({ description: 'Context path relative to your scope (default: scope root)' })),
            createPath: Type.Optional(Type.Boolean({ description: 'Create missing paths (default true). False returns 404 when the destination is missing; never inserts at root instead.' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const currentPermissions = await readPermissions(workspace, signal);
                if (!currentPermissions?.includes('write')) throw new Error('Read-only token: canvas_doc_insert requires write permission.');
                const schema = resolveSchema(params.schema);
                const contextPath = scopedPath(isGlobal ? '/' : basePath, params.path);
                const result = await client.post(documentsBase(workspace), {
                    signal,
                    body: {
                        documents: [{ schema, data: params.data }],
                        returnDetails: true,
                        createPath: params.createPath ?? true,
                        context: contextPath,
                    },
                });
                const outcome = result.payload?.[0];
                if (typeof outcome?.created !== 'boolean') throw new Error('Server did not return insert details; update the server and Synapsd together.');
                return toolResult({ ...outcome, schema, path: normalizePath(params.path || '/') });
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasLink = defineTool({
        name: 'canvas_link',
        label: 'Canvas Link',
        description: 'File existing documents at another path in your scope, preserving their content, dates, checksums and versions. Use this instead of re-inserting document data. Returns linked IDs for new memberships and alreadyLinked IDs for existing memberships (context paths use AND-ed layer bitmaps, not filing history). Missing paths are created by default; created reports whether this call created the path. Requires write permission; documents must already be accessible within your scope.',
        parameters: Type.Object({
            docIds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: 'Existing document IDs to attach; never sends document content.' }),
            path: Type.String({ description: 'Destination path relative to your scope' }),
            createPath: Type.Optional(Type.Boolean({ description: 'Create missing destination paths (default true); false returns 404 if missing.' })),
            ...workspaceParams,
        }),
        async execute(_id, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const currentPermissions = await readPermissions(workspace, signal);
                if (!currentPermissions?.includes('write')) throw new Error('Read-only token: canvas_link requires write permission.');
                const result = await client.post(documentsBase(workspace), { signal, body: {
                    documentIds: params.docIds,
                    context: scopedPath(isGlobal ? '/' : basePath, params.path),
                    createPath: params.createPath ?? true,
                } });
                return toolResult({ path: normalizePath(params.path), created: (result.payload.createdPaths || []).length > 0, linked: result.payload.successful.filter(entry => !entry.alreadyLinked).map(entry => entry.id), alreadyLinked: result.payload.successful.filter(entry => entry.alreadyLinked).map(entry => entry.id), failed: result.payload.failed });
            } catch (error) { return toolError(error); }
        },
    });

    const documentTool = (name, description, properties, method, route, makeOptions, write = false) => defineTool({
        name, label: name, description,
        parameters: Type.Object({ ...properties, ...workspaceParams }),
        async execute(_id, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                if (write && !(await readPermissions(workspace, signal))?.includes('write')) throw new Error(`Read-only token: ${name} requires write permission.`);
                return toolResult(await client.request(method, `${documentsBase(workspace)}${route(params)}`, { signal, ...makeOptions(params) }));
            } catch (error) { return toolError(error); }
        },
    });
    const idsProperty = { docIds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }) };
    const canvasUpdate = documentTool('canvas_doc_update',
        'Update an existing document by ID, without checksum-based insertion. Omitted fields stay unchanged. data replaces the entire schema-specific data object: read it first when editing individual fields. metadata, comment, features and timelines use the existing document update contract. Connector-backed documents write through to their source. Requires write permission.',
        { ...docIdProperty, changes: Type.Object({
            data: Type.Optional(Type.Object({}, { additionalProperties: true })),
            metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
            comment: Type.Optional(Type.String()), features: Type.Optional(Type.Array(Type.String())),
            timelines: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
        }, { minProperties: 1, additionalProperties: false }) }, 'PUT', () => '',
        params => ({ body: { documents: [{ ...params.changes, id: params.docId }], context: basePath } }), true);
    const canvasUnlink = documentTool('canvas_unlink',
        'Remove document membership at a context path, preserving content and other memberships. Context nodes are shared bitmaps: unticking a layer affects every context path using that layer, not an explicit filing record. Requires write permission.',
        { ...idsProperty, path: Type.String() }, 'DELETE', () => '/remove',
        params => ({ body: params.docIds, query: { context: scopedPath(isGlobal ? '/' : basePath, params.path) } }), true);
    const canvasContent = documentTool('canvas_doc_content',
        'Read document or attachment bytes for summarisation. Text is returned as text and binary as base64, with MIME type. Limited to 1 MiB; use the authenticated REST content endpoint for larger files. url must identify one of this document’s locations or attachments. format: email returns parsed email bodies.',
        { ...docIdProperty, url: Type.Optional(Type.String()), format: Type.Optional(Type.Literal('email')) },
        'GET', params => `/${params.docId}/content`, params => ({ query: { url: params.url, format: params.format }, responseType: 'content' }));
    const canvasLocations = documentTool('canvas_doc_locations', 'Describe the available backend locations for a document.',
        docIdProperty, 'GET', params => `/${params.docId}/locations`, () => ({}));
    const canvasDownload = documentTool('canvas_doc_download', 'Fetch a linked remote resource into the workspace using its existing download workflow. Requires write permission.',
        docIdProperty, 'POST', params => `/${params.docId}/download`, () => ({}), true);
    const transfer = mode => documentTool(`canvas_doc_${mode}_to_backend`,
        `${mode === 'move' ? 'Move' : 'Copy'} existing documents to backend locations using the native transfer service. A move releases sources only after the destination copy is durable. Supports transfers within or between backends. Inspect per-document failures before retrying. Requires write permission.`,
        { ...idsProperty, to: Type.Array(Type.String(), { minItems: 1, ...(mode === 'move' ? { maxItems: 1 } : {}) }),
            folder: Type.Optional(Type.String()), filename: Type.Optional(Type.String()),
            onConflict: Type.Optional(Type.Union(['rename', 'overwrite', 'error'].map(value => Type.Literal(value)))),
            deleteFrom: Type.Optional(Type.Object({ backend: Type.String(), folder: Type.String() })),
        }, 'POST', () => '/transfer', params => ({ body: { documentIds: params.docIds, to: params.to, mode,
            folder: params.folder, filename: params.filename, onConflict: params.onConflict, deleteFrom: params.deleteFrom } }), true);
    const canvasCopyBackend = transfer('copy');
    const canvasMoveBackend = transfer('move');

    const canvasNotify = defineTool({
        name: 'canvas_notify',
        label: 'Canvas Notify',
        description:
            'Send a notification message to your user over their configured channel '
            + '(WhatsApp, Slack, ...). Use for alerts and results the user asked to be '
            + 'notified about. You can only notify your own user.',
        parameters: Type.Object({
            message: Type.String({ description: 'Message text to deliver' }),
            channel: Type.Optional(Type.String({ description: 'Channel override (e.g. whatsapp, slack); defaults to the user\'s default channel' })),
        }),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.post('/messaging/notify', {
                    signal,
                    body: {
                        message: params.message,
                        ...(params.channel ? { channel: params.channel } : {}),
                    },
                });
                return toolResult(result.payload ?? { delivered: true });
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasMessageAccounts = defineTool({
        name: 'canvas_message_accounts', label: 'Canvas Message Accounts',
        description: 'List email, Slack and WhatsApp accounts and whether sending is enabled for agents. Sending communicates externally as that account.',
        parameters: Type.Object({ ...workspaceParams }),
        async execute(_id, params, signal) {
            try { return toolResult((await client.get(`/workspaces/${resolveWorkspace(params)}/messages/accounts`, { signal })).payload); }
            catch (error) { return toolError(error); }
        },
    });
    const canvasMessageStatus = defineTool({
        name: 'canvas_message_status', label: 'Canvas Message Status',
        description: 'Check your previously attempted send by requestId, without delivering another message. An unknown result must be checked in the provider conversation before starting another send.',
        parameters: Type.Object({ ...workspaceParams, requestId: Type.String() }),
        async execute(_id, params, signal) {
            try { return toolResult((await client.get(`/workspaces/${resolveWorkspace(params)}/messages/outbox/${encodeURIComponent(params.requestId)}`, { signal })).payload); }
            catch (error) { return toolError(error); }
        },
    });
    const canvasSendMessage = defineTool({
        name: 'canvas_send_message', label: 'Canvas Send Message',
        description: 'Send an external message through a configured account, or reply to a message document. Use only when the user has authorized communicating with these recipients. Supply a stable UUID requestId and reuse it unchanged after a timeout; never create another ID to retry an unknown result. accepted means provider acceptance, not recipient delivery. Reply resolves its account and thread automatically. Path-bound agents may reply only to in-scope messages.',
        parameters: Type.Object({
            ...workspaceParams,
            requestId: Type.String({ description: 'Unique request UUID; reuse for retries of this exact message' }),
            text: Type.String({ maxLength: 32000 }),
            replyToDocumentId: Type.Optional(Type.Integer({ minimum: 1 })),
            driver: Type.Optional(Type.Union([Type.Literal('imap'), Type.Literal('slack'), Type.Literal('whatsapp')])),
            address: Type.Optional(Type.String({ description: 'Account label from canvas_message_accounts; omitted for replies' })),
            target: Type.Optional(Type.String({ description: 'Configured Slack channel name/ID or WhatsApp conversation ID; omitted for replies' })),
            to: Type.Optional(Type.Array(Type.String())), cc: Type.Optional(Type.Array(Type.String())), bcc: Type.Optional(Type.Array(Type.String())),
            subject: Type.Optional(Type.String()), replyAll: Type.Optional(Type.Boolean()),
            quote: Type.Optional(Type.Boolean({ description: 'Email replies: quote the original message below the text' })),
            forward: Type.Optional(Type.Boolean({ description: 'Email only: forward replyToDocumentId (with its attachments) to `to`; text may be empty' })),
        }),
        async execute(_id, params, signal) {
            try {
                const { workspace: _workspace, ...body } = params;
                return toolResult((await client.post(`/workspaces/${resolveWorkspace(params)}/messages/send`, { body, signal })).payload);
            } catch (error) { return toolError(error); }
        },
    });

    const canvasFeatures = defineTool({
        name: 'canvas_features',
        label: 'Canvas Features',
        description:
            'List the feature keys a workspace has, with document counts: schemas (data/schema/*), '
            + 'features (feature/email/attachment, feature/email/received, ...), tags (tag/*) and other '
            + 'bitmap facets. Use these keys in canvas_doc_find spec.features. Narrow with "prefix" (e.g. "feature/email").',
        parameters: Type.Object({
            prefix: Type.Optional(Type.String({ description: 'Only keys under this prefix, e.g. feature, feature/email, tag' })),
            ...workspaceParams,
        }),
        async execute(toolCallId, params, signal) {
            try {
                const workspace = resolveWorkspace(params);
                const prefix = String(params.prefix || '').trim().replace(/^\/+|\/+$/g, '');
                const rows = (await listFeatureKeys(workspace, signal))
                    .filter((row) => !prefix || row.key === prefix || row.key.startsWith(`${prefix}/`))
                    .sort((a, b) => a.key.localeCompare(b.key));
                if (!rows.length) return toolResult(prefix ? `No features under "${prefix}".` : 'No features.');
                return toolResult(`${rows.length} feature${rows.length === 1 ? '' : 's'}${prefix ? ` under ${prefix}` : ''}:\n`
                    + rows.map((row) => `${row.key}  (${row.size})`).join('\n'));
            } catch (error) {
                return toolError(error);
            }
        },
    });

    const canvasWorkspaces = defineTool({
        name: 'canvas_workspace_list',
        label: 'Canvas Workspaces',
        description: 'List the workspaces you can access (global mode only), one per line. Use the name or id as the "workspace" parameter of the other canvas tools.',
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal) {
            try {
                const result = await client.get('/workspaces', { signal });
                const workspaces = Array.isArray(result.payload) ? result.payload : [];
                if (!workspaces.length) return toolResult('No accessible workspaces.');
                const lines = workspaces.map((workspace) => {
                    const bits = [workspace.status, workspace.label && workspace.label !== workspace.name ? workspace.label : null, workspace.description].filter(Boolean);
                    return `${workspace.name}  (${workspace.id})${bits.length ? `  — ${bits.join(', ')}` : ''}`;
                });
                return toolResult(`${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
            } catch (error) {
                return toolError(error);
            }
        },
    });

    return [
        canvasContext,
        ...createTreeTools({ client, workspaceParams, resolveWorkspace, basePath, permissions, readPermissions, scopedPath, toolResult, toolError }),
        canvasFind,
        canvasGet,
        canvasGetByHash,
        canvasContent,
        canvasLocations,
        canvasSchema,
        canvasFeatures,
        ...(permissions?.includes('write') ? [canvasInsert, canvasLink, canvasUnlink, canvasUpdate, canvasDownload, canvasCopyBackend, canvasMoveBackend] : []),
        canvasNotify,
        canvasMessageAccounts,
        canvasMessageStatus,
        canvasSendMessage,
        ...(isGlobal ? [canvasWorkspaces] : []),
    ];
}
