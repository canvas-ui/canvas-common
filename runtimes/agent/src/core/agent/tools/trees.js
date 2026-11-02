import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

// Tools describe the REST contracts; authorization and tree behavior live in
// the workspace runtime and are shared with the web UI.
export function createTreeTools({ client, workspaceParams, resolveWorkspace, basePath, permissions, readPermissions, scopedPath, toolResult, toolError }) {
    const wholeWorkspace = basePath === '/';
    const writable = permissions?.includes('write');
    const string = description => Type.String({ minLength: 1, description });
    const tree = { treeNameOrId: Type.Optional(string('Tree name or ID; omitted selects the default context tree. Discover with canvas_tree_list.')) };
    const path = { path: string('Path relative to your binding; / means its root.') };
    const recursive = { recursive: Type.Optional(Type.Boolean({ description: 'Include descendant paths; default false.' })) };
    const object = Type.Object({}, { additionalProperties: true });
    const presentation = {
        label: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
        color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        metadata: Type.Optional(object), querySpec: Type.Optional(object),
    };
    const treeType = Type.Union([Type.Literal('context'), Type.Literal('directory')]);
    const layer = { layerId: string('Layer ID from canvas_layer_list or canvas_layer_get.') };
    const treesUrl = p => `/workspaces/${encodeURIComponent(resolveWorkspace(p))}/trees`;
    const treeUrl = p => p.treeNameOrId ? `${treesUrl(p)}/${encodeURIComponent(p.treeNameOrId)}`
        : `/workspaces/${encodeURIComponent(resolveWorkspace(p))}/tree`;
    const absolute = value => scopedPath(basePath, value);
    const pathUrl = p => `${treeUrl(p)}/path/${absolute(p.path).split('/').map(encodeURIComponent).join('/').replace(/^\//, '')}`;
    const layerUrl = p => `${treeUrl(p)}/layers/${encodeURIComponent(p.layerId)}`;
    const pick = (p, keys) => Object.fromEntries(keys.filter(key => p[key] !== undefined).map(key => [key, p[key]]));
    const tools = [];
    function add(name, description, parameters, method, url, options = () => ({}), workspaceOnly = false) {
        const write = method !== 'GET';
        if ((write && !writable) || (workspaceOnly && !wholeWorkspace)) return;
        tools.push(defineTool({
            name: `canvas_${name}`, label: `Canvas ${name.replaceAll('_', ' ')}`,
            description, parameters: Type.Object({ ...workspaceParams, ...parameters }, { additionalProperties: false }),
            async execute(_id, params, signal) {
                try {
                    if (write && !(await readPermissions(resolveWorkspace(params), signal))?.includes('write')) {
                        throw new Error('Write permission is required for this operation');
                    }
                    return toolResult(await client.request(method, url(params), { ...options(params), signal }));
                } catch (error) { return toolError(error); }
            },
        }));
    }
    add('tree_list', 'List accessible trees and their types. Context paths AND shared node bitmaps; directory trees have exact folder membership and recursive descendant queries.',
        { type: Type.Optional(treeType) }, 'GET', treesUrl, p => ({ query: pick(p, ['type']) }));
    add('tree_get', 'Get the tree structure and node metadata. Subtree bindings see only their path spine and descendants.', tree, 'GET', treeUrl);
    add('tree_paths', 'List accessible workspace-absolute paths in a tree. Strip the binding prefix before passing a path to path-management tools.', tree, 'GET', p => `${treeUrl(p)}/paths`);
    add('tree_create', 'Create a named context or directory tree. Requires a workspace-wide binding.', { name: string('New tree name'), type: treeType }, 'POST', treesUrl,
        p => ({ body: pick(p, ['name', 'type']) }), true);
    add('tree_rename', 'Rename a tree. Reserved/protected trees cannot be renamed.', { treeNameOrId: string('Tree name or ID'), name: string('New name') }, 'PATCH', treeUrl, p => ({ body: { name: p.name } }), true);
    add('tree_remove', 'Delete a tree and its organization. Reserved/protected trees cannot be deleted. This does not delete document content.', { treeNameOrId: string('Tree name or ID') }, 'DELETE', treeUrl, undefined, true);
    add('path_get', 'Get one folder/layer node by path.', { ...tree, ...path }, 'GET', pathUrl);
    add('path_insert', 'Create a folder path including missing ancestors. Context trees reuse named layer bitmaps; directory trees create directory nodes. Existing paths are unchanged. Backend mirror folders must be created through storage operations.',
        { ...tree, ...path, type: Type.Optional(Type.Union(['context', 'directory', 'canvas'].map(value => Type.Literal(value)))),
            autoCreateLayers: Type.Optional(Type.Boolean({ description: 'Context trees: create missing layers (default true).' })),
            querySpec: Type.Optional(object), metadata: Type.Optional(object) }, 'PUT', pathUrl,
        p => ({ body: pick(p, ['type', 'autoCreateLayers', 'querySpec', 'metadata']) }));
    add('path_update', 'Update node presentation, metadata or a saved canvas querySpec. Context-layer changes affect every path sharing the layer; requires a workspace-wide binding.',
        { ...tree, ...path, ...presentation }, 'PATCH', pathUrl, p => ({ body: pick(p, Object.keys(presentation)) }), true);
    const target = { ...tree, ...path, to: string('Destination relative to the binding. In context trees, an existing path is the destination parent; a new leaf on move renames the shared layer. Directory targets may be a parent or a full new path.'),
        targetTreeNameOrId: Type.Optional(string('Destination tree; omitted means the source tree. Cross-tree operations require workspace-wide access.')), ...recursive };
    const destination = p => ({ ...pick(p, ['recursive', 'mergeDown']), to: absolute(p.to),
        ...(p.targetTreeNameOrId ? { targetTreeNameOrTreeId: p.targetTreeNameOrId } : {}) });
    add('path_move', 'Move a path. Context moves preserve shared bitmaps unless mergeDown is requested. Scoped agents must use an existing destination parent inside their binding and cannot rename shared layers or merge bitmaps. Backend mirror moves use storage.',
        { ...target, mergeDown: Type.Optional(Type.Boolean({ description: 'Context only: OR the moved layer into new ancestors. Affects shared bitmaps; requires workspace-wide access.' })) }, 'PATCH', pathUrl, p => ({ body: destination(p) }));
    add('path_copy', 'Copy tree structure/membership without duplicating document content or copying backend bytes. Context copies share layers and require an existing destination parent. Cross-tree copies use the REST membership workflow.', target, 'POST', pathUrl, p => ({ body: destination(p) }));
    add('path_remove', 'Remove a path without deleting documents or physical files. With recursive false, context children are promoted to the parent; with true, remove the subtree. Cannot remove a scoped binding root.',
        { ...tree, ...path, ...recursive }, 'DELETE', pathUrl, p => ({ query: pick(p, ['recursive']) }));
    add('layer_list', 'List shared layers in a context tree. Layer-wide access requires a workspace-wide binding.', tree, 'GET', p => `${treeUrl(p)}/layers`, undefined, true);
    add('layer_get', 'Get a shared context layer by ID. Layer-wide access requires a workspace-wide binding.', { ...tree, ...layer }, 'GET', layerUrl, undefined, true);
    add('layer_update', 'Update shared layer presentation, metadata or saved canvas querySpec. Affects every occurrence of the layer.',
        { ...tree, ...layer, ...presentation }, 'PATCH', layerUrl, p => ({ body: pick(p, Object.keys(presentation)) }), true);
    add('layer_rename', 'Rename a shared layer at every path where it occurs.', { ...tree, ...layer, name: string('New layer name') }, 'PATCH', layerUrl, p => ({ body: { name: p.name } }), true);
    add('layer_remove', 'Delete a shared layer from the context tree, affecting every path using it.', { ...tree, ...layer }, 'DELETE', layerUrl, undefined, true);
    for (const action of ['lock', 'unlock']) add(`layer_${action}`, `${action === 'lock' ? 'Lock' : 'Release your lock on'} a shared context layer. Other holders retain their locks.`,
        { ...tree, ...layer, lockBy: string('Stable lock owner identifier; unlock must use the same value.') }, 'POST', p => `${layerUrl(p)}/${action}`, p => ({ body: { lockBy: p.lockBy } }), true);
    for (const action of ['merge', 'subtract']) {
        add(`layer_${action}`, `${action === 'merge' ? 'OR' : 'Subtract'} the source layer bitmap ${action === 'merge' ? 'into' : 'from'} target layers. Affects documents at every path using these layers.`,
            { ...tree, ...layer, targetLayers: Type.Array(string('Target layer ID'), { minItems: 1 }) }, 'POST', p => `${treeUrl(p)}/layers/${action}`, p => ({ body: pick(p, ['layerId', 'targetLayers']) }), true);
        add(`path_${action}_down`, `${action === 'merge' ? 'OR' : 'Subtract'} the path leaf bitmap ${action === 'merge' ? 'into' : 'from'} its ancestors. These shared bitmap changes affect other paths too.`,
            { ...tree, ...path }, 'POST', p => `${treeUrl(p)}/paths/${action}-down`, p => ({ body: { path: absolute(p.path) } }), true);
    }
    return tools;
}
