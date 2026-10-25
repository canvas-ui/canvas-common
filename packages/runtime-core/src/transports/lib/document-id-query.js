// Inline IDs are constraints, AND-ed with text, relation filters and other IDs.
export function parseDocumentIdQuery(query) {
    const ids = [];
    const text = String(query).replace(/"[^"]*"|(^|\s)@id:([^\s]*)/g, (match, lead, value) => {
        if (value === undefined) return match;
        const bare = value.replace(/^#/, '');
        const id = Number(bare);
        if (!/^\d+$/.test(bare) || !Number.isInteger(id) || id <= 0 || id > 0xffffffff) {
            throw new Error(`@id:${value} must contain a positive integer document ID (maximum 4294967295)`);
        }
        ids.push(id);
        return lead;
    }).trim();
    return { text, ids };
}
