import path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { mimeFromLocations } from '../../db/classifier.js';
import { pickGeo } from '../../db/geo.js';
import { BACKENDS_TREE_NAME } from '../../../../utils/backend-documents.js';
import { CHECKSUM_PRIORITY, ORPHANED_FEATURE, objectsError } from './contracts.js';

export default class DocumentProjection {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    // ─────────────────────────────────────────────────────────────────────────
    // Sync
    // ─────────────────────────────────────────────────────────────────────────

    // Stored may already have committed new bytes when document projection
    // fails. Snapshot the database's path owners once per scan so a retry (or
    // restart) can recover edit provenance without a per-file document scan.
    async previousFilesForBackend(backendName) {
        const root = this.#runtime.backends.getBackendRootPath(backendName);
        const previous = new Map();
        if (!root) return previous;
        const { documents = [] } = await this.#runtime.state.getDb()
            .listTreeDocuments(BACKENDS_TREE_NAME, { path: root, limit: null });
        for (const document of documents) {
            const checksums = Object.fromEntries((document.checksumArray || []).map(value => {
                const separator = value.indexOf('/');
                return [value.slice(0, separator), value.slice(separator + 1)];
            }));
            for (const location of document.locations || []) {
                const key = this.backendLocationKey(backendName, location);
                if (key != null) previous.set(key, { checksums });
            }
        }
        return previous;
    }

    /**
     * Reconcile absences after a COMPLETED scan of one backend. Scoped strictly
     * to that backend's locations (stored://<backend>/…, plus the device file://
     * twins tied via metadata.backend) — s3://, imap:// etc. on the same doc are
     * never touched. Per-entry semantics:
     *   - checksum present in scan        → unchanged, skip
     *   - path present, new checksum      → in-place edit: migrate curated
     *     placements to the successor doc, then apply the last-location policy
     *   - path under an unreadable subtree→ carry forward (stale, not deleted)
     *   - path hashed-failed              → present-but-unverified, carry forward
     *   - path gone                       → drop this backend's locations; doc
     *     follows the configured orphan policy if none survive
     * Returns the number of docs that lost locations here.
     */
    async purgeOrphanedPaths(backendName, presentFiles = [], scanErrors = null) {
        const db = this.#runtime.state.getDb();
        const nfc = (k) => String(k).normalize('NFC');
        const presentChecksums = new Set(
            presentFiles.flatMap((f) => this.#buildChecksumArray(f.checksums))
        );
        // ALL scanned keys count as present — a row that failed to hash is
        // present-but-unverified, not deleted.
        const fileByKey = new Map(presentFiles.map((f) => [nfc(f.key), f]));
        const erroredPrefixes = (scanErrors?.dirs || []).map((d) => d.prefix).filter(Boolean);
        const underErroredPrefix = (key) => erroredPrefixes.some((prefix) =>
            key === prefix || key.startsWith(`${prefix}/`));

        const backendRoot = this.#runtime.backends.getBackendRootPath(backendName);
        if (!backendRoot) return 0;
        // RECURSIVE: the mirror nests one node per folder, so a plain list of the
        // backend's root node only sees files sitting directly in it. Absences
        // in every subfolder — i.e. almost every real file — would go
        // unreconciled, leaving documents pointing at bytes that are gone.
        const { documents: docsInTree = [] } = await db
            .listTreeDocuments(BACKENDS_TREE_NAME, { path: backendRoot, limit: null })
            .catch(() => ({ documents: [] }));

        let reconciled = 0;
        for (const doc of docsInTree) {
            const primaryChecksum = doc.checksumArray?.[0];
            if (!primaryChecksum) continue;

            const ownedLocations = (doc.locations || [])
                .filter((l) => parseLocationUrl(l.url)?.backend === backendName || l.metadata?.backend === backendName);
            if (ownedLocations.length === 0) continue;

            const located = ownedLocations.map((l) => {
                const key = this.backendLocationKey(backendName, l);
                return { location: l, key: key != null ? nfc(key) : null };
            });
            const keys = located.map((e) => e.key).filter((k) => k != null);

            // Content still present in the snapshot: the doc survives, but any
            // owned location whose path vanished (the old path of a moved file,
            // upserted mid-scan before the walk completed) is trimmed — scoped
            // to this backend, carried forward under errored prefixes.
            if (presentChecksums.has(primaryChecksum)) {
                const staleUrls = located
                    .filter(({ key }) => key != null && !fileByKey.has(key) && !underErroredPrefix(key))
                    .map(({ location }) => location.url);
                if (staleUrls.length > 0) {
                    await this.#reconcileRemovedLocations(doc, staleUrls);
                    reconciled += 1;
                }
                continue;
            }

            // Unreadable subtree — prior entries carry forward as stale.
            if (keys.some(underErroredPrefix)) continue;
            // Path still exists but failed to hash — present, not deleted.
            const survivorFiles = keys.map((k) => fileByKey.get(k)).filter(Boolean);
            if (survivorFiles.some((f) => !f.checksums)) continue;

            // Same path, new bytes: content identity made a new doc — migrate
            // the predecessor's curated placements to it before applying the last-location policy.
            const successorFile = survivorFiles.find((f) => f.checksums);
            if (successorFile) {
                try {
                    await this.#migrateToSuccessor(doc, successorFile);
                } catch (error) {
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, docId: doc.id, key: successorFile.key, error: error.message }, 'Placement migration failed; retaining predecessor for retry');
                    continue;
                }
            }

            const removedUrls = ownedLocations.map((l) => l.url);
            await this.#reconcileRemovedLocations(doc, removedUrls, { suppressPolicy: Boolean(successorFile) });
            reconciled += 1;
        }
        if (reconciled > 0) {
            this.#runtime.state.logger.info({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, docs: reconciled }, 'Resync: reconciled removed locations');
        }
        return reconciled;
    }

    // Rel key of a location on `backendName` — stored://<backend>/<key> directly,
    // file://<deviceId>/<abs> via the mount root. Null when not this backend's.
    backendLocationKey(backendName, location) {
        const parsed = parseLocationUrl(location?.url);
        if (!parsed) return null;
        if (parsed.scheme === 'stored' && parsed.backend === backendName) return parsed.key;
        if (parsed.scheme === 'file' && location.metadata?.backend === backendName) {
            const mount = this.#runtime.backends.externalMountInfo(backendName);
            if (!mount) return null;
            const abs = path.resolve('/', String(parsed.key || ''));
            const root = path.resolve(mount.root);
            if (abs === root || abs.startsWith(root + path.sep)) return path.relative(root, abs);
        }
        return null;
    }

    // In-place edit succession: copy curated placements (all trees except the
    // backends mirror, which the successor writes itself) onto the successor
    // doc and record both the predecessor's checksum and a derived-from edge.
    async #migrateToSuccessor(oldDoc, successorFile) {
        const db = this.#runtime.state.getDb();
        const successorChecksum = this.#buildChecksumArray(successorFile.checksums)[0];
        if (!successorChecksum) return;
        const successor = await db.getByChecksumString(successorChecksum).catch(() => null);
        if (!successor?.id) throw new Error('Successor is not indexed yet');
        if (successor.id === oldDoc.id) return;

        await this.#writeSuccessor(oldDoc, {
            id: successor.id,
            metadata: { derivedFrom: oldDoc.checksumArray?.[0] || null },
        }, { context: null }, successorFile, [], successor.version);
    }

    // Policy lives here; SynapsD commits the successor, curation, edges and the
    // surviving predecessor's location/mirror updates in one transaction.
    async #writeSuccessor(predecessor, document, spec, file, stalePaths = [], successorVersion) {
        const db = this.#runtime.state.getDb();
        if (typeof db.putSuccessor !== 'function') {
            throw objectsError('Atomic document succession requires the updated canvas-synapsd runtime', 'SUCCESSION_UNSUPPORTED', 503);
        }
        const removed = [`stored://${file.backend}/${file.key}`];
        const twin = this.#runtime.backends.deviceFileLocationUrl(file.backend, file.key);
        if (twin) removed.push(twin);
        const remaining = (predecessor.locations || []).filter(l => !removed.includes(l.url));
        const currentPaths = await db.listDocumentTreePaths(predecessor.id, BACKENDS_TREE_NAME);
        const root = this.#runtime.backends.getBackendRootPath(file.backend);
        const preserved = currentPaths.filter(p => !(p === root || p.startsWith(`${root}/`)));
        const nextPaths = [...preserved, ...this.#buildBackendPaths(remaining.map(l => this.#runtime.transfers.locationEndpoint(l)).filter(Boolean))];
        const removedPaths = currentPaths.filter(p => !nextPaths.includes(p));
        const unlinkSpec = directory => ({ context: null, directory: this.#runtime.state.getBackendsTreeSelector(directory) });
        const id = await db.putSuccessor(predecessor.id, document, spec, {
            excludeTrees: [BACKENDS_TREE_NAME],
            predecessor: {
                version: predecessor.version,
                // With independent copies, retiring this location is part of
                // the divergence commit. Last-location convergence retains the
                // existing workspace removal policy after curation is safe.
                ...(remaining.length ? { changes: { locations: remaining }, unlink: removedPaths.map(unlinkSpec) } : {}),
            },
            successorVersion,
            successorUnlinks: stalePaths.map(unlinkSpec),
        });
        if (!remaining.length) await this.#reconcileRemovedLocationsNow(predecessor, removed, { suppressPolicy: true });
        for (const directory of [...stalePaths, ...(remaining.length ? removedPaths : [])]) {
            await this.#pruneBackendFolder(directory);
            this.#schedulePruneBackendFolder(directory);
        }
        return id;
    }

    /**
     * Remove locations that point at a backend which no longer exists in config —
     * e.g. a renamed/removed local backend. Per-backend orphan purge
     * (#purgeOrphanedPaths) only ever visits LIVE backends, so a doc referencing
     * ONLY a dead backend is never swept — its stale local paths linger and get
     * fed to consumers. This global sweep catches them.
     *
     * Safety: only local-grammar URLs are considered — `stored://` (authority IS
     * the backend) and `file://` (authority is a path placeholder, so we trust the
     * explicit metadata.backend). Remote copies (s3://, imap://, http://) are left
     * untouched. A backend that is merely DISABLED keeps its config, so
     * #isConfiguredLocalBackend stays true and its paths are preserved — only a
     * fully-removed backend (config gone) is treated as dead. If a doc loses its
     * last location, #reconcileRemovedLocations applies the configured policy.
     */
    async purgeDeadBackendLocations() {
        const db = this.#runtime.state.getDb();
        const fileDocs = await db.list({ features: { allOf: ['data/schema/file'] } }).catch(() => []);
        let swept = 0;
        for (const doc of fileDocs) {
            if (!Array.isArray(doc.locations) || doc.locations.length === 0) { continue; }
            const deadUrls = [];
            for (const loc of doc.locations) {
                const parsed = parseLocationUrl(loc.url);
                if (!parsed) { continue; }
                let backend;
                if (parsed.scheme === 'stored') { backend = parsed.backend; }
                else if (parsed.scheme === 'file') { backend = loc.metadata?.backend || null; }
                else { continue; } // remote scheme — not a local path, leave alone
                if (backend && !this.#runtime.backends.isConfiguredLocalBackend(backend)) { deadUrls.push(loc.url); }
            }
            if (deadUrls.length > 0) {
                await this.#reconcileRemovedLocations(doc, deadUrls);
                swept++;
            }
        }
        if (swept > 0) {
            this.#runtime.state.logger.info({ workspaceId: this.#runtime.state.workspaceId, docs: swept }, 'Resync: purged dead-backend locations');
        }
        return swept;
    }

    async upsertDocument(storedFile = {}) {
        return this.mutateDocuments(() => this.#upsertDocumentNow(storedFile));
    }

    mutateDocuments(operation) {
        const pending = this.#runtime.state.operations.run('documents.queued', () => this.#runtime.state.documentMutations.then(() =>
            this.#runtime.state.operations.run('documents.mutate', operation)));
        // A failed operation is reported to its caller; it must not prevent
        // unrelated subsequent events from being indexed.
        this.#runtime.state.documentMutations = pending.catch(() => {});
        return pending;
    }

    async #upsertDocumentNow(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;

        const meta = await this.#getMeta(storedFile);
        // Prefer Stored's canonical location list (single source of truth for the
        // stored:// grammar + native URLs); fall back to local synthesis only for
        // not-yet-indexed inputs.
        let backends = this.#resolveLocations(storedFile, meta, true);
        if (meta?.id) {
            const canonical = await this.#runtime.state.stored.locations(meta.id);
            if (canonical.length) backends = canonical;
        }
        const backendPaths = this.#buildBackendPaths(backends);
        if (backendPaths.length === 0) return null;

        const db = this.#runtime.state.getDb();
        const primaryChecksum = checksumArray[0];
        const prevChecksum = this.#buildChecksumArray(storedFile.previous?.checksums)[0];
        let existingDocument = await db.getByChecksumString(primaryChecksum);
        const replicas = this.#runtime.state.stored.replicas;
        const owners = (replicas?.ownersAt
            ? replicas.ownersAt(storedFile.backend, storedFile.key, 'workspace-document:')
            : replicas?.owners('workspace-document:'))?.filter(owner => owner.replicas.some(r =>
            r.mirror !== false && r.backend === storedFile.backend && r.key === storedFile.key)) || [];
        if (owners.length > 1) throw objectsError('Multiple document identities claim this replica', 'AMBIGUOUS_REPLICA', 409);
        let replacingContent = false;
        if (owners.length) {
            const owner = owners[0];
            const stable = await db.getDocument(Number(owner.owner.split(':')[1]));
            if (!stable) throw objectsError('Replica owner document is missing', 'DOCUMENT_MISSING', 409);
            const current = stable.checksumArray?.find(s => s.startsWith('sha256/'))?.replace('sha256/', 'sha256:');
            const incoming = primaryChecksum.replace('sha256/', 'sha256:');
            if (current !== incoming) {
                const predecessor = this.#buildChecksumArray(storedFile.previous?.checksums)[0]?.replace('sha256/', 'sha256:');
                const nextEdit = predecessor === current;
                // An old replica rescan must never roll a newer document back.
                if (incoming === owner.contentId && current !== owner.contentId && !nextEdit) return stable.id;
                if (current !== owner.contentId && !nextEdit) throw objectsError('A second replica changed before the first edit finished replicating', 'CONCURRENT_REPLICA_EDIT', 409);
                if (existingDocument && existingDocument.id !== stable.id) throw objectsError('Edited bytes already identify another document; identity reconciliation is required', 'CONTENT_ID_CONFLICT', 409);
                replacingContent = true;
            }
            existingDocument = stable;
        } else if (!existingDocument && prevChecksum && prevChecksum !== primaryChecksum) {
            const predecessor = await db.getByChecksumString(prevChecksum);
            // A file edited at its only address is still the same document.
            // Retained bytes provide recovery; a new row would reset its version,
            // break open readers/links and incorrectly send the old row to Trash.
            // Multiple independent locations mean a divergence: a new revision
            // gets its own ID and the original continues to identify old bytes.
            const locations = predecessor?.locations || [];
            if (locations.length && locations.every(location =>
                this.backendLocationKey(storedFile.backend, location) === storedFile.key)) {
                existingDocument = predecessor;
                replacingContent = true;
            }
        }
        const documentData = this.#buildDocument(storedFile, checksumArray, backends, existingDocument, meta);
        if (replacingContent) {
            documentData.checksumArray = checksumArray;
            documentData.metadata.previousContentId = existingDocument.checksumArray[0].replace('sha256/', 'sha256:');
        }
        // Stale-path cleanup is scoped to the backends tree: user-filed
        // placements live in other trees and must never be unlinked here.
        const currentBackendPaths = existingDocument?.id
            ? await db.listDocumentTreePaths(existingDocument.id, BACKENDS_TREE_NAME).catch(() => [])
            : [];

        const managedRoots = Object.keys(this.#runtime.state.dataBackends || {})
            .filter((name) => this.#runtime.state.stored.getBackend(name))
            .map((name) => this.#runtime.backends.getBackendRootPath(name)).filter(Boolean);
        for (const directory of currentBackendPaths) {
            if (!managedRoots.some((root) => directory === root || directory.startsWith(`${root}/`))
                && !backendPaths.includes(directory)) backendPaths.push(directory);
        }

        // A warm rescan still validates each file and repairs missing documents
        // and tree paths, but must not re-write identical docs (and re-trigger
        // hooks, embeddings and socket updates) for an unchanged library.
        if (!storedFile.previous && existingDocument?.id
            && Object.entries(documentData).every(([key, value]) =>
                isDeepStrictEqual(key === 'orphanedAt' ? existingDocument[key] ?? null : existingDocument[key], value))
            && isDeepStrictEqual([...currentBackendPaths].sort(), [...backendPaths].sort())) {
            return existingDocument.id;
        }

        const record = existingDocument?.id ? { ...documentData, id: existingDocument.id } : documentData;
        const spec = { context: null, directory: this.#runtime.state.getBackendsTreeSelector(backendPaths) };
        if (!replacingContent && prevChecksum && prevChecksum !== primaryChecksum) {
            const predecessor = await db.getByChecksumString(prevChecksum);
            if (predecessor?.id && predecessor.id !== existingDocument?.id) {
                return this.#writeSuccessor(predecessor, record, spec, storedFile,
                    currentBackendPaths.filter(p => !backendPaths.includes(p)), existingDocument?.version);
            }
        }
        const docId = await this.#runtime.state.put(
            record,
            // context:null keeps backend mirrors out of the context root — they
            // surface there only when a user files them explicitly.
            // No feature assertion: data/backend/* is DERIVED by synapsd from
            // locations[] (URL scheme+authority, or location.metadata.backend).
            spec,
        );

        await this.#removeStalePaths(docId, currentBackendPaths, backendPaths);

        return docId;
    }

    /**
     * Apply a location-set change (`object:move`, `object:location:add|remove`)
     * to the document behind the content. Identity is unchanged by definition —
     * the same bytes simply live somewhere else — so the document keeps its id,
     * its checksums and every curated placement it has been given.
     *
     * The stored layer suppresses its own watcher echoes for the keys it writes
     * and deletes during a transfer, so a move never also arrives here as an
     * unlink of the source path.
     *
     * `#upsertDocument` already rebuilds locations from stored's canonical list
     * and prunes stale backends-tree paths, which is exactly the required work.
     * It bails out when the target has no mirrored tree path (the managed blob
     * store is opaque by design) — in that case the locations are patched
     * directly, because a document must never keep pointing at a location the
     * object no longer has.
     */
    async applyLocationChange(payload = {}) {
        return this.mutateDocuments(async () => {
            const docId = await this.#upsertDocumentNow(payload);
            if (docId) return docId;
            return this.#patchDocumentLocations(payload);
        });
    }

    async #patchDocumentLocations(payload = {}) {
        const checksumArray = this.#buildChecksumArray(payload.checksums);
        if (checksumArray.length === 0) return null;

        const db = this.#runtime.state.getDb();
        const doc = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!doc?.id) return null;

        const locations = this.#mergeDocumentLocations(doc, Array.isArray(payload.locations) ? payload.locations : []);
        if (locations.length === 0) {
            // Nothing left to point at — hand over to the orphan path so the
            // orphanedAt stamp and retention semantics stay in one place.
            return this.#reconcileRemovedLocationsNow(doc, (doc.locations || []).map((l) => l.url), { notify: !String(payload.origin || '').startsWith('trash:') });
        }
        await this.#runtime.state.put({ id: doc.id, locations }, { context: null });
        return doc.id;
    }

    async unlinkDocument(storedFile = {}) {
        // Stored emits the predecessor unlink BEFORE the successor add.
        // The add migrates memberships and then reconciles the predecessor.
        if (storedFile.successor) return null;
        return this.mutateDocuments(() => this.#unlinkDocumentNow(storedFile));
    }

    async #unlinkDocumentNow(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;
        if (!storedFile.backend || !storedFile.key) return null;

        const db = this.#runtime.state.getDb();
        const existingDocument = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!existingDocument?.id) return null;

        // Reconcile both address forms for this backend/key: mounts carry the
        // device-scoped file:// URL, workspace stores the stored:// one (and
        // docs written before the single-location switch may carry both).
        const removedUrls = [`stored://${storedFile.backend}/${storedFile.key}`];
        const twin = this.#runtime.backends.deviceFileLocationUrl(storedFile.backend, storedFile.key);
        if (twin) removedUrls.push(twin);
        return this.#reconcileRemovedLocationsNow(existingDocument, removedUrls, { suppressPolicy: Boolean(storedFile.origin), manualRemoval: String(storedFile.origin || '').startsWith('backend-delete:'), keepDocument: String(storedFile.origin || '').startsWith('backend-delete:keep:'), notify: !/^(trash:|replica:|workspace-directory:)/.test(storedFile.origin || '') });
    }

    /**
     * Public entry for other services (connector deletion-sync): drop the
     * given location URLs from a document, with the configured last-location
     * semantics of #reconcileRemovedLocations below.
     */
    async reconcileRemovedLocations(doc, removedUrls = [], options = {}) {
        return this.#reconcileRemovedLocations(doc, removedUrls, options);
    }

    /**
     * A backing blob vanished from one or more locations. Drop those locations;
     * the doc keeps its survivors and unticks only the backends-tree path(s) the
     * dead locations backed. With no survivors, remove the index row by default.
     * With onLocationsRemoved, durable Workspace Trash owns source-loss
     * lifecycle and no orphan is automatically purged; without it the
     * configured orphanPolicy applies. Never infer absence from an incomplete scan.
     */
    async #reconcileRemovedLocations(doc, removedUrls = [], options = {}) {
        return this.mutateDocuments(() => this.#reconcileRemovedLocationsNow(doc, removedUrls, options));
    }

    async #reconcileRemovedLocationsNow(doc, removedUrls = [], options = {}) {
        const db = this.#runtime.state.getDb();
        // Scan snapshots and connector events may carry an older location set.
        if (typeof db.getDocument === 'function') {
            doc = await db.getDocument(doc.id);
            if (!doc) return null;
        }
        const removed = new Set(removedUrls);
        const remaining = (Array.isArray(doc.locations) ? doc.locations : []).filter((l) => !removed.has(l.url));
        if (remaining.length === (doc.locations || []).length) return doc.id;
        const currentBackendPaths = await db.listDocumentTreePaths(doc.id, BACKENDS_TREE_NAME).catch(() => []);

        // Persist removal intent before changing locations, so restart can finish
        // an interrupted observation without losing its provenance.
        const operations = options.notify === false ? [] : await this.#runtime.state.onLocationsRemoved?.({
            document: doc, removedLocations: doc.locations.filter(l => removed.has(l.url)),
            remainingLocations: remaining, ...options,
        }) || [];
        const ready = async () => { await this.#runtime.state.onRemovalReady?.(operations); return doc.id; };
        if (remaining.length === 0) {
            const policy = options.keepDocument === true || this.#runtime.state.onLocationsRemoved ? 'keep' : this.#runtime.state.stored.replicas?.owner(`workspace-document:${doc.id}`) ? 'keep' : this.#runtime.state.getOrphanPolicy?.() ?? 'remove';
            if (policy === 'remove') {
                await db.delete(doc.id);
                await this.#index.purgeThumbnails([doc]).catch(() => {});
                return doc.id;
            }
            await this.#runtime.state.put({
                id: doc.id,
                locations: [],
                orphanedAt: doc.orphanedAt || new Date().toISOString(),
                metadata: { ...(doc.metadata || {}) },
            }, { context: null, emitEvent: false });
            // Backend-mirror paths untick (the file is no longer there); curated
            // placements in every other tree stay untouched. Thumbnails stay too
            // (checksum-keyed) — the GC purges them with the doc.
            await this.#removeStalePaths(doc.id, currentBackendPaths, []);
            return ready();
        }

        const survivors = remaining.map(l => this.#runtime.transfers.locationEndpoint(l)).filter(Boolean);
        // Capture the old roots before put: a DB adapter can update the same
        // document instance in place, replacing its locations array.
        const affectedRoots = [...new Set(doc.locations.filter(l => removed.has(l.url))
            .map(l => this.#runtime.backends.getBackendRootPath(l.metadata?.backend || parseLocationUrl(l.url)?.backend)).filter(Boolean))];
        await this.#runtime.state.put({ id: doc.id, locations: remaining }, { context: null, emitEvent: false });
        const preserved = currentBackendPaths.filter(p => !affectedRoots.some(root => p === root || p.startsWith(`${root}/`)));
        await this.#removeStalePaths(doc.id, currentBackendPaths, [...preserved, ...this.#buildBackendPaths(survivors)]);
        return ready();
    }

    /**
     * Purge orphaned documents (feature/orphaned) whose orphanedAt exceeds the
     * retention window. retentionDays 0 purges all current orphans; negative
     * retention never purges (the default). Explicit user cleanup can also just
     * bulk-delete via the feature/orphaned filter.
     */
    async gcOrphanedDocuments(options = {}) {
        return this.mutateDocuments(() => this.#gcOrphanedDocumentsNow(options));
    }

    async #gcOrphanedDocumentsNow({ retentionDays } = {}) {
        // Source-loss Trash is manually purged; orphan GC cannot bypass it.
        if (this.#runtime.state.onLocationsRemoved) return { purged: 0 };
        const db = this.#runtime.state.getDb();
        const days = Number.isFinite(retentionDays)
            ? retentionDays
            : (typeof this.#runtime.state.getOrphanRetentionDays === 'function' ? this.#runtime.state.getOrphanRetentionDays() : -1);
        if (!Number.isFinite(days) || days < 0) return { purged: 0 };

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const orphans = await db.list({ features: { allOf: [ORPHANED_FEATURE] } }).catch(() => []);
        let purged = 0;
        for (let doc of orphans) {
            if (typeof db.getDocument === 'function') doc = await db.getDocument(doc.id);
            if (!doc) continue;
            const orphanedAt = doc.orphanedAt ? Date.parse(doc.orphanedAt) : NaN;
            if (!Number.isFinite(orphanedAt) || orphanedAt > cutoff) continue;
            // Belt-and-braces: never GC a doc that somehow regained locations.
            if (Array.isArray(doc.locations) && doc.locations.length > 0) continue;
            await db.delete(doc.id);
            await this.#index.purgeThumbnails([doc]).catch(() => {});
            purged += 1;
        }
        if (purged > 0) {
            this.#runtime.state.logger.info({ workspaceId: this.#runtime.state.workspaceId, purged, retentionDays: days }, 'Orphan GC: purged expired orphaned documents');
        }
        return { purged };
    }

    async #removeStalePaths(docId, currentPaths = [], nextPaths = []) {
        const stalePaths = currentPaths.filter((p) => !nextPaths.includes(p));
        for (const directory of stalePaths) {
            await this.#runtime.state.unlink(docId, { directory: this.#runtime.state.getBackendsTreeSelector(directory) });
            // The folder may have just lost its last file: drop the empty shell
            // (and its now-empty parents) so the tree follows the disk. A burst
            // of deletes is reconciled concurrently, so two last documents can
            // each still see the other — the settle-time re-prune closes that.
            await this.#pruneBackendFolder(directory);
            this.#schedulePruneBackendFolder(directory);
        }
    }

    async #pruneBackendFolder(directory) {
        if (typeof this.#runtime.state.pruneBackendPath !== 'function') return 0;
        try {
            return await this.#runtime.state.pruneBackendPath(directory);
        } catch (error) {
            this.#runtime.state.logger.debug?.({ workspaceId: this.#runtime.state.workspaceId, directory, error: error.message }, 'Backend folder prune failed');
            return 0;
        }
    }

    #schedulePruneBackendFolder(directory, delayMs = 2000) {
        if (typeof this.#runtime.state.pruneBackendPath !== 'function') return;
        clearTimeout(this.#runtime.state.prunePending.get(directory));
        const timer = setTimeout(() => {
            this.#runtime.state.prunePending.delete(directory);
            this.#pruneBackendFolder(directory).catch(() => {});
        }, delayMs);
        timer.unref?.();
        this.#runtime.state.prunePending.set(directory, timer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Builders
    // ─────────────────────────────────────────────────────────────────────────

    async #getMeta(storedFile = {}) {
        if (!this.#runtime.state.stored) return null;
        if (storedFile.id && await this.#runtime.state.stored.has(storedFile.id)) return this.#runtime.state.stored.stat(storedFile.id);
        if (storedFile.backend && storedFile.key) return this.#runtime.state.stored.stat(`${storedFile.backend}:${storedFile.key}`);
        return null;
    }

    #resolveLocations(storedFile = {}, meta = null, allowFallback = true) {
        if (Array.isArray(storedFile.locations) && storedFile.locations.length > 0) return storedFile.locations;
        if (Array.isArray(meta?.locations) && meta.locations.length > 0) return meta.locations;
        return allowFallback && storedFile.backend && storedFile.key
            ? [this.#buildLocation(storedFile.backend, storedFile.key)]
            : [];
    }

    #buildLocation(backendName, key) {
        const backend = this.#runtime.state.stored?.getBackend(backendName);
        const config = backend?.config || {};
        const [providerHint, ...accountHintParts] = String(backendName || '').split(':').filter(Boolean);

        return {
            backend: backendName,
            driver: config.driver || null,
            key,
            synced: true,
            source: {
                provider: config.provider || providerHint || config.driver || 'unknown',
                account: config.account || (accountHintParts.length > 0 ? accountHintParts.join(':') : (providerHint || backendName || 'default')),
                container: config.container || config.bucket || config.share || config.folder || (config.root ? path.basename(path.resolve(config.root)) : 'root'),
                path: key,
            },
        };
    }

    #buildChecksumArray(checksums = {}) {
        return Object.entries(checksums || {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
            .sort(([a], [b]) => {
                const ia = CHECKSUM_PRIORITY.indexOf(a);
                const ib = CHECKSUM_PRIORITY.indexOf(b);
                return (ia === -1 ? CHECKSUM_PRIORITY.length : ia) - (ib === -1 ? CHECKSUM_PRIORITY.length : ib) || a.localeCompare(b);
            })
            .map(([algorithm, hash]) => `${algorithm}/${hash}`);
    }

    #buildBackendPaths(backends = []) {
        return Array.from(new Set(
            backends
                .filter(Boolean)
                .map((backend) => {
                    const root = this.#runtime.backends.getBackendRootPath(backend.backend);
                    if (!root) return null;
                    const filePath = backend?.source?.path || backend?.key || '';
                    const dir = filePath ? path.dirname(filePath) : null;
                    const suffix = (dir && dir !== '.') ? `/${dir}` : '';
                    return `${root}${suffix}`;
                })
                .filter(Boolean)
        ));
    }


    // File bytes are content-addressed; the document ID survives in-place
    // edits. Bytes live in `stored` (canonical stored:// URLs), and size/mime are
    // doc-level invariants. No inline `data`, no duplicated backend descriptors —
    // anything else is derivable from the URL via `stored`.
    #buildDocument(storedFile = {}, checksumArray = [], backends = [], existingDocument = null, meta = null) {
        const size = Number.isFinite(storedFile.size) ? storedFile.size : existingDocument?.metadata?.size;
        const locations = this.#mergeDocumentLocations(existingDocument, backends);
        // Fall back to a filename-derived mime when `stored` didn't detect one
        // (filesystem-indexed files often have no sniffed mime) — otherwise the
        // File doc defaults to 'application/json' and images never get classified
        // or embedded.
        const mime = storedFile.mimeType || existingDocument?.metadata?.contentType || mimeFromLocations(locations);

        const metadata = { ...(existingDocument?.metadata || {}) };
        if (Number.isFinite(size)) metadata.size = size; else delete metadata.size;
        if (typeof mime === 'string' && mime.length > 0) metadata.contentType = mime;

        // Keep checksum provenance for edits; a divergent successor also gets
        // a derived-from relation to the predecessor document in the upsert.
        const prevChecksum = storedFile.previous?.checksums
            ? this.#buildChecksumArray(storedFile.previous.checksums)[0]
            : null;
        if (prevChecksum) metadata.derivedFrom = prevChecksum;

        // Inline-extracted metadata (EXIF/GPS/dimensions/media, and the searchable
        // head of a text blob) lives on the stored index entry's `custom`
        // (surfaced via stat → meta). Merge the known keys onto the doc (metadata
        // is .catchall(z.any()) so nested objects are fine).
        const extracted = meta?.custom && typeof meta.custom === 'object' ? meta.custom : null;
        if (extracted) {
            for (const k of ['exif', 'dimensions', 'media', 'text']) {
                if (extracted[k] && typeof extracted[k] === 'object') { metadata[k] = extracted[k]; }
            }
        }
        // Geo is provenance-ranked rather than overwritten: re-upserting a file
        // whose pin a human fixed by hand must not silently revert it to the
        // camera's fix. Runs even without `extracted` so sentinel coordinates
        // ({lat:null,lon:null} -> Null Island) get dropped instead of indexed.
        const geo = pickGeo(metadata.geo, extracted?.geo, { incomingSource: 'exif' });
        if (geo) { metadata.geo = geo; } else { delete metadata.geo; }

        // A rescan changes locations, not curated data or asserted relations.
        // This includes imported records: update() replaces data wholesale.
        const doc = {
            // Schema-bearing updates are parsed as full documents by SynapsD;
            // carry the existing fields to avoid constructor defaults clearing
            // comments or resetting creation dates during location repair.
            ...(existingDocument?.toJSON?.() || existingDocument || {}),
            schema: existingDocument?.schema || 'data/schema/file',
            checksumArray: [...new Set([...checksumArray, ...(existingDocument?.checksumArray || [])])],
            data: existingDocument?.data || {},
            locations,
            metadata,
            // Locations exist by construction here — clear any orphan marker.
            orphanedAt: null,
            features: Array.isArray(existingDocument?.features) ? existingDocument.features : [],
        };

        // Content-derived date (EXIF capture time) → the default 'content' timeline
        // (distinct from crud lifecycle). Preserve any existing timelines.
        const capturedAt = extracted?.exif?.capturedAt;
        if (capturedAt) {
            const prior = Array.isArray(existingDocument?.timelines) ? existingDocument.timelines : [];
            const hasContent = prior.some(t => (t.timeline || t.name) === 'content');
            doc.timelines = hasContent ? prior : [...prior, { timeline: 'content', start: capturedAt }];
        } else if (Array.isArray(existingDocument?.timelines) && existingDocument.timelines.length) {
            doc.timelines = existingDocument.timelines;
        }

        return doc;
    }

    #mergeDocumentLocations(doc, backends) {
        const next = this.#buildDocumentLocations(backends);
        const urls = new Set(next.map((l) => l.url));
        for (const location of doc?.locations || []) {
            const endpoint = this.#runtime.transfers.locationEndpoint(location);
            // Stored's canonical list only describes its enabled backends.
            // It cannot retract IMAP/web/foreign-device or disabled locations.
            if ((!endpoint || !this.#runtime.state.stored.getBackend(endpoint.backend)) && !urls.has(location.url)) {
                next.push(location);
                urls.add(location.url);
            }
        }
        return next;
    }

    #buildDocumentLocations(backends = []) {
        const seen = new Set();
        const locations = [];
        for (const backend of backends) {
            if (!backend?.key) continue;
            // Device-anchored fs mounts get file://<deviceId>/<abs-path> as their
            // ONLY location: it survives a workspace move (a stored:// address is
            // meaningful only on this server instance) and feeds the device/id/*
            // presence bitmaps. metadata.backend ties it to its owning backend
            // for orphan/dead-backend sweeps. stored:// stays reserved for
            // workspace-anchored stores (workspace:home, workspace:data).
            const deviceUrl = this.#runtime.backends.deviceFileLocationUrl(backend.backend, backend.key);
            if (deviceUrl) {
                if (!seen.has(deviceUrl)) {
                    seen.add(deviceUrl);
                    locations.push({ url: deviceUrl, metadata: { backend: backend.backend } });
                }
                continue;
            }
            const url = backend.url || `stored://${backend.backend}/${backend.key}`;
            if (seen.has(url)) continue;
            seen.add(url);
            // Surface the real protocol URL for remote backends (https/smb/s3/imap).
            // Local fs paths are kept server-side only (stored:// is the address).
            locations.push(backend.nativeUrl && backend.driver !== 'file'
                ? { url, nativeUrl: backend.nativeUrl }
                : { url });
        }
        return locations;
    }
}
