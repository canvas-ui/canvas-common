import path from 'path';
import fs from 'fs/promises';
import { internalPathMatcher } from '../../config/internal-paths.js';
import { UPSERT_WAIT_MS, objectsError, normalizeObjectKey } from './contracts.js';

export default class Objects {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    // ─────────────────────────────────────────────────────────────────────────
    // Keyed objects — the hub side of a device mirror
    //
    // A mirror addresses bytes by (backend, key) exactly like the filesystem
    // does, with HTTP-style preconditions. Writes take stored's succession
    // path, so the document behind an edited file keeps its placements, and
    // every mutation lands in the change log the mirror tails.
    // ─────────────────────────────────────────────────────────────────────────

    /** Run `fn` while holding this key's write lock (promise chain per key). */
    withKeyLock(backendName, key, fn) {
        return this.#index.withKeysLock(backendName, [key], fn);
    }

    // Acquire all endpoints together; folder operations also fence descendant
    // writes. Nested endpoint locks would deadlock for parent/child paths.
    withKeysLock(backendName, keys, fn) {
        const names = keys.map(key => `${backendName}:${key}`);
        const overlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
        const prior = [...this.#runtime.state.keyLocks].filter(([held]) => names.some(key => overlap(key, held))).map(([, task]) => task);
        const run = Promise.all(prior.map(task => task.catch(() => {}))).then(fn);
        const chain = run.catch(() => {}).finally(() => {
            for (const name of names) if (this.#runtime.state.keyLocks.get(name) === chain) this.#runtime.state.keyLocks.delete(name);
        });
        for (const name of names) this.#runtime.state.keyLocks.set(name, chain);
        return run;
    }

    // A live, path-addressed local backend or a typed error the route can map.
    objectsBackend(backendName, { write = false } = {}) {
        if (!this.#runtime.state.stored) throw objectsError('Stored index is not running', 'INDEX_NOT_RUNNING', 503);
        if (typeof this.#runtime.state.stored.writeObject !== 'function') {
            throw objectsError('The installed canvas-stored has no keyed-object support (needs >= 1.5.0)', 'STORED_TOO_OLD', 501);
        }
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config || config.supported === false) throw objectsError(`Unknown backend: ${backendName}`, 'BACKEND_NOT_FOUND', 404);
        if (!['file', 'gdrive', 's3'].includes(config.driver)) throw objectsError(`Backend "${backendName}" does not expose keyed objects`, 'UNSUPPORTED_BACKEND', 400);
        const backend = this.#runtime.state.stored.getBackend(backendName);
        if (!backend) throw objectsError(`Backend "${backendName}" is not enabled`, 'BACKEND_DISABLED', 409);
        if (write && config.readOnly === true) throw objectsError(`Backend "${backendName}" is read-only`, 'BACKEND_READ_ONLY', 403);
        return { config, backend, root: config.driver === 'file' ? this.#runtime.backends.resolveBackendRoot(backendName, config) : null };
    }

    // Normalize + validate a wire key against this backend: never the
    // workspace's own internals, never something the index would ignore (a
    // dotfile pushed by a device would otherwise land on disk invisibly).
    objectKey(backend, root, key) {
        const normalized = normalizeObjectKey(key);
        if (!normalized) throw objectsError(`Invalid object key: ${key}`, 'INVALID_KEY', 400);
        if (root && internalPathMatcher(root, { internalPaths: this.#runtime.state.internalPaths })(path.resolve(root, normalized))) {
            throw objectsError(`Key addresses the workspace internals: ${normalized}`, 'KEY_INTERNAL', 409);
        }
        if (typeof backend.isIgnored === 'function' && backend.isIgnored(normalized)) {
            throw objectsError(`Key is excluded from indexing on this backend: ${normalized}`, 'KEY_EXCLUDED', 409);
        }
        return normalized;
    }

    #checksumStringFromId(id) {
        const at = String(id || '').indexOf(':');
        return at > 0 ? `${id.slice(0, at)}/${id.slice(at + 1)}` : null;
    }

    async docIdForStoredId(id) {
        const checksum = this.#checksumStringFromId(id);
        if (!checksum) return null;
        // The stored index can run before the workspace database is active
        // (a HEAD right after a restart): no db, no doc id — never a 500.
        const db = this.#runtime.state.getDb();
        if (!db || typeof db.getByChecksumString !== 'function') return null;
        const doc = await db.getByChecksumString(checksum).catch(() => null);
        return doc?.id ?? null;
    }

    // Row version of a workspace document (synapsd `version`), or null when
    // the DB is not up or the document is unknown. Never throws.
    async docVersion(docId) {
        if (docId == null) return null;
        const db = this.#runtime.state.getDb();
        if (!db || typeof db.getDocument !== 'function') return null;
        // Raw row, no schema hydration: this runs once per listing/feed entry.
        // Rows without a version count as version 1.
        const row = await db.getDocument(docId, '/', { parse: false }).catch(() => null);
        if (!row) return null;
        return Number.isInteger(row.version) && row.version > 0 ? row.version : 1;
    }

    // `If-Match: d<docId>.v<n>` names the document (and its ROW version) the
    // caller last saw at the key (docs/durable-workspaces.md). Both halves are
    // compared: ordinary edits advance the same document, while splitting a
    // shared-content document can change the id at the key. canvas-stored
    // only understands digests, so the check happens here under the key lock:
    // a mismatch is the same typed `precondition-failed` the digest form
    // yields (with `current` carrying docId/version so the client can rebase);
    // a match is rewritten to the digest actually at the key, which the stored
    // index re-checks right before the swap. Any other value passes through.
    async #resolveVersionPrecondition(backendName, normalized, options = {}) {
        const m = /^\s*(?:W\/)?"?d(\d+)\.v(\d+)"?\s*$/i.exec(String(options?.ifMatch ?? ''));
        if (!m) return { options };
        const wantDoc = Number.parseInt(m[1], 10);
        const wantVersion = Number.parseInt(m[2], 10);
        const stat = await this.#index.statObject(backendName, normalized);
        const fail = () => ({
            ok: false, reason: 'precondition-failed', code: 'PRECONDITION_FAILED',
            current: stat ? { id: stat.id, sha256: stat.sha256, size: stat.size, mtime: stat.mtime, docId: stat.docId, version: stat.version } : null,
        });
        if (!stat || stat.docId !== wantDoc || stat.version == null || stat.version !== wantVersion) return { failure: fail() };
        return { options: { ...options, ifMatch: stat.sha256 } };
    }

    trackUpsert(pathKey, promise) {
        if (!pathKey || !promise?.then) return;
        this.#runtime.state.inflightUpserts.set(pathKey, promise);
        promise.catch(() => null).finally(() => {
            if (this.#runtime.state.inflightUpserts.get(pathKey) === promise) this.#runtime.state.inflightUpserts.delete(pathKey);
        });
    }

    // Wait (bounded) for the document upsert the last event on this key
    // started; fall back to a checksum lookup. Never throws.
    async #awaitDocId(pathKey, storedId) {
        const inflight = this.#runtime.state.inflightUpserts.get(pathKey);
        if (inflight) {
            let timer;
            const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), UPSERT_WAIT_MS); timer.unref?.(); });
            try {
                const docId = await Promise.race([inflight, timeout]);
                if (docId != null) return docId;
            } catch { /* fall through to the lookup */ } finally { clearTimeout(timer); }
        }
        return this.docIdForStoredId(storedId);
    }

    /**
     * Write bytes at `backend:key` (see Stored.writeObject for the
     * precondition semantics). Serialized per key; resolves with the document
     * id the landed bytes belong to.
     * @returns {Promise<{ok:true, key, id, sha256, size, mtime, seq, docId, previous, unchanged?} | {ok:false, reason, ...}>}
     */
    async writeObject(backendName, key, source, options = {}) {
        const { backend, root } = this.objectsBackend(backendName, { write: true });
        if (String(options.ifNoneMatch || '').trim() === '*' && typeof backend.createFrom !== 'function') {
            throw objectsError('Create-only uploads require an updated canvas-stored with createFrom support', 'STORED_TOO_OLD', 501);
        }
        const normalized = this.objectKey(backend, root, key);
        const pathKey = `${backendName}:${normalized}`;
        return this.#index.withKeyLock(backendName, normalized, async () => {
            const pre = await this.#resolveVersionPrecondition(backendName, normalized, options);
            if (pre.failure) return pre.failure;
            const result = await this.#runtime.state.stored.writeObject(backendName, normalized, source, pre.options);
            if (!result?.ok) return result;
            const docId = await this.#awaitDocId(pathKey, result.id);
            return { ...result, key: normalized, docId, version: await this.docVersion(docId) };
        });
    }

    /** Delete only `backend:key`; last-location index removal follows workspace policy. */
    async removeObject(backendName, key, options = {}) {
        const { backend, root } = this.objectsBackend(backendName, { write: true });
        const normalized = this.objectKey(backend, root, key);
        return this.#index.withKeyLock(backendName, normalized, async () => {
            const pre = await this.#resolveVersionPrecondition(backendName, normalized, options);
            if (pre.failure) return pre.failure;
            const before = await this.#index.statObject(backendName, normalized);
            const coordinated = await this.#runtime.state.policyRemove?.({ backend: backendName, key: normalized });
            if (coordinated) return { ...coordinated, key: normalized, docId: before?.docId, version: before?.version };
            const result = await this.#runtime.state.stored.removeObject(backendName, normalized, pre.options);
            if (!result?.ok) return result;
            await this.#runtime.state.documentMutations;
            return { ...result, key: normalized, docId: before?.docId ?? null, version: before?.version ?? null };
        });
    }

    /** Retained (displaced) versions on a backend, newest first; `key` narrows to one path. */
    listRetained(backendName, { key = null, limit = 500 } = {}) {
        this.objectsBackend(backendName);
        const root = this.objectsBackend(backendName).root;
        const normalizedKey = key ? this.objectKey(this.objectsBackend(backendName).backend, root, key) : null;
        return this.#runtime.state.stored.listRetained({ backend: backendName, key: normalizedKey, limit }).map((e) => ({
            sha256: e.sha256, size: e.size ?? null, mimeType: e.mimeType ?? null,
            keys: (e.keys || []).filter((k) => k.startsWith(`${backendName}:`)).map((k) => k.slice(backendName.length + 1)),
            firstAt: e.firstAt ?? null, lastAt: e.lastAt ?? null,
        }));
    }

    /**
     * Put a retained version back at `key` (the ordinary keyed write: a
     * succession, change-log entry, hooks). Refuses an occupied key unless
     * `ifMatch` names what is there (`sha256` or `d<docId>.v<n>`).
     */
    async restoreRetained(backendName, sha256, { key, ifMatch = null, origin = null } = {}) {
        const { backend, root } = this.objectsBackend(backendName, { write: true });
        const normalized = this.objectKey(backend, root, key);
        const pathKey = `${backendName}:${normalized}`;
        return this.#index.withKeyLock(backendName, normalized, async () => {
            const pre = await this.#resolveVersionPrecondition(backendName, normalized, { ifMatch });
            if (pre.failure) return pre.failure;
            const result = await this.#runtime.state.stored.restoreRetained(sha256, {
                backend: backendName, key: normalized, origin,
                ...(pre.options.ifMatch != null ? { ifMatch: pre.options.ifMatch } : { ifNoneMatch: '*' }),
            });
            if (!result?.ok) return result;
            const docId = await this.#awaitDocId(pathKey, result.id);
            return { ...result, key: normalized, docId, version: await this.docVersion(docId) };
        });
    }

    get retention() { return this.#runtime.state.stored?.retention ?? null; }

    async listTrash(backendName, options = {}) {
        this.objectsBackend(backendName);
        if (typeof this.#runtime.state.stored.listTrash !== 'function') throw objectsError('Upgrade canvas-stored for backend Trash', 'NOT_IMPLEMENTED', 501);
        return this.#runtime.state.stored.listTrash(backendName, options);
    }

    async restoreTrash(backendName, ids, options = {}) {
        const { backend, root } = this.objectsBackend(backendName, { write: true });
        if (typeof this.#runtime.state.stored.restoreTrash !== 'function') throw objectsError('Upgrade canvas-stored for backend Trash', 'NOT_IMPLEMENTED', 501);
        const results = [];
        let restoredDirectory = false;
        for (const id of [...new Set(ids)]) {
            try {
                const item = await this.#runtime.state.stored.getTrashItem(backendName, id);
                if (!item) { results.push({ id, ok: false, reason: 'not-found' }); continue; }
                const key = this.objectKey(backend, root, item.key);
                const result = await this.#index.withKeyLock(backendName, key, async () => {
                    const release = await this.#runtime.scans.acquireBackendNamespace(backendName);
                    try { return await this.#runtime.state.stored.restoreTrash(backendName, id, options); }
                    finally { release(); }
                });
                restoredDirectory ||= result.ok && result.type === 'directory';
                results.push(result);
            } catch (error) { results.push({ id, ok: false, reason: 'restore-failed', message: error.message }); }
        }
        // Folder trash is one native rename; catch up the index after the
        // complete batch, including empty folders and files added off-index.
        if (restoredDirectory) await this.#index.resync(backendName);
        await this.#runtime.state.documentMutations;
        return { results };
    }

    async discardTrash(backendName, ids) {
        this.objectsBackend(backendName, { write: true });
        if (typeof this.#runtime.state.stored.discardTrash !== 'function') throw objectsError('Upgrade canvas-stored for permanent Trash deletion', 'NOT_IMPLEMENTED', 501);
        const results = [];
        for (const id of [...new Set(ids)]) {
            try {
                const item = await this.#runtime.state.stored.getTrashItem(backendName, id);
                if (!item) { results.push({ id, ok: false, reason: 'not-found' }); continue; }
                // Same lock order as Restore; never resolve or mutate the live
                // original path, which may now contain a different file.
                results.push(await this.#index.withKeyLock(backendName, item.key, async () => {
                    const release = await this.#runtime.scans.acquireBackendNamespace(backendName);
                    try { return await this.#runtime.state.stored.discardTrash(backendName, id); }
                    finally { release(); }
                }));
            } catch (error) { results.push({ id, ok: false, reason: 'discard-failed', message: error.message }); }
        }
        return { results };
    }

    /** Rename within one backend: same bytes, same document, new key. */
    async renameObject(backendName, from, to, options = {}) {
        const { backend, root } = this.objectsBackend(backendName, { write: true });
        const fromKey = this.objectKey(backend, root, from);
        const toKey = this.objectKey(backend, root, to);
        return this.#index.withKeysLock(backendName, [fromKey, toKey], async () => {
            if (options.directory === true) {
                if (typeof this.#runtime.state.stored.renameDirectory !== 'function') {
                    throw objectsError('Directory rename requires an updated canvas-stored', 'NOT_IMPLEMENTED', 501);
                }
                const policyIntent = await this.#runtime.state.policyDirectoryMove?.('prepare', { backend: backendName, from: fromKey, to: toKey, ...options });
                if (policyIntent) options = { ...options, origin: `workspace-directory:${options.operationId}` };
                const release = await this.#runtime.scans.acquireBackendNamespace(backendName);
                try {
                    let projections = [];
                    // Hold document projection while Stored emits its per-content
                    // move events. Move the directory node once before those events
                    // refresh location URLs, preserving node ids and memberships.
                    const result = await this.#runtime.projection.mutateDocuments(async () => {
                        const root = this.#runtime.backends.getBackendRootPath(backendName);
                        if (root && this.#runtime.state.moveBackendPath) await this.#runtime.state.moveBackendPath(`${root}/${fromKey}`, `${root}/${toKey}`, { validateOnly: true });
                        const moved = await this.#runtime.state.stored.renameDirectory(backendName, fromKey, toKey, options);
                        projections = [...this.#runtime.state.inflightUpserts]
                            .filter(([key]) => key.startsWith(`${backendName}:${toKey}/`))
                            .map(([, pending]) => pending);
                        // A replayed receipt must not move a newly recreated
                        // source's tree node. The completed move leaves no source.
                        const sourceExists = moved?.ok && await fs.lstat(backend.resolveKeyPath(fromKey))
                            .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
                        if (moved?.ok && !sourceExists && this.#runtime.state.moveBackendPath) {
                            if (root) await this.#runtime.state.moveBackendPath(`${root}/${fromKey}`, `${root}/${toKey}`);
                        }
                        return moved;
                    });
                    // Observe the actual event promises: the queue's tail catches
                    // errors to keep running, but an API move must report them.
                    await Promise.all(projections);
                    if (policyIntent) await this.#runtime.state.policyDirectoryMove('complete', { ...policyIntent, result });
                    return result;
                } finally { release(); }
            }
            const pre = await this.#resolveVersionPrecondition(backendName, fromKey, options);
            if (pre.failure) return pre.failure;
            const result = await this.#runtime.state.stored.renameObject(backendName, fromKey, toKey, pre.options);
            if (!result?.ok) return result;
            const docId = await this.#awaitDocId(`${backendName}:${toKey}`, result.id);
            return { ...result, docId, version: await this.docVersion(docId) };
        });
    }

    /** `{ key, id, sha256, size, mtime, mimeType, docId, version }` for an indexed key, or null. */
    async statObject(backendName, key) {
        const { backend, root } = this.objectsBackend(backendName);
        const normalized = this.objectKey(backend, root, key);
        const meta = await this.#runtime.state.stored.stat(`${backendName}:${normalized}`);
        const location = meta?.locations?.find((l) => l.backend === backendName && l.key === normalized);
        if (!meta || !location) return null;
        const docId = await this.docIdForStoredId(meta.id);
        return {
            key: normalized,
            id: meta.id,
            sha256: meta.checksums?.sha256 ?? null,
            size: location.size ?? meta.size ?? null,
            mtime: location.mtime ?? null,
            mimeType: meta.mimeType || null,
            docId,
            version: await this.docVersion(docId),
        };
    }

    /** Page a backend's indexed keys: `{ objects:[{key, sha256, size, mtime, mimeType, docId, version}], cursor, head }`. */
    async listObjects(backendName, { prefix = '', after = null, limit = 1000 } = {}) {
        this.objectsBackend(backendName);
        const cleanPrefix = prefix ? String(prefix).replace(/^\/+/, '').normalize('NFC') : '';
        const page = this.#runtime.state.stored.listObjects(backendName, { prefix: cleanPrefix, after, limit });
        const objects = [];
        for (const o of page.objects || []) {
            const docId = await this.docIdForStoredId(o.id);
            objects.push({
                key: o.key,
                sha256: o.checksums?.sha256 ?? null,
                size: o.size ?? null,
                mtime: o.mtime ?? null,
                mimeType: o.mimeType ?? null,
                docId,
                version: await this.docVersion(docId),
            });
        }
        return { objects, cursor: page.cursor ?? null, head: this.#runtime.state.stored.head() };
    }

    /**
     * The change feed for one backend. Entries are dirty-key notifications
     * with the last known state; a reader re-stats the key rather than
     * replaying ops. `cursorTooOld` = rebuild from `listObjects`.
     */
    async changes(backendName, { since = 0, limit = 1000 } = {}) {
        this.objectsBackend(backendName);
        const page = this.#runtime.state.stored.changes({ backend: backendName, since, limit });
        const changes = [];
        for (const c of page.changes || []) {
            // docId/version describe the document at the key NOW (the feed is
            // coalesced per key; a reader re-stats anyway) — for a delete the
            // orphaned document is still resolvable by its digest.
            const docId = c.op === 'delete' ? null : await this.docIdForStoredId(c.id);
            changes.push({
                seq: c.seq,
                ts: c.ts,
                op: c.op,
                key: c.key,
                ...(c.from != null ? { from: c.from } : {}),
                sha256: typeof c.id === 'string' && c.id.startsWith('sha256:') ? c.id.slice(7) : null,
                size: c.size ?? null,
                mtime: c.mtime ?? null,
                ...(c.origin ? { origin: c.origin } : {}),
                docId,
                version: docId ? await this.docVersion(docId) : null,
            });
        }
        return {
            changes,
            head: page.head,
            oldest: page.oldest,
            cursor: page.cursor,
            cursorTooOld: page.cursorTooOld === true,
        };
    }

    /** Bytes for `backend:key` — `{ data, ranged }` as resolve(). */
    async resolveObject(backendName, key, options = {}) {
        const { backend, root } = this.objectsBackend(backendName);
        const normalized = this.objectKey(backend, root, key);
        return this.#index.resolve(`stored://${backendName}/${normalized}`, options);
    }
}
