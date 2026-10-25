import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { DATA_BLOB_BACKEND } from './contracts.js';

export default class Content {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    /**
     * Persist a blob into the local content-addressable data store
     * (workspace:data). The connector seam for non-file sources (mail, future
     * offline-website download, …): dump bytes, get back a resolvable
     * stored://workspace:data/<key> URL — keys are checksum-derived and deduped;
     * on-disk layout is opaque (the synapsd tree is the navigation).
     *
     * `adopt` (with a file path) moves the file in instead of copying it; the
     * caller's `checksums` (hex, computed as the bytes arrived) skip hashing.
     *
     * @param {Buffer|string} blob
     * @param {{ adopt?: boolean, checksums?: { sha256: string } }} [options]
     * @returns {Promise<{ url: string, key: string, checksum: string|null, size: number }>}
     */
    async persistBlob(blob, { adopt = false, checksums } = {}) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const res = await this.#runtime.state.stored.put(blob, { backends: [DATA_BLOB_BACKEND], ...(adopt ? { adopt, checksums } : {}) });
        if (!res?.ok) throw new Error(`Blob persist failed: ${res?.reason || 'unknown'}`);
        return {
            url: `stored://${DATA_BLOB_BACKEND}/${res.key}`,
            key: res.key,
            checksum: res.checksums?.sha256 || null,
            size: res.size,
            mimeType: res.mimeType || null,
            // Inline-extracted EXIF/GPS/dimensions/media (may be {}). The caller
            // (blob-upload route → CLI) merges this onto the File document.
            metadata: res.custom && Object.keys(res.custom).length ? res.custom : undefined,
        };
    }

    /**
     * Look up an already-persisted blob by its sha256 (hex). The resumable-
     * upload seam: clients hash locally, ask here first, and skip the byte
     * transfer when the content-addressed store already holds the bytes in
     * workspace:data. Returns the same shape persistBlob would have returned,
     * or null when the blob is absent (or lives only on other backends —
     * a file:// mount hit must not satisfy an upload-into-data check).
     *
     * @param {string} sha256 hex digest
     * @returns {Promise<{ url: string, key: string, checksum: string, size: number, mimeType: string|null, metadata?: object }|null>}
     */
    async statBlobByChecksum(sha256) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const meta = await this.#runtime.state.stored.stat(`sha256:${sha256}`);
        const location = meta?.locations?.find((l) => l.backend === DATA_BLOB_BACKEND);
        if (!location) return null;
        return {
            url: `stored://${DATA_BLOB_BACKEND}/${location.key}`,
            key: location.key,
            checksum: meta.checksums?.sha256 || sha256,
            size: meta.size,
            mimeType: meta.mimeType || null,
            metadata: meta.custom && Object.keys(meta.custom).length ? meta.custom : undefined,
        };
    }

    /**
     * Resolve a `locations[].url` to its bytes (Buffer, or a stream with
     * { stream: true }). Single entry point for the unified URL grammar.
     *
     *   stored://<backend>/<key>      → Stored backend (data backends are
     *                                   registered on demand)
     *   file://{WORKSPACE_ROOT}/<p>   → workspace FS (substitutes rootPath)
     *   file://<deviceId>/<p>         → NOT IMPLEMENTED (device-proxy stub)
     *
     * @param {string} url
     * @param {{stream?: boolean}} [options]
     * @returns {Promise<Buffer|ReadStream|null>}
     */
    // Returns `{ data, ranged }`: `data` is a Buffer (non-stream), a Readable
    // (stream), or null on a miss; `ranged` is true only when a requested byte
    // window (`options.range = { start, end }`, inclusive end) was actually
    // served — so the HTTP layer only sends 206 when the bytes really are partial.
    async resolve(url, options = {}) {
        const parsed = parseLocationUrl(url);
        if (!parsed) throw new Error(`Unparseable location URL: ${url}`);
        const { scheme, backend, key } = parsed;

        if (scheme === 'stored') {
            if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
            if (!options.stream) return { data: await this.#runtime.state.stored.getByUrl(url), ranged: false };
            if (options.range) {
                const r = await this.#runtime.state.stored.getRangeStreamByUrl(url, options.range);
                return { data: r?.stream ?? null, ranged: !!r?.ranged };
            }
            return { data: await this.#runtime.state.stored.getStreamByUrl(url), ranged: false };
        }

        if (scheme === 'file') {
            if (backend === '{WORKSPACE_ROOT}') {
                const root = path.resolve(this.#runtime.state.rootPath);
                const abs = path.resolve(root, key);
                // Keys come from stored URLs; a crafted '..' key must never
                // escape the workspace root.
                if (abs !== root && !abs.startsWith(root + path.sep)) {
                    throw new Error(`Location escapes workspace root: ${url}`);
                }
                if (!options.stream) return { data: await fs.readFile(abs), ranged: false };
                if (options.range) {
                    return { data: createReadStream(abs, { start: options.range.start, end: options.range.end }), ranged: true };
                }
                return { data: createReadStream(abs), ranged: false };
            }
            // file://<deviceId>/<abs-path>: locally resolvable when the
            // authority is THIS server's device AND the path sits under a
            // configured external mount (never arbitrary host paths). Other
            // devices stay reference-only until a device proxy exists.
            const local = this.#runtime.backends.resolveLocalDevicePath(backend, key);
            if (local) {
                if (!options.stream) return { data: await fs.readFile(local.abs), ranged: false };
                if (options.range) {
                    return { data: createReadStream(local.abs, { start: options.range.start, end: options.range.end }), ranged: true };
                }
                return { data: createReadStream(local.abs), ranged: false };
            }
            // Bytes live on another device (or an unconfigured mount) — an
            // expected miss, not a server fault. The code lets resolveDocument
            // treat it as "location unreachable" (404) instead of a 500.
            const err = new Error(`Device-proxy resolution not implemented for ${url}`);
            err.code = 'DEVICE_NOT_REACHABLE';
            throw err;
        }

        throw new Error(`No resolver for scheme: ${scheme}`);
    }

    // Allowed thumbnail edge sizes — a fixed set keeps the derived-artifact
    // cache bounded (no per-pixel-size explosion).


    /**
     * Describe each of a document's locations for a Destroy picker: whether its
     * bytes can actually be removed (RW backend / workspace file) or only its
     * reference dropped (read-only http, unregistered/foreign backends).
     * @returns {Promise<Array<{url, scheme, backend, kind, deletable}>>}
     */
    async describeLocations(doc) {
        const out = [];
        for (const loc of (doc?.locations || [])) {
            const p = parseLocationUrl(loc?.url);
            let kind = p?.scheme || 'unknown';
            let deletable = false;
            if (p?.scheme === 'stored') {
                const be = this.#runtime.state.stored ? this.#runtime.state.stored.getBackend(p.backend) : null;
                kind = 'stored';
                // Config-level readOnly overrides the driver capability: the
                // backend CAN delete but the user declared it hands-off. A
                // disabled-but-configured local backend still counts as
                // deletable — destroy registers it transiently (the enable-lock
                // forces disable-before-destroy for whole-backend subtrees).
                const configuredLocal = this.#runtime.backends.isConfiguredLocalBackend(p.backend);
                deletable = (be ? be.canDelete : configuredLocal) && this.#runtime.state.dataBackends[p.backend]?.readOnly !== true;
            } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                kind = 'workspace-file';
                deletable = true;
            } else if (p?.scheme === 'file') {
                // Device-scoped path: deletable only when it's THIS device and
                // the owning mount is not read-only; foreign devices are
                // reference-drop only.
                const local = this.#runtime.backends.resolveLocalDevicePath(p.backend, p.key);
                kind = 'device-file';
                deletable = !!local && this.#runtime.state.dataBackends[local.backendName]?.readOnly !== true;
            } else if (p?.scheme === 'imap') {
                // Delegated to the mail service (deletable only if imap creds wired).
                const described = this.#runtime.state.describeImapLocation ? await this.#runtime.state.describeImapLocation(loc.url) : null;
                kind = 'imap';
                deletable = described?.deletable === true;
            } else if (p?.scheme === 'http' || p?.scheme === 'https') {
                kind = 'readonly';
                deletable = false;
            }
            out.push({ url: loc.url, scheme: p?.scheme, backend: p?.backend, kind, deletable });
        }
        return out;
    }

    /**
     * Destroy a document's blobs from backends (the "Destroy" op).
     *
     * For each targeted location: RW backend → delete bytes; read-only / foreign
     * → drop the reference only (no remote mutation). Then trim `locations[]`.
     * When no locations remain, the document carries no retrievable content, so
     * it is removed from the index (cascades unlink from all contexts).
     *
     * NOTE: imap:// EXPUNGE is delegated to the mail service (reference-dropped
     * when no credentials are wired). file://<deviceId> is reference-drop only.
     *
     * @param {object} doc                document instance/object with id + locations
     * @param {{urls?: string[]}} [options]  specific location URLs to target (default: all)
     * @returns {Promise<{deleted:string[], droppedRefs:string[], kept:string[], docDeleted:boolean}>}
     */
    async destroy(doc, options = {}) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const db = this.#runtime.state.getDb();
        const locations = Array.isArray(doc?.locations) ? [...doc.locations] : [];
        const targets = Array.isArray(options.urls) ? new Set(options.urls) : new Set(locations.map((l) => l.url));

        const result = { deleted: [], droppedRefs: [], kept: [], docDeleted: false };
        const kept = [];

        for (const loc of locations) {
            if (!targets.has(loc.url)) { kept.push(loc); continue; }
            const p = parseLocationUrl(loc.url);
            try {
                if (p?.scheme === 'stored') {
                    const { backend: be, transient } = this.#runtime.backends.ensureByteOpsBackend(p.backend);
                    if (be && be.canDelete && this.#runtime.state.dataBackends[p.backend]?.readOnly !== true) {
                        const res = await this.#runtime.state.stored.deleteByUrl(loc.url);
                        if (res.ok) result.deleted.push(loc.url);
                        else result.droppedRefs.push(loc.url);
                    } else {
                        // read-only (driver or config) / unknown backend → reference drop only
                        result.droppedRefs.push(loc.url);
                    }
                    if (transient) await this.#runtime.state.stored.removeBackend?.(p.backend);
                } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                    await fs.rm(path.join(this.#runtime.state.rootPath, p.key), { force: true });
                    result.deleted.push(loc.url);
                } else if (p?.scheme === 'file' && this.#runtime.backends.resolveLocalDevicePath(p.backend, p.key)) {
                    // Local device-scoped path on a RW external mount → wipe the
                    // bytes; read-only mount → reference drop.
                    const local = this.#runtime.backends.resolveLocalDevicePath(p.backend, p.key);
                    if (this.#runtime.state.dataBackends[local.backendName]?.readOnly !== true) {
                        await fs.rm(local.abs, { force: true });
                        result.deleted.push(loc.url);
                    } else {
                        result.droppedRefs.push(loc.url);
                    }
                } else if (p?.scheme === 'imap') {
                    const res = this.#runtime.state.destroyImapLocation ? await this.#runtime.state.destroyImapLocation(loc.url) : null;
                    if (res?.ok) result.deleted.push(loc.url); // STORE \Deleted + EXPUNGE by UID
                    else result.droppedRefs.push(loc.url); // no credentials wired → drop reference only
                } else {
                    // http(s) RO, file://<device>, etc. → reference drop only
                    result.droppedRefs.push(loc.url);
                }
            } catch (error) {
                this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, url: loc.url, error: error.message }, 'Destroy: location wipe failed; keeping reference');
                kept.push(loc);
            }
        }

        doc.locations = kept;
        result.kept = kept.map((l) => l.url);

        // Bytes were removed (or the doc is about to go) — the cached thumbnails
        // derive from those bytes and must not outlive them.
        if (result.deleted.length > 0 || kept.length === 0) {
            await this.#index.purgeThumbnails([doc]).catch(() => {});
        }

        if (kept.length === 0 && doc?.id != null) {
            if (options.keepDocument === true) {
        // Caller chose to keep the index entry with no retrievable bytes
        // (locations: []) — metadata/checksums stay searchable. orphanedAt
        // is the GC lifecycle and what ticks feature/orphaned.
                doc.orphanedAt = doc.orphanedAt || new Date().toISOString();
                await this.#runtime.state.put(doc, { context: null });
            } else {
                await db.delete(doc.id);
                result.docDeleted = true;
            }
        } else if (doc?.id != null) {
            await this.#runtime.state.put(doc, { context: null }); // persist trimmed locations (update in place)
        }
        return result;
    }
}
