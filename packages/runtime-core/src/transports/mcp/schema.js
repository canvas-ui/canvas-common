/** Bundle REST schemas under tool-local definitions, retaining typed properties
 * and rebasing local/shared refs so clients never need Fastify's schema registry. */
export function toolSchemas(routeSchema = {}, getSchema = () => undefined) {
    const definitions = {};
    const roots = new Map();
    function bundle(schema, name) {
        if (schema === undefined) return {};
        if (!roots.has(schema)) {
            roots.set(schema, name);
            definitions[name] = rewrite(schema, name);
        }
        return { $ref: `#/$defs/${roots.get(schema)}` };
    }
    function rewrite(value, root) {
        if (Array.isArray(value)) return value.map(entry => rewrite(entry, root));
        if (!value || typeof value !== 'object') return value;
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key === '$id') continue;
            if (key === '$ref') {
                if (entry.startsWith('#')) result[key] = `#/$defs/${root}${entry.slice(1)}`;
                else {
                    const [id, fragment = ''] = entry.split('#');
                    const referenced = getSchema(id);
                    if (!referenced) throw new Error(`MCP schema reference not registered: ${id}`);
                    const reference = bundle(referenced, `shared${roots.size}`);
                    result[key] = reference.$ref + fragment;
                }
            } else result[key] = rewrite(entry, root);
        }
        return result;
    }
    const query = bundle(routeSchema.querystring, 'query');
    const body = bundle(routeSchema.body, 'body');
    return { query, body, $defs: definitions };
}
