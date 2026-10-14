import { joinKey, transferFilename } from '../services/hook/key-utils.js';
import { isConnectorDriver } from '../services/connectors/index.js';

export default class WorkspaceTransfers {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    /**
     * Where this document's bytes live, as (backend, key) pairs — both address
     * forms resolved (`stored://` and device-scoped `file://` mounts). Hook
     * rules use it to pick a source backend and to derive a destination
     * filename from the current one.
     */
    async documentByteEndpoints(doc, { readable = false } = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return readable ? this.#runtime.state.storedIndex.readableLocationEndpoints(doc) : this.#runtime.state.storedIndex.locationEndpoints(doc);
    }

    /**
     * Copy or move ONE document's bytes to another backend, optionally renaming
     * on arrival. The single-document counterpart of
     * `transferDocumentsToBackends` — used by hook rules, which decide the
     * destination key per document (photos filed as YYYY/MM/…jpg, say).
     *
     * @param {object} doc Parsed document
     * @param {object} options
     * @param {string} options.to Target backend address
     * @param {'copy'|'move'} [options.mode='move']
     * @param {string} [options.key] Destination key (defaults to the source key)
     * @param {'error'|'rename'|'overwrite'} [options.onConflict='rename'] What to
     *   do when other content already holds that key. Defaults to renaming here
     *   (not erroring as in stored): templated names collide by construction —
     *   two photos taken in the same second — and losing one is not an option.
     * @param {{backend: string, key: string}} [options.from] Source location
     */
    async transferDocumentBytes(doc, { to, mode = 'move', key, onConflict = 'rename', from = null } = {}) {
        if (!doc?.id) throw new Error('A document is required');
        if (!to) throw new Error('A target backend is required');
        if (!this.#workspace.dataBackends[to]) throw new Error(`Unknown backend: ${to}`);
        if (this.#workspace.dataBackends[to].readOnly === true) throw new Error(`Backend "${to}" is read-only`);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();

        const res = await this.#runtime.state.storedIndex.transferDocument(doc, { to, mode, key, onConflict, from });
        if (!res?.ok) {
            const detail = res?.detail ? ` (${res.detail})` : '';
            const source = res?.source || (from ? `stored://${from.backend}/${from.key}` : null);
            throw new Error(`${mode} failed: ${res?.reason || 'unknown error'}${source ? ` (source: ${source}, target: ${to}/${key || ''})` : ''}${detail}`);
        }
        return res;
    }

    /**
     * Whether objects on this storage backend are addressed by a path a person
     * chose (directory share, drive) rather than a content hash (blob store).
     * Decides if a transfer carries a folder + filename.
     */
    backendKeepsPaths(backendName) {
        const config = this.#workspace.dataBackends[backendName];
        if (!config) return false;
        const driver = config.driver || 'file';
        return driver !== 'cacache' && driver !== 'imap' && !isConnectorDriver(driver);
    }

    /**
     * Batch backend op over documents — the surface behind the UI's
     * "Copy to / Move to / Delete from backend" actions.
     *
     * Addressed by document id rather than (backend, key) because that is what a
     * selection in the UI holds; each document's own source location is resolved
     * server-side, which also makes external mounts (file:// device locations)
     * work without the client knowing the address grammar.
     *
     * Partial success is normal — one document already living on the target must
     * not fail the other 49 — so every document reports its own outcome instead
     * of the batch throwing.
     *
     * @param {Array<number|string>} documentIds
     * @param {object} options
     * @param {string[]} options.to Target backend addresses
     * @param {'copy'|'move'|'delete'} [options.mode='copy']
     * @param {boolean} [options.keepDocument=false] delete mode: keep the index
     *   entry when its last location goes (otherwise it moves to workspace Trash)
     * @param {string} [options.folder] copy/move: backend-relative folder the
     *   bytes land in on path-keyed backends (ignored by the blob store)
     * @param {string} [options.filename] copy/move, single document only: name
     *   on arrival; defaults to the document's own filename (see transferFilename)
     * @param {'error'|'rename'|'overwrite'} [options.onConflict='rename'] what
     *   to do when other content already holds the destination key
     * @returns {Promise<{successful: object[], failed: object[]}>}
     */
    async transferDocumentsToBackends(documentIds = [], { to = [], mode = 'copy', keepDocument = false, folder = '', filename = '', onConflict = 'rename', deleteFrom = null } = {}) {
        if (!['copy', 'move', 'delete'].includes(mode)) throw new Error(`Unknown transfer mode: ${mode}`);
        if (!['error', 'rename', 'overwrite'].includes(onConflict)) throw new Error(`Unknown conflict policy: ${onConflict}`);
        // A destination folder is a backend-relative key prefix; `..` and
        // leading slashes are dropped so it can never escape the backend root.
        const destFolder = joinKey(folder);
        const destName = filename ? joinKey(filename) : '';
        if (destName && destName.includes('/')) throw new Error('filename must be a single path segment — use folder for the directory');
        if (destName && documentIds.length > 1) throw new Error('filename applies to a single document — a batch keeps each document\'s own name');
        const targets = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean).map(String))];
        if (targets.length === 0) throw new Error('At least one target backend is required');
        // A move has one destination by definition: with two, "which one may the
        // source be dropped for?" has no answer. Copy fans out freely.
        if (mode === 'move' && targets.length > 1) throw new Error('A move takes exactly one target backend');
        if (mode !== 'delete') {
            for (const target of targets) {
                if (!this.#workspace.dataBackends[target]) throw new Error(`Unknown backend: ${target}`);
                if (this.#workspace.dataBackends[target].readOnly === true) throw new Error(`Backend "${target}" is read-only`);
            }
        }
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();

        const results = { successful: [], failed: [] };
        for (const rawId of documentIds) {
            const id = Number(rawId);
            try {
                const doc = await this.#workspace.get(id);
                if (!doc) { results.failed.push({ id, code: 'DOCUMENT_NOT_FOUND', reason: `Document ${id} is no longer in this workspace. Refresh the file list and select it again.` }); continue; }

                if (mode === 'delete') {
                    const res = await this.#runtime.state.storedIndex.deleteLocations(doc, { backends: targets, deleteFrom, keepDocument });
                    if (res.failed.length) results.failed.push({ id, code: res.failed[0].code, reason: res.failed.map(f => f.reason).join('; '), deleted: res.deleted });
                    else results.successful.push({ id, mode, ...res });
                    continue;
                }

                const transfers = [];
                for (const target of targets) {
                    // Path-keyed backends (a directory share, a drive) get a real
                    // file name under the chosen folder; the blob store keeps its
                    // content-hash key, where a name would only defeat dedup.
                    let key;
                    let from = null;
                    if (this.#workspace.backendKeepsPaths(target)) {
                        const source = this.#runtime.state.storedIndex.locationEndpoints(doc).find((e) => e.backend !== target);
                        if (!source) throw new Error(`Already on "${target}"`);
                        from = source;
                        key = joinKey(destFolder, destName || transferFilename(doc, { sourceKey: source.key, sourceUrl: source.url }));
                    }
                    const res = await this.#runtime.state.storedIndex.transferDocument(doc, { to: target, mode, key, onConflict, from, fallbackSources: true });
                    if (!res?.ok) {
                        const sources = res?.attemptedSources || (res?.source ? [res.source] : []);
                        const destination = key ? `${target}/${key}` : target;
                        const explanation = res?.sourceMissing
                            ? 'The source is missing from the storage index. Resync the source backend and retry.'
                            : res?.reason || 'unknown storage error';
                        const detail = res?.detail || res?.error;
                        throw Object.assign(new Error(`Could not ${mode} document ${id}${sources.length ? ` from ${sources.join(', ')}` : ''} to ${destination}: ${explanation}${detail ? ` (${detail})` : ''}`), {
                            code: res?.reason, source: res?.source, target, targetKey: key,
                        });
                    }
                    // `unchanged` means the object was already there — a no-op,
                    // not a transfer. Reporting it as "complete" would let a
                    // stale index (or a repeat click) look like work happened.
                    transfers.push({
                        backend: target,
                        state: res.unchanged ? 'unchanged' : (res.state || 'complete'),
                        locations: res.locations,
                    });
                }
                results.successful.push({ id, mode, transfers });
            } catch (err) {
                results.failed.push({ id, reason: err.message, code: err.code, source: err.source, target: err.target, targetKey: err.targetKey });
            }
        }
        return results;
    }
}
