import { Readable } from 'node:stream';
import GitRepositories, { parseGitLocation } from '../services/git/GitRepositories.js';

import { documentContentLocations } from '../documents/content-locations.js';

export default class WorkspaceContent {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    /**
     * Resolve a document's content by streaming/reading the first reachable
     * location (stored:// or file://{WORKSPACE_ROOT}/...).
     * @param {object} doc document with `locations[]`
     * @param {{stream?: boolean, url?: string}} [options]
     * @returns {Promise<{buffer?: Buffer, stream?: ReadStream, url: string}|null>}
     */
    async resolveDocument(doc, options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        const candidates = await documentContentLocations(doc, { url: options.url, getByChecksumString: this.#workspace.getByChecksumString.bind(this.#workspace) });
        let lastError = null;
        for (const loc of candidates) {
            if (!loc?.url) continue;
            try {
                const source = parseGitLocation(loc.url);
                if (source) {
                    const repositories = new GitRepositories(this.#workspace.gitPath);
                    const snapshot = doc.metadata?.git;
                    const buffer = snapshot?.repo === source.repo && snapshot.branch === source.branch && snapshot.path === source.file && snapshot.oid
                        ? await repositories.readBlob(source.repo, snapshot.oid)
                        : await repositories.read(source.repo, source.branch, source.file);
                    return { ...(options.stream ? { stream: Readable.from(buffer) } : { buffer }), url: loc.url };
                }
                const res = await this.#runtime.state.storedIndex.resolve(loc.url, options);
                const data = res?.data;
                if (data != null) return { ...(options.stream ? { stream: data } : { buffer: data }), url: loc.url, ranged: !!res.ranged };
            } catch (err) {
                // A location on another device (no proxy yet) is an expected
                // miss — fall through to the next location, and let an
                // all-miss resolve return null (a clean 404) rather than 500.
                if (err?.code === 'DEVICE_NOT_REACHABLE') {
                    this.#runtime.state.logger.debug({ workspaceId: this.#workspace.id, url: loc.url }, 'Location unreachable from this server (device not proxied)');
                    continue;
                }
                lastError = err;
            }
        }
        if (lastError) throw lastError;
        return null;
    }

    /**
     * Upload raw bytes into the workspace blob store (workspace:data). Returns a
     * `stored://workspace:data/<key>` location (content-addressed, deduped) that a
     * File document can then reference — making the bytes server-resident and
     * inferdable. This is the byte half of `canvas ws insert`.
     * @param {Buffer|import('stream').Readable} blob buffered or streamed (stored
     *   hashes a stream on the fly to a temp file — large blobs never buffer in RAM)
     * @returns {Promise<{url:string, key:string, checksum:string|null, size:number}>}
     */
    async persistBlob(blob) {
        if (!this.#runtime.state.storedIndex?.isRunning) { await this.#runtime.integrations.startStoredIndex(); }
        return await this.#runtime.state.storedIndex.persistBlob(blob);
    }

    async statBlobByChecksum(sha256) {
        if (!this.#runtime.state.storedIndex?.isRunning) { await this.#runtime.integrations.startStoredIndex(); }
        return await this.#runtime.state.storedIndex.statBlobByChecksum(sha256);
    }

    /**
     * Describe a document's locations for a Destroy picker (which can have bytes
     * removed vs reference-dropped only).
     */
    async describeDocumentLocations(doc) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.describeLocations(doc);
    }

    /**
     * Destroy a document's blobs (the "Destroy" op). `options.urls` targets
     * specific locations; default targets all. Removes the doc from the index
     * when no locations remain. See WorkspaceStoredIndex.destroy.
     */
    async destroyDocument(doc, options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.destroy(doc, options);
    }

    /**
     * On-demand cached thumbnail for an image or PDF document (see
     * WorkspaceStoredIndex.getThumbnail). Returns {buffer, mime} or null.
     */
    async getDocumentThumbnail(doc, size = 256) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.getThumbnail(doc, size);
    }
}
