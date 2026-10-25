/** A reply thread is a bounded connected component of the replies-to graph.
 * Drain each edge iterator before awaiting: synapsd iterators hold read txns.
 */
export async function readMessageThread(id, { edges, getMany, allowedIds = null, limit = 200 }) {
    const seen = new Set([id]);
    const queue = [id];
    const parents = new Map();
    let truncated = false;
    const relate = (child, parent) => {
        if (!parents.has(child)) parents.set(child, new Set());
        parents.get(child).add(parent);
    };
    for (let position = 0; position < queue.length; position++) {
        const current = queue[position];
        for (const axis of ['outgoing', 'incoming']) {
            for (const value of edges[axis](current, 'replies-to')) {
                const other = Number(value);
                if (!Number.isSafeInteger(other) || other < 1) continue;
                if (!seen.has(other)) {
                    if (seen.size >= limit) { truncated = true; break; }
                    seen.add(other); queue.push(other);
                }
                relate(axis === 'outgoing' ? current : other, axis === 'outgoing' ? other : current);
            }
        }
    }
    const ids = [...seen];
    const permitted = new Set(allowedIds ? await allowedIds(ids) : ids);
    if (!permitted.has(id)) throw Object.assign(new Error('Message is outside your scope'), { statusCode: 403 });
    const result = await getMany(ids.filter((value) => permitted.has(value)));
    const documents = (Array.isArray(result) ? result : result?.data || []).filter((doc) => doc &&
        (doc.schema === 'data/schema/message' || doc.schema === 'data/schema/message/email'));
    const present = new Set(documents.map((doc) => Number(doc.id)));
    const visibleParents = Object.fromEntries(documents.map((doc) => [doc.id,
        [...(parents.get(Number(doc.id)) || [])].filter((parent) => present.has(parent)),
    ]));
    const timestamp = (doc) => Date.parse(doc.data?.timestamp || doc.data?.date || '') || 0;
    documents.sort((a, b) => timestamp(a) - timestamp(b) || Number(a.id) - Number(b.id));
    return { documentId: id, documents, parents: visibleParents, truncated,
        rootIds: documents.filter((doc) => !visibleParents[doc.id].length).map((doc) => Number(doc.id)) };
}
