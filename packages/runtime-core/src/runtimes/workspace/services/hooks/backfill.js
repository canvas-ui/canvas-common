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
