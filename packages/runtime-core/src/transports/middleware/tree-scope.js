import path from 'node:path';

export function treeScopeBase(request) {
    const token = request.resourceToken;
    return token?.type === 'agent' && token.basePath && token.basePath !== '/'
        ? path.posix.normalize(token.basePath).replace(/\/$/, '') : null;
}

function deny(reply, message) {
    reply.code(403).send({ statusCode: 403, message });
    return false;
}

// Context bindings name a path in the default context tree, not a path in
// every tree. Layer-wide operations affect every occurrence of that bitmap.
export function authorizeTreeRequest(request, reply, workspace, tree) {
    const base = treeScopeBase(request);
    if (!base) return true;
    if (tree.id !== workspace.getTree().id) return deny(reply, 'Agent binding permits only the default context tree');
    const route = request.routeOptions.url;
    const isPath = /\/path(?:\/\*)?$/.test(route);
    if (!isPath) {
        if (request.method === 'GET' && !/\/(layers|subtree)(\/|$)/.test(route)) return true;
        return deny(reply, 'Tree-wide and shared-layer operations require a workspace-wide binding');
    }
    const normalize = value => path.posix.normalize(`/${String(value || '').replace(/^\/+/, '')}`).replace(/\/$/, '') || '/';
    const inside = value => value === base || value.startsWith(`${base}/`);
    const source = normalize(request.params['*']);
    if (!inside(source)) return deny(reply, `Tree path is outside the agent's bound scope (${base})`);
    request.params['*'] = source;
    if (request.method === 'GET' || request.method === 'PUT') return true;
    if (source === base) return deny(reply, 'Cannot change the binding root');
    const body = request.body || {};
    if (request.method === 'DELETE') {
        if (request.query?.purge || request.query?.destroy) return deny(reply, 'Storage destruction requires a workspace-wide binding');
        return true;
    }
    if (body.targetTreeNameOrTreeId && ![tree.id, tree.name].includes(body.targetTreeNameOrTreeId)) {
        return deny(reply, 'Cross-tree operations require a workspace-wide binding');
    }
    const target = normalize(body.to);
    if (!body.to || !inside(target)) return deny(reply, 'Destination must be inside the binding');
    // A context rename edits the shared layer everywhere. Moving underneath
    // an existing, different parent only changes the scoped tree structure.
    if (body.name || body.mergeDown || Object.keys(body).some(key => !['to', 'recursive', 'mergeDown', 'targetTreeNameOrTreeId'].includes(key))) {
        return deny(reply, 'Shared-layer edits require a workspace-wide binding');
    }
    const destination = tree.getLayerForPath(target);
    if (!destination || destination.id === tree.getLayerForPath(source)?.id) {
        return deny(reply, 'Scoped moves and copies require an existing, different destination parent');
    }
    request.body.to = target;
    return true;
}

// Preserve the absolute path spine so clients can address nodes by workspace
// path, but disclose no ancestor metadata or siblings outside the binding.
export function scopedTreeView(root, base) {
    if (!base) return root;
    const segments = base.split('/').filter(Boolean);
    function prune(node, depth) {
        if (depth === segments.length) return node;
        const child = node?.children?.find(entry => entry.name === segments[depth]);
        return { name: node?.name || '/', children: child ? [prune(child, depth + 1)] : [] };
    }
    return prune(root, 0);
}
