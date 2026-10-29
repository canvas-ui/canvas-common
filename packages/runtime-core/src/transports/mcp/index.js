import { createHash } from 'node:crypto';
import { toolSchemas } from './schema.js';
import { PROTOCOL_VERSION, rpcError, complete, requestMetadata, requestHeaders, validateRequest } from './protocol.js';

const endpoint = '/rest/v2/mcp';

/** Capture the actual route registry; calls re-enter HTTP auth, validation and ACLs. */
export function installMcp(app) {
    const routes = new Map();
    app.addHook('onRoute', function captureRoute(route) {
        if (!route.url.startsWith('/rest/v2/') || route.url === endpoint || route.config?.mcp === false) return;
        for (const method of [route.method].flat()) {
            if (method === 'HEAD' || method === 'OPTIONS') continue;
            const key = `${method} ${route.url}`;
            const name = `${method.toLowerCase()}_${route.url.replace('/rest/v2/', '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 90)}_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
            const params = [...route.url.matchAll(/:([\w]+)|\*/g)].map(match => match[1] || '*');
            const schemas = toolSchemas(route.schema, id => this.getSchema(id));
            routes.set(name, {
                method, url: route.url, params,
                tool: {
                    name,
                    description: `${key}${route.schema?.description ? ` — ${route.schema.description}` : ''}`,
                    inputSchema: {
                        type: 'object', additionalProperties: false,
                        $defs: schemas.$defs,
                        properties: {
                            params: { type: 'object', properties: Object.fromEntries(params.map(p => [p, { type: 'string' }])), required: params, additionalProperties: false },
                            query: route.schema?.querystring ? schemas.query : { type: 'object', additionalProperties: true },
                            body: schemas.body,
                            bodyBase64: { type: 'string', description: 'Raw request bytes, including multipart bodies. Set content-type with boundary in headers.' },
                            headers: { type: 'object', properties: Object.fromEntries(['content-type', 'accept', 'range', 'if-match', 'if-none-match'].map(h => [h, { type: 'string' }])), additionalProperties: false },
                        },
                        ...(params.length ? { required: ['params'] } : {}),
                    },
                },
            });
        }
    });

    async function dispatch(message, authorization) {
        const { id, method, params } = message;
        const result = value => complete(id, value);
        if (method === 'server/discover') return result({ supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
        if (method === 'tools/list') {
            if (params.cursor !== undefined) return rpcError(id, -32602, 'Invalid cursor: the tool list is not paginated');
            return result({ tools: [...routes.values()].map(route => route.tool).sort((a, b) => a.name.localeCompare(b.name)), ttlMs: 0, cacheScope: 'private' });
        }
        if (method !== 'tools/call') return rpcError(id, -32601, `Method not found; supported MCP version: ${PROTOCOL_VERSION}`);
        const route = routes.get(params.name);
        if (!route) return rpcError(id, -32602, 'Unknown tool');
        const args = params.arguments || {};
        if (typeof args !== 'object' || Array.isArray(args) || (args.query != null && (typeof args.query !== 'object' || Array.isArray(args.query)))) return rpcError(id, -32602, 'Invalid arguments');
        if (args.bodyBase64 !== undefined && typeof args.bodyBase64 !== 'string') return rpcError(id, -32602, 'Invalid bodyBase64');
        if (route.params.some(p => typeof args.params?.[p] !== 'string')) return rpcError(id, -32602, 'Missing path parameters');
        if (args.body !== undefined && args.bodyBase64 !== undefined) return rpcError(id, -32602, 'Supply body or bodyBase64');
        // Encode ordinary parameters as single segments. Wildcards preserve path separators.
        const url = route.url.replace(/:([\w]+)|\*/g, (match, p) => p
            ? encodeURIComponent(args.params[p])
            : args.params['*'].split('/').map(encodeURIComponent).join('/'));
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args.query || {})) {
            for (const entry of Array.isArray(value) ? value : [value]) query.append(key, String(entry));
        }
        const headers = { authorization };
        for (const key of ['content-type', 'accept', 'range', 'if-match', 'if-none-match']) {
            if (typeof args.headers?.[key] === 'string') headers[key] = args.headers[key];
        }
        try {
            const response = await app.inject({ method: route.method, url: `${url}${query.size ? `?${query}` : ''}`, headers,
                payload: args.bodyBase64 === undefined ? args.body : Buffer.from(args.bodyBase64, 'base64') });
            const type = String(response.headers['content-type'] || '');
            const payload = { statusCode: response.statusCode, headers: response.headers,
                ...(type.includes('json') ? { body: response.json() } : type.startsWith('text/') ? { body: response.body } : { bodyBase64: response.rawPayload.toString('base64') }) };
            return result({ structuredContent: payload, isError: response.statusCode >= 400, content: [{ type: 'text', text: JSON.stringify(payload) }] });
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
