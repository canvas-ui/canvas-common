import { toolSchemas } from './schema.js';

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The object branch of a body schema: the schema itself, or the single object member of a union. */
function objectSchema(schema) {
    if (!schema) return null;
    if (schema.properties) return schema;
    const branches = (schema.oneOf || schema.anyOf || []).filter(branch => branch?.properties);
    return branches.length === 1 ? branches[0] : null;
}

/**
 * Build one MCP tool from a route and one `config.mcp` declaration.
 *
 * Arguments are flat: path parameters, query parameters and body fields all sit
 * at the top level under the names the route schema gives them, unless
 * `declaration.args` renames one. `args`, `only` and `required` refer to a
 * path parameter as it is written in the URL (`:id`, `*`) and to query and
 * body fields by name. `source` records where each argument goes back to.
 */
export function buildTool(route, declaration, getSchema, { alias = false } = {}) {
    const where = `${route.method} ${route.url}`;
    const fail = message => { throw new Error(`MCP tool ${declaration.name || '(unnamed)'} on ${where}: ${message}`); };
    if (typeof declaration.name !== 'string' || !NAME.test(declaration.name) || declaration.name.length > 64) fail('name must be lower snake_case <noun>_<verb>, at most 64 characters');
    const description = declaration.description || route.schema?.description;
    if (!description) fail('a description is required');

    const schemas = toolSchemas(route.schema, getSchema);
    const spec = key => {
        const entry = declaration.args?.[key];
        return typeof entry === 'string' ? { name: entry } : entry || {};
    };
    const properties = {};
    const required = [];
    const source = {};
    const declared = new Set();
    const add = (ref, key, from, schema, isRequired) => {
        const { name = key, description: text, type } = spec(ref);
        if (name === '*') fail('the wildcard path parameter needs an argument name in args');
        if (source[name]) fail(`argument "${name}" is declared by both ${source[name].from} and ${from}; rename one in args`);
        properties[name] = { ...schema, ...(type ? { type } : {}), ...(text ? { description: text } : {}) };
        source[name] = { from, key };
        declared.add(ref);
        if (isRequired) required.push(name);
    };
    const exposed = key => !declaration.only || declaration.only.includes(key);
    const demanded = (schema, key) => Boolean(schema.required?.includes(key) || declaration.required?.includes(key));

    const pathParams = [...route.url.matchAll(/:(\w+)|\*/g)].map(match => match[1] || '*');
    for (const key of pathParams) add(key === '*' ? key : `:${key}`, key, 'path', { type: 'string' }, true);

    const query = route.schema?.querystring ? schemas.$defs.query : null;
    for (const [key, schema] of Object.entries(query?.properties || {})) {
        if (exposed(key)) add(key, key, 'query', schema, demanded(query, key));
    }

    let wholeBody = null;
    if (declaration.body) {
        if (!route.schema?.body) fail('body names an argument but the route has no body schema');
        wholeBody = declaration.body;
        add(declaration.body, declaration.body, 'body', schemas.$defs.body, true);
        source[declaration.body].whole = true;
    } else if (route.schema?.body) {
        const body = objectSchema(schemas.$defs.body);
        if (!body) fail('the body schema is not an object; name the argument that carries it with body');
        for (const [key, schema] of Object.entries(body.properties)) {
            if (exposed(key)) add(key, key, 'body', schema, demanded(body, key));
        }
    }
    for (const key of [...(declaration.only || []), ...(declaration.required || []), ...Object.keys(declaration.args || {})]) {
        // An alias mount serves the same declaration from a URL with fewer path parameters.
        if (!declared.has(key) && !(alias && /^[:*]/.test(key))) fail(`"${key}" is not a parameter of this route`);
    }

    const inputSchema = { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
    // Definitions travel only with tools whose arguments reference them.
    if (JSON.stringify(properties).includes('"$ref"')) inputSchema.$defs = schemas.$defs;

    return {
        method: route.method,
        url: route.url,
        source,
        required,
        pathArgs: Object.entries(source).filter(([, entry]) => entry.from === 'path').map(([name]) => name),
        sendsBody: Boolean(route.schema?.body) && BODY_METHODS.has(route.method),
        wholeBody,
        tool: { name: declaration.name, description, inputSchema },
    };
}

/**
 * Turn flat tool arguments into the REST request. `tool` is the declaring
 * route with its `variants` (itself first, then alias mounts); the first
 * variant whose path arguments are all given serves the call. Returns
 * `{ error }` for arguments the tool does not take.
 */
export function toolRequest(tool, args) {
    const unknown = Object.keys(args).filter(name => !tool.source[name]);
    if (unknown.length) return { error: `Unknown argument ${unknown.join(', ')}. ${tool.tool.name} takes: ${Object.keys(tool.source).join(', ') || 'no arguments'}` };
    const missing = tool.required.filter(name => args[name] === undefined || args[name] === null);
    if (missing.length) return { error: `Missing required argument ${missing.join(', ')}` };
    const entry = tool.variants.find(variant => variant.pathArgs.every(name => args[name] !== undefined && args[name] !== null));

    const path = {};
    const query = new URLSearchParams();
    let body = entry.sendsBody && !entry.wholeBody ? {} : undefined;
    for (const [name, { from, key, whole }] of Object.entries(entry.source)) {
        const value = args[name];
        if (value === undefined) continue;
        if (from === 'path') {
            if (typeof value !== 'string' && typeof value !== 'number') return { error: `Argument ${name} must be a string or number` };
            path[key] = String(value);
        } else if (from === 'query') {
            for (const item of Array.isArray(value) ? value : [value]) query.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
        } else if (whole) body = value;
        else body[key] = value;
    }
    // Ordinary parameters are single segments. A wildcard keeps its separators.
    const url = entry.url.replace(/:(\w+)|\*/g, (match, key) => key
        ? encodeURIComponent(path[key])
        : path['*'].replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'));
    return { method: entry.method, url: `${url}${query.size ? `?${query}` : ''}`, body };
}
