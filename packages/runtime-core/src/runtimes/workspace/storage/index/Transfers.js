import path from 'path';
import { randomUUID } from 'node:crypto';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { objectsError } from './contracts.js';

export default class Transfers {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    /**
     * Shared preflight for copy/move. Both ends must be LIVE backends, not
     * transiently registered ones: dropping a transient registration afterwards
     * prunes that backend's locations from stored's index, which would undo the
     * transfer we just made. "Enable the backend first" is the honest answer.
     */
    #transferEndpoints(url, target) {
        if (!this.#runtime.state.stored) throw new Error('Stored index is not running');
        const parsed = parseLocationUrl(url);
        if (!parsed || parsed.scheme !== 'stored') throw new Error(`Not a stored:// URL: ${url}`);
        if (!target) throw new Error('A target backend is required');
        if (!this.#runtime.state.stored.getBackend(parsed.backend)) {
            throw new Error(`Source backend "${parsed.backend}" is not enabled`);
        }
        if (!this.#runtime.state.stored.getBackend(target)) {
            throw new Error(`Target backend "${target}" is not enabled`);
        }
        if (this.#runtime.state.dataBackends[target]?.readOnly === true) {
            throw new Error(`Target backend "${target}" is read-only`);
        }
        return `${parsed.backend}:${parsed.key}`;
    }

    /**
     * Map a document location back to the (backend, key) pair that addresses its
     * bytes. Both address forms resolve: `stored://<backend>/<key>` directly,
     * and a device-scoped `file://<deviceId>/<abs>` through its owning mount
     * (external mounts carry ONLY the file:// form, so without this a NAS mount
     * would have nothing to transfer from). Null for anything not ours —
     * imap://, https://, foreign devices.
     */
    locationEndpoint(location) {
        const parsed = parseLocationUrl(location?.url);
        if (!parsed) return null;
        if (parsed.scheme === 'stored') return { backend: parsed.backend, key: parsed.key, url: location.url };
        if (parsed.scheme === 'file' && location?.metadata?.backend) {
            const key = this.#runtime.projection.backendLocationKey(location.metadata.backend, location);
            return key ? { backend: location.metadata.backend, key, url: location.url } : null;
        }
        return null;
    }

    /**
     * Every location of this document that addresses bytes we can transfer,
     * as (backend, key) pairs. Used by rules to pick a source and to build a
     * destination key from the current filename.
     */
    locationEndpoints(doc) {
        return (doc?.locations || []).map((l) => this.locationEndpoint(l)).filter(Boolean);
    }

    async readableLocationEndpoints(doc) {
        const readable = [];
        for (const endpoint of this.#index.locationEndpoints(doc)) {
            const backend = this.#runtime.state.stored?.getBackend(endpoint.backend);
            if (!backend?.canRead) continue;
            const entry = await this.#runtime.state.stored.stat(`${endpoint.backend}:${endpoint.key}`);
            if (entry?.locations?.some(l => l.backend === endpoint.backend && l.key === endpoint.key && l.synced)) readable.push(endpoint);
        }
        return readable;
    }

    /**
     * Copy or move one document's bytes onto `to`. The source is whichever of
     * its locations is not already on the target (or `from`, when the caller
     * has already picked one); being already there is reported rather than
     * silently succeeding, so a batch result says what actually happened per
     * document.
     *
     * `key` renames on arrival — a rule filing photos as YYYY/MM/…jpg passes
     * one — and `onConflict` decides what happens when that key is taken.
     */
    async transferDocument(doc, { to, mode = 'copy', key = undefined, onConflict = undefined, from = null, fallbackSources = false } = {}) {
        const endpoints = this.#index.locationEndpoints(doc);
        if (endpoints.length === 0) throw new Error('Document has no transferable byte location');
        const source = from
            ? endpoints.find((e) => e.backend === from.backend && e.key === from.key)
            : endpoints.find((e) => e.backend !== to);
        if (!source) throw new Error(from ? `No location on "${from.backend}"` : `Already on "${to}"`);

        const options = { to, key, onConflict };
        // Batch callers choose a preferred location for its filename, rather
        // than pinning the source. A stale first location must not hide another
        // copy of the same document. Explicit rule sources remain pinned.
        const candidates = fallbackSources || !from
            ? [source, ...endpoints.filter(e => e.backend !== to && (e.backend !== source.backend || e.key !== source.key))]
            : [source];
        const attempted = new Set();
        let failure;
        for (const candidate of candidates) {
            const url = `stored://${candidate.backend}/${candidate.key}`;
            if (attempted.has(url)) continue;
            attempted.add(url);
            const sourceMissing = !await this.#runtime.state.stored.stat(`${candidate.backend}:${candidate.key}`);
            const result = sourceMissing ? { ok: false, reason: 'not-found' }
                : await (mode === 'move' ? this.#index.moveObject(url, options) : this.#index.copyObject(url, options));
            if (result?.ok) return result;
            failure = { ...result, source: url, sourceMissing, target: to, targetKey: key };
            // Retry only source failures before a write. Conflicts, checksum
            // mismatches and target failures must retain their own semantics.
            if (!sourceMissing && !['no-source', 'source-unreadable', 'source-offline'].includes(result?.reason)) return failure;
        }
        return { ...failure, attemptedSources: [...attempted] };
    }

    /** This document's location URLs that live on any of `backends`. */
    locationUrlsOnBackends(doc, backends = []) {
        const wanted = new Set(backends);
        return (doc?.locations || [])
            .filter((l) => { const e = this.locationEndpoint(l); return e && wanted.has(e.backend); })
            .map((l) => l.url);
    }

    /** Explicit backend deletion is location-scoped. Do not unfile a document
     * from a storage policy (which would remove its other replicas too), or
     * rewrite a stale full-document snapshot while inference is updating it.
     */
    async deleteLocations(doc, { backends, deleteFrom = null, keepDocument = false } = {}) {
        const endpoints = this.#index.locationEndpoints(doc).filter(e => backends.includes(e.backend)
            && (!deleteFrom || e.backend !== deleteFrom.backend || path.posix.dirname(e.key) === (deleteFrom.folder || '.')));
        if (!endpoints.length) throw objectsError('No location in the selected backend folder', 'LOCATION_NOT_FOUND', 404);
        const checksum = doc.checksumArray?.find(c => c.startsWith('sha256/'))?.slice(7);
        if (!checksum) throw objectsError('Cannot delete without a content identity; rescan this backend first', 'CONTENT_IDENTITY_REQUIRED', 409);
        const deleted = [], failures = [], visited = new Set();
        for (const endpoint of endpoints) {
            const address = JSON.stringify([endpoint.backend, endpoint.key]);
            if (visited.has(address)) continue;
            visited.add(address);
            try {
                const config = this.#runtime.state.dataBackends[endpoint.backend];
                const backend = this.#runtime.state.stored.getBackend(endpoint.backend);
                if (!config || !backend) throw objectsError(`Backend "${endpoint.backend}" is not enabled`, 'BACKEND_DISABLED', 409);
                if (config.readOnly || !backend.canDelete) throw objectsError(`Backend "${endpoint.backend}" is read-only`, 'BACKEND_READ_ONLY', 403);
                const result = await this.#index.withKeyLock(endpoint.backend, endpoint.key, () => this.#runtime.state.stored.removeObject(endpoint.backend, endpoint.key, {
                    ifMatch: checksum, origin: `backend-delete:${keepDocument ? 'keep:' : ''}${randomUUID()}`,
                }));
                if (!result.ok) throw objectsError(`Cannot delete ${endpoint.key}: ${result.reason}`, result.reason, 409);
                deleted.push(endpoint.url);
            } catch (error) { failures.push({ url: endpoint.url, reason: error.message, code: error.code }); }
        }
        // The unlink event owns the serialized, partial location update. Never
        // submit the document snapshot read before the physical operation.
        await this.#runtime.state.documentMutations;
        await this.#index.reconcileRemovedLocations(doc, deleted, { suppressPolicy: true, manualRemoval: true, keepDocument });
        return { deleted, failed: failures, droppedRefs: [], docDeleted: false };
    }

    /**
     * Copy the object behind a `stored://` URL onto another backend. Content
     * identity is preserved: the document gains a location, and the resulting
     * `object:location:add` patches it in place.
     */
    async copyObject(url, { to, key, onConflict } = {}) {
        const idOrKey = this.#transferEndpoints(url, to);
        const result = await this.#runtime.state.stored.copy(idOrKey, { to, key, onConflict, from: url });
        await this.#runtime.state.documentMutations;
        return result;
    }

    /**
     * Move the object behind a `stored://` URL to another backend. The source is
     * only released once the destination write is durable; a move onto a
     * `type:'remote'` backend returns `state:'pending'` and completes on sync.
     */
    async moveObject(url, { to, key, onConflict } = {}) {
        const idOrKey = this.#transferEndpoints(url, to);
        if (this.#runtime.state.dataBackends[parseLocationUrl(url).backend]?.readOnly === true) {
            throw new Error('Source backend is read-only — copy instead of move');
        }
        const result = await this.#runtime.state.stored.move(idOrKey, { to, key, onConflict, from: url });
        await this.#runtime.state.documentMutations;
        return result;
    }
}
