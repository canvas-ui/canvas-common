import { defineTool } from '@earendil-works/pi-coding-agent';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: undefined });

/** One tool catalog, with an explicit connection selector and no token unions. */
export async function connectionTools(env, createScopedTools) {
    const connections = JSON.parse(env.CANVAS_CONNECTIONS || '[]');
    if (!Array.isArray(connections) || !connections.length) throw new Error('CANVAS_CONNECTIONS must contain at least one connection');
    const ids = new Set();
    for (const connection of connections) {
        if (!connection.id || (!connection.unavailable && (!connection.token || !connection.workspaceId)) || ids.has(connection.id)) throw new Error('Connections require unique IDs, tokens and workspace IDs');
        ids.add(connection.id);
    }
    const entries = await Promise.all(connections.map(async connection => {
        if (connection.unavailable) return { connection, tools: [], error: connection.unavailable };
        try {
            const tools = await createScopedTools({
                CANVAS_URL: env.CANVAS_URL, CANVAS_AGENT_ID: env.CANVAS_AGENT_ID,
                CANVAS_TOKEN: connection.token, CANVAS_WORKSPACE: connection.workspaceId,
                CANVAS_WORKSPACE_NAME: connection.workspaceName, CANVAS_BASE_PATH: connection.basePath,
                CANVAS_BINDING_TYPE: connection.bindingType, CANVAS_CONTEXT_ID: connection.contextId,
                CANVAS_CONTEXT_URL: connection.contextUrl, CANVAS_PERMISSIONS: JSON.stringify(connection.permissions),
            });
            return { connection, tools };
        } catch {
            return { connection, tools: [], error: 'Connection unavailable; check access and restart the agent to retry discovery' };
        }
    }));
    const groups = new Map();
    for (const { connection, tools } of entries) for (const tool of tools) {
        if (!groups.has(tool.name)) groups.set(tool.name, []);
        groups.get(tool.name).push({ connection, tool });
    }
    if (!groups.has('canvas_context')) groups.set('canvas_context', []);
    return [...groups].map(([name, variants]) => {
        const overview = name === 'canvas_context';
        const properties = Object.assign({}, ...variants.map(({ tool }) => tool.parameters.properties));
        if (variants.length) properties.connection = { type: 'string', enum: variants.map(({ connection }) => connection.id), description: 'Named access connection. Use canvas_context without arguments to list connections and their scopes.' };
        const cases = variants.map(({ connection, tool }) => ({ ...tool.parameters,
            properties: { ...tool.parameters.properties, connection: { const: connection.id, type: 'string' } },
            required: [...(tool.parameters.required || []), 'connection'], additionalProperties: false,
        }));
        if (overview) cases.push({ type: 'object', properties: {}, additionalProperties: false });
        const required = [...new Set(['connection', ...(variants[0]?.tool.parameters.required || [])
            .filter(key => variants.every(({ tool }) => tool.parameters.required?.includes(key)))])];
        return defineTool({
            name, label: variants[0]?.tool.label || 'Canvas connections',
            description: (overview ? 'List named connections, or inspect one using connection. ' : 'Choose the connection whose scope and permissions fit this operation. ')
                + (variants[0]?.tool.description || ''),
            parameters: { type: 'object', properties, ...(overview ? {} : { required }), oneOf: cases, additionalProperties: false },
            async execute(id, params, signal) {
                if (overview && !params.connection) return result({ connections: entries.map(({ connection, tools, error }) => ({
                    id: connection.id, label: connection.label, workspace: connection.workspaceId, workspaceName: connection.workspaceName,
                    basePath: connection.basePath, contextId: connection.contextId, contextUrl: connection.contextUrl,
                    permissions: connection.permissions, available: !error, ...(error ? { error } : {}), tools: tools.map(tool => tool.name),
                })), note: 'Each connection is independent. Paths are relative to the selected connection. Broader grants are not restricted by narrower, overlapping grants.' });
                const selected = variants.find(({ connection }) => connection.id === params.connection);
                if (!selected) return result({ error: 'Choose a connection that permits this tool', connections: variants.map(({ connection }) => connection.id) });
                const { connection: _connection, ...args } = params;
                return selected.tool.execute(id, args, signal);
            },
        });
    });
}
