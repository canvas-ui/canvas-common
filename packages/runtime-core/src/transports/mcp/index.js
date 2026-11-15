import { toolSchemas } from './schema.js';
import { buildTool, toolRequest } from './tools.js';
import { PROTOCOL_VERSION, rpcError, complete, requestMetadata, requestHeaders, validateRequest } from './protocol.js';

const endpoint = '/rest/v2/mcp';
const prefix = '/rest/v2';
const passHeaders = ['content-type', 'accept', 'range', 'if-match', 'if-none-match', 'upload-offset', 'x-canvas-mtime'];
const pattern = url => new RegExp(`^${url.split(/(:\w+|\*)/).map(part => part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}/?$`);

/**
 * Mount a route plugin a second time under an alias URL that drops path
 * parameters (`/tree` beside `/trees/:tree`). The alias adds no tools: each
 * tool the first mount declared serves the alias when the dropped arguments
 * are omitted, which makes them optional.
 */
export const mcpAlias = plugin => async function aliasedRoutes(instance, options) {
    instance.decorate('mcpAlias', true);
    await plugin(instance, options);
};

const apiTools = [
    {
        name: 'api_route_list',
        description: 'List the REST routes of this server, for use with api_request. The named tools cover everyday work with workspaces, documents, trees and messages; come here only when none fits (administration, storage backends, hooks and rules, sync, tokens, timelines and more). A row with tools is already served by those tools. Pass filter to narrow by a word in the path, and schemas to see query and body fields.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {
            filter: { type: 'string', description: 'Case-insensitive text matched against the method, path and description, e.g. "pins" or "DELETE /workspaces".' },
            schemas: { type: 'boolean', description: 'Include each route\'s query and body JSON Schema. Use with a filter; the unfiltered catalog is large.' },
        } },
    },
    {
        name: 'api_request',
        description: 'Call a REST route from api_route_list with your token. Prefer a named tool when one exists. Returns statusCode, headers and body (bodyBase64 for binary responses).',
        inputSchema: { type: 'object', additionalProperties: false, required: ['method', 'path'], properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string', description: 'Path as listed by api_route_list with its :parameters filled in and URL-encoded, e.g. /workspaces/universe/pins.' },
            query: { type: 'object', description: 'Query parameters. An array value repeats the parameter.' },
            body: { description: 'JSON request body.' },
            bodyBase64: { type: 'string', description: 'Raw request bytes instead of body, e.g. a multipart upload. Set content-type (with boundary) in headers.' },
            headers: { type: 'object', additionalProperties: false, properties: Object.fromEntries(passHeaders.map(name => [name, { type: 'string' }])) },
        } },
    },
];

/**
 * Bridge the REST route registry to MCP. Routes that declare `config.mcp`
 * become named tools; every other route is reachable through api_request.
 * Calls re-enter HTTP auth, validation and ACLs.
 */
export function installMcp(app) {
    const tools = new Map();
    const catalog = [];
    const excluded = [];
    app.addHook('onRoute', function captureRoute(route) {
        if (!route.url.startsWith(`${prefix}/`) || route.url === endpoint) return;
        const methods = [route.method].flat().filter(method => method !== 'HEAD' && method !== 'OPTIONS');
        if (route.config?.mcp === false) {
            for (const method of methods) excluded.push({ method, match: pattern(route.url) });
            return;
        }
        const declarations = [route.config?.mcp ?? []].flat();
        if (declarations.length && methods.length > 1) throw new Error(`MCP tools on ${route.url} need a route with exactly one method`);
        for (const method of methods) {
            const entry = { method, url: route.url, match: pattern(route.url), description: route.schema?.description, tools: [], schema: route.schema, getSchema: id => this.getSchema(id) };
            catalog.push(entry);
            for (const declaration of declarations) {
                const built = buildTool({ method, url: route.url, schema: route.schema }, declaration, entry.getSchema, { alias: Boolean(this.mcpAlias) });
                const taken = tools.get(built.tool.name) || apiTools.find(tool => tool.name === built.tool.name);
                if (this.mcpAlias) {
                    if (!taken?.variants || taken.method !== method) throw new Error(`MCP alias ${method} ${route.url} must be mounted after the route that declares ${built.tool.name}`);
                    taken.variants.push(built);
                    const dropped = taken.pathArgs.filter(name => !built.pathArgs.includes(name));
                    taken.required = taken.required.filter(name => !dropped.includes(name));
                    taken.tool.inputSchema.required = taken.required;
                    continue;
                }
                if (taken) throw new Error(`MCP tool name ${built.tool.name} is declared twice: ${taken.method ? `${taken.method} ${taken.url}` : 'built in'} and ${method} ${route.url}`);
                tools.set(built.tool.name, { ...built, variants: [built] });
                entry.tools.push(built.tool.name);
            }
        }
    });

    const listing = () => [...apiTools, ...[...tools.values()].map(entry => entry.tool)].sort((a, b) => a.name.localeCompare(b.name));

    function listRoutes({ filter, schemas } = {}) {
        const needle = typeof filter === 'string' ? filter.toLowerCase() : '';
        return catalog
            .map(entry => ({ entry, path: entry.url.slice(prefix.length) }))
            .filter(({ entry, path }) => !needle || `${entry.method} ${path} ${entry.description || ''} ${entry.tools.join(' ')}`.toLowerCase().includes(needle))
            .sort((a, b) => a.path.localeCompare(b.path) || a.entry.method.localeCompare(b.entry.method))
            .map(({ entry, path }) => {
                const row = { method: entry.method, path, ...(entry.tools.length ? { tools: entry.tools } : {}), ...(entry.description ? { description: entry.description } : {}) };
                if (!schemas) return row;
                const bundled = toolSchemas(entry.schema, entry.getSchema);
                return { ...row, ...(entry.schema?.querystring ? { query: bundled.query } : {}), ...(entry.schema?.body ? { body: bundled.body } : {}), ...(Object.keys(bundled.$defs).length ? { $defs: bundled.$defs } : {}) };
            });
    }

    function apiRequest(args) {
        const { method, path, query, body, bodyBase64, headers } = args;
        if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path)) return { error: 'path must start with / and carry no query string; pass query separately' };
        if (query != null && (typeof query !== 'object' || Array.isArray(query))) return { error: 'query must be an object' };
        if (bodyBase64 !== undefined && typeof bodyBase64 !== 'string') return { error: 'bodyBase64 must be a string' };
        if (body !== undefined && bodyBase64 !== undefined) return { error: 'Supply body or bodyBase64, not both' };
        const url = `${prefix}${path}`;
        const matches = entry => entry.method === method && entry.match.test(url);
        const route = excluded.some(matches) ? null : catalog.find(matches);
        if (!route) return { error: `No such route: ${method} ${path}. Find routes with api_route_list` };
        // REST validation drops query parameters it does not know, which would widen a selection silently.
        const known = route.schema?.querystring?.properties;
        const unknown = known ? Object.keys(query || {}).filter(key => !Object.hasOwn(known, key)) : [];
        if (unknown.length) return { error: `Unknown query parameter ${unknown.join(', ')}. ${method} ${path} takes: ${Object.keys(known).join(', ')}` };
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(query || {})) {
            for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item));
        }
        return { method, url: `${url}${search.size ? `?${search}` : ''}`, body: bodyBase64 === undefined ? body : Buffer.from(bodyBase64, 'base64'),
            headers: Object.fromEntries(passHeaders.filter(name => typeof headers?.[name] === 'string').map(name => [name, headers[name]])), withHeaders: true };
    }

    async function dispatch(message, authorization) {
        const { id, method, params } = message;
        const result = value => complete(id, value);
        if (method === 'server/discover') return result({ supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
        if (method === 'tools/list') {
            if (params.cursor !== undefined) return rpcError(id, -32602, 'Invalid cursor: the tool list is not paginated');
            return result({ tools: listing(), ttlMs: 0, cacheScope: 'private' });
        }
        if (method !== 'tools/call') return rpcError(id, -32601, `Method not found; supported MCP version: ${PROTOCOL_VERSION}`);
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'Invalid arguments: an object is required');
        const structured = (payload, isError = false) => result({ structuredContent: payload, isError, content: [{ type: 'text', text: JSON.stringify(payload) }] });
        if (params.name === 'api_route_list') return structured({ routes: listRoutes(args) });
        const entry = tools.get(params.name);
        if (!entry && params.name !== 'api_request') return rpcError(id, -32602, 'Unknown tool');
        const request = entry ? toolRequest(entry, args) : apiRequest(args);
        if (request.error) return result({ isError: true, content: [{ type: 'text', text: request.error }] });
        try {
            const response = await app.inject({ method: request.method, url: request.url, headers: { authorization, ...request.headers }, payload: request.body });
            const type = String(response.headers['content-type'] || '');
            const payload = { statusCode: response.statusCode, ...(request.withHeaders ? { headers: response.headers } : {}),
                ...(type.includes('json') ? { body: response.json() } : type.startsWith('text/') ? { body: response.body } : { contentType: type, bodyBase64: response.rawPayload.toString('base64') }) };
            return structured(payload, response.statusCode >= 400);
        } catch {
            return result({ isError: true, content: [{ type: 'text', text: 'Request execution failed' }] });
        }
    }

    app.register(async instance => {
        instance.setErrorHandler((error, request, reply) => {
            const parseError = (error instanceof SyntaxError && error.statusCode === 400) || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY';
            return reply.code(error.statusCode || 500).send(rpcError(request.body?.id, parseError ? -32700 : -32603, parseError ? 'Parse error' : 'MCP request failed'));
        });
        instance.addHook('onRequest', async (request, reply) => {
            // Headless clients omit Origin. Browser callers must be same-origin.
            if (request.headers.origin && request.headers.origin !== `${request.protocol}://${request.headers.host}`) {
                return reply.code(403).send({ message: 'Invalid MCP origin' });
            }
            if (!request.headers.authorization?.startsWith('Bearer ')) return reply.code(401).send({ message: 'Bearer token required' });
            await app.authenticate(request, reply);
        });
        instance.post(endpoint, async (request, reply) => {
            const failure = validateRequest(request.body, request.headers);
            if (failure) return reply.code(failure.status).send(failure.body);
            const response = await dispatch(request.body, request.headers.authorization);
            return reply.code(response.error?.code === -32601 ? 404 : response.error ? 400 : 200).send(response);
        });
        instance.route({ method: ['GET', 'DELETE'], url: endpoint, handler: async (_request, reply) => reply.code(405).header('Allow', 'POST').send() });
    });

    return {
        attachSocketIo(io) {
            const namespace = io.of('/mcp');
            namespace.use(async (socket, next) => {
                const origin = socket.handshake.headers.origin;
                if (origin) {
                    try {
                        if (new URL(origin).host !== socket.handshake.headers.host) return next(new Error('Invalid MCP origin'));
                    } catch {
                        return next(new Error('Invalid MCP origin'));
                    }
                }
                const authorization = `Bearer ${socket.handshake.auth?.token || ''}`;
                const probe = { jsonrpc: '2.0', id: 0, method: 'server/discover', params: { _meta: requestMetadata() } };
                const response = await app.inject({ method: 'POST', url: endpoint, headers: { ...requestHeaders(probe), authorization }, payload: probe });
                if (response.statusCode !== 200) return next(new Error('Authentication failed'));
                next();
            });
            namespace.on('connection', socket => {
                socket.on('mcp', async (message, ack) => {
                    // Authenticate each message, including after token revocation.
                    const response = await app.inject({ method: 'POST', url: endpoint,
                        headers: { ...requestHeaders(message), authorization: `Bearer ${socket.handshake.auth?.token || ''}` }, payload: message });
                    const data = response.body ? response.json() : null;
                    if (typeof ack === 'function') ack(data);
                    else if (data) socket.emit('mcp', data);
                });
            });
        },
    };
}
