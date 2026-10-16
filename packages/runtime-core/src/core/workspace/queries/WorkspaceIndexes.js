import { parseDocumentIdArray } from '../../../utils/documentId.js';

export default class WorkspaceIndexes {
    #runtime;
    constructor(_workspace, runtime) { this.#runtime = runtime; }

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

    async listBitmaps(...args) {
        return this.#runtime.getActiveDb().listBitmaps(...args);
    }

    async getBitmap(...args) {
        return this.#runtime.getActiveDb().getBitmap(...args);
    }

    async deleteBitmap(...args) {
        return this.#runtime.getActiveDb().deleteBitmap(...args);
    }

    async getBitmapRawBuffer(...args) {
        return this.#runtime.getActiveDb().getBitmapRawBuffer(...args);
    }

    clearDatabaseSync() {
        return this.#runtime.getActiveDb().clearSync();
    }
}
