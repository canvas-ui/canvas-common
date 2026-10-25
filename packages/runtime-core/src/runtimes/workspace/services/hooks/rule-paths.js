const QUALIFIERS = { ctx: 'context', dir: 'directory', context: 'context', directory: 'directory' };
const PATH_KEYS = ['path', 'pathExact', 'eventPathExact'];

/** Only tree selectors are transformed; storage folders, prose and templates stay intact. */
export function mapRulePaths(rule, transform) {
    const map = value => Array.isArray(value) ? value.map(map) : typeof value === 'string' ? transform(value) : value;
    const when = { ...rule.when };
    for (const key of PATH_KEYS) if (when[key] !== undefined) when[key] = map(when[key]);
    const then = (rule.then || []).map(action => {
        const next = { ...action };
        if (['link', 'unlink'].includes(action.action)) {
            for (const key of ['paths', 'path']) if (next[key] !== undefined) next[key] = map(next[key]);
        }
        if (action.output) {
            next.output = { ...action.output };
            if (action.output.note?.path) next.output.note = { ...action.output.note, path: map(action.output.note.path) };
            if (action.output.file?.insert) next.output.file = { ...action.output.file, insert: map(action.output.file.insert) };
        }
        return next;
    });
    return { ...rule, when, then };
}

export function rulePathMapper(workspace, mode) {
    const indexes = new Map();
    return value => {
        const match = /^(ctx|dir|context|directory):(.+)$/.exec(value.startsWith('/') ? `ctx:${value}` : value);
        if (!match) return value;
        const [, qualifier, selector] = match;
        if (mode === 'decode' && !selector.startsWith('#')) return value;
        const tree = QUALIFIERS[qualifier];
        if (!indexes.has(tree)) {
            const byId = new Map(), byPath = new Map();
            const visit = (node, path, ancestors = []) => {
                const ids = [...ancestors, node.id];
                const reference = tree === 'context' ? ids.map(id => `#${id}`).join('/') : `#${node.id}`;
                byId.set(reference, path);
                byPath.set(path, reference);
                for (const child of node.children || []) visit(child, `${path === '/' ? '' : path}/${child.name}`, ids);
            };
            visit(workspace.getTree(tree).buildJsonTree(), '/');
            indexes.set(tree, { byId, byPath });
        }
        const { byId, byPath } = indexes.get(tree);
        if (selector.startsWith('#')) {
            if (mode === 'encode') return value;
            const segments = selector.split('/');
            const suffix = [];
            while (segments.length && !segments.at(-1).startsWith('#')) suffix.unshift(segments.pop());
            const path = byId.get(segments.join('/'));
            if (path === undefined) return value;
            return `${qualifier}:${suffix.length ? `${path === '/' ? '' : path}/${suffix.map(decodeURIComponent).join('/')}` : path}`;
        }
        if (mode === 'decode' || !selector.startsWith('/')) return value;
        // A link may create a new child; anchor it to its deepest existing parent.
        let path = selector.replace(/\/+$/, '') || '/';
        const suffix = [];
        while (!byPath.has(path) && path !== '/') {
            suffix.unshift(path.slice(path.lastIndexOf('/') + 1));
            path = path.slice(0, path.lastIndexOf('/')) || '/';
        }
        if (!byPath.has(path)) throw new Error(`Tree folder not found: ${value}`);
        return `${qualifier}:${byPath.get(path)}${suffix.length ? `/${suffix.map(encodeURIComponent).join('/')}` : ''}`;
    };
}

export function transformRuleFile(content, workspace, mode) {
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : parsed?.rules;
    if (!Array.isArray(list)) throw new Error('Rule files must contain a rules array');
    const transform = rulePathMapper(workspace, mode);
    const rules = list.map(rule => mapRulePaths(rule, transform));
    return `${JSON.stringify(Array.isArray(parsed) ? rules : { ...parsed, rules }, null, 2)}\n`;
}

export const isRuleFile = path => /^(?:(?:example-|disabled-|_)?rules\.json|rules\/[^/]+\.json)$/.test(path);
