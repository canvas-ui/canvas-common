import { parseDocumentIdArray } from '../../../utils/documentId.js';

export default class WorkspaceIndexes {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    async getDocumentsByIdArray(ids, options = { parse: true }) {
        return await this.#runtime.getActiveDb().getDocumentsByIdArray(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    /** Datasets: path-independent ingest provenance (data/dataset/<name>). */
    async listDatasets() {
        return await this.#runtime.getActiveDb().listDatasets();
    }

    /**
     * Drop a dataset (its documents too unless dropDocuments:false). This is the
     * ONLY sanctioned way to remove a data/dataset/* bitmap — deleteBitmap
     * refuses the prefix.
     */
    async deleteDataset(name, { dropDocuments = true } = {}) {
        return await this.#runtime.getActiveDb().deleteDataset(name, { dropDocuments });
    }

    async listBitmaps(prefix = '', { includeData = false, includeInternal = false } = {}) {
        const keys = await this.#runtime.getActiveDb().bitmapIndex.listBitmaps(prefix, { includeInternal });
        const bitmaps = await Promise.all(keys.map(async (key) => this.#workspace.getBitmap(key, { includeData })));
        return bitmaps.filter(Boolean);
    }

    async getBitmap(key, { includeData = false } = {}) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.#runtime.getActiveDb().bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const out = {
            key: bitmap.key,
            size: bitmap.size,
            isEmpty: bitmap.isEmpty,
            min: bitmap.isEmpty ? null : bitmap.minimum(),
            max: bitmap.isEmpty ? null : bitmap.maximum(),
        };

        if (includeData) out.ids = bitmap.toArray();
        return out;
    }

    async deleteBitmap(key) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');
        const normalized = key.replace(/^\/+|\/+$/g, '');
        if (normalized.startsWith('data/') || normalized === 'data') {
            throw new Error(`Refusing to delete bitmap "${key}": data/* bitmaps are protected (managed by document lifecycle).`);
        }
        // internal/* are engine-managed (gc, timeline, lance/fts, lance/vectors).
        // Dropping them corrupts state or forces silent re-index — never via API.
        if (normalized.startsWith('internal/') || normalized === 'internal') {
            throw new Error(`Refusing to delete bitmap "${key}": internal/* bitmaps are protected (engine-managed).`);
        }
        // NOTE: the old rel/* guard is gone with the bitmaps it protected —
        // typed doc<->doc edges live in the dupsort edge plane (synapsd
        // indexes/edges/) since refactor-v3, and 'rel/' is no longer an allowed
        // bitmap prefix, so such a key cannot exist to be deleted.
        const db = this.#runtime.getActiveDb();
        const existing = await db.bitmapIndex.getBitmap(normalized, false);
        if (!existing) return false;
        await db.bitmapIndex.deleteBitmap(normalized);
        return true;
    }

    async getBitmapRawBuffer(key) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.#runtime.getActiveDb().bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const serialized = bitmap.serialize(true);
        return Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized);
    }

    clearDatabaseSync() {
        return this.#runtime.getActiveDb().clearSync();
    }
}
