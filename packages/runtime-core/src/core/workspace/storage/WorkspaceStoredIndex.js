import path from 'path';
import Stored from 'canvas-stored';
import OperationMonitor from '../runtime/OperationMonitor.js';
import { HOME_STORED_BACKEND, DATA_BLOB_BACKEND, NUDGE_THROTTLE_MS, RETENTION_DAYS } from './index/contracts.js';
import { createIndexState } from './index/state.js';
import Transfers from './index/Transfers.js';
import Objects from './index/Objects.js';
import ReplicaTracking from './index/ReplicaTracking.js';
import Backends from './index/Backends.js';
import Rescan from './index/Rescan.js';
import DocumentProjection from './index/DocumentProjection.js';
import Content from './index/Content.js';
import Thumbnails from './index/Thumbnails.js';

export { normalizeObjectKey } from './index/contracts.js';

// Storage adapter lifecycle, events and public API. Indexing and byte operations
// are collaborators with explicit access to the adapter's runtime state.
export class WorkspaceStoredIndex {
    #runtime;

    static HOME_STORED_BACKEND = HOME_STORED_BACKEND;
    static DATA_BLOB_BACKEND = DATA_BLOB_BACKEND;

    constructor({ rootPath, cachePath, dataPath, homePath, storedRootPath, internalPaths = [], dataBackends = {}, workspaceId, device = null, logger, put, unlink, getBackendsTreeSelector, getDb, describeImapLocation = null, destroyImapLocation = null, lockBackendNode = null, unlockBackendNode = null, insertBackendPath = null, moveBackendPath = null, pruneBackendPath = null, sweepBackendPaths = null, onResyncStateChange = null, persistBackendConfig = null, getOrphanRetentionDays = null, getOrphanPolicy = null, onBackendChanged = null, policyDirectoryMove = null, policyRemove = null, onLocationsRemoved = null, onRemovalReady = null, replicaOwnerGuard = null }) {
        this.#runtime = { state: createIndexState() };
        this.#runtime.transfers = new Transfers(this, this.#runtime);
        this.#runtime.objects = new Objects(this, this.#runtime);
        this.#runtime.replicas = new ReplicaTracking(this, this.#runtime);
        this.#runtime.backends = new Backends(this, this.#runtime);
        this.#runtime.scans = new Rescan(this, this.#runtime);
        this.#runtime.projection = new DocumentProjection(this, this.#runtime);
        this.#runtime.content = new Content(this, this.#runtime);
        this.#runtime.thumbnails = new Thumbnails(this, this.#runtime);

        if (!dataPath || !homePath) throw new Error('dataPath and homePath are required');
        if (!put || !unlink || !getBackendsTreeSelector || !getDb) throw new Error('put, unlink, getBackendsTreeSelector, getDb are required');

        this.#runtime.state.rootPath = rootPath || path.dirname(dataPath);
        this.#runtime.state.cachePath = cachePath || path.join(this.#runtime.state.rootPath, 'cache');
        this.#runtime.state.dataPath = dataPath;
        this.#runtime.state.homePath = homePath;
        this.#runtime.state.storedRootPath = storedRootPath || path.join(this.#runtime.state.rootPath, 'db', 'stored');
        this.#runtime.state.internalPaths = [
            ...new Set([this.#runtime.state.cachePath, this.#runtime.state.dataPath, this.#runtime.state.storedRootPath, ...internalPaths]
                .filter(Boolean).map((p) => path.resolve(p))),
        ];
        this.#runtime.state.dataBackends = dataBackends;
        this.#runtime.state.workspaceId = workspaceId;
        this.#runtime.state.device = device;
        this.#runtime.state.logger = logger || console;
        this.#runtime.state.operations = new OperationMonitor(report => this.#runtime.state.logger.warn(
            { workspaceId: this.#runtime.state.workspaceId, ...report }, 'Workspace storage operations still pending'));
        this.#runtime.state.put = put;
        this.#runtime.state.unlink = unlink;
        this.#runtime.state.getBackendsTreeSelector = getBackendsTreeSelector;
        this.#runtime.state.getDb = getDb;
        this.#runtime.state.policyDirectoryMove = policyDirectoryMove;
        this.#runtime.state.policyRemove = policyRemove;
        this.#runtime.state.describeImapLocation = describeImapLocation;
        this.#runtime.state.destroyImapLocation = destroyImapLocation;
        this.#runtime.state.lockBackendNode = lockBackendNode;
        this.#runtime.state.unlockBackendNode = unlockBackendNode;
        this.#runtime.state.insertBackendPath = insertBackendPath;
        this.#runtime.state.moveBackendPath = moveBackendPath;
        this.#runtime.state.pruneBackendPath = pruneBackendPath;
        this.#runtime.state.sweepBackendPaths = sweepBackendPaths;
        this.#runtime.state.onResyncStateChange = onResyncStateChange;
        this.#runtime.state.persistBackendConfig = persistBackendConfig;
        this.#runtime.state.getOrphanRetentionDays = getOrphanRetentionDays;
        this.#runtime.state.getOrphanPolicy = getOrphanPolicy;
        this.#runtime.state.onLocationsRemoved = onLocationsRemoved;
        this.#runtime.state.onRemovalReady = onRemovalReady;
        this.#runtime.state.replicaOwnerGuard = replicaOwnerGuard;
        this.#runtime.state.onBackendChanged = typeof onBackendChanged === 'function' ? onBackendChanged : null;
    }

    get isRunning() {
        return this.#runtime.state.stored !== null;
    }

    // Shared Stored instance — consumed by the per-workspace mail service to
    // register/run imap backends and bind their object:* events.
    get stored() {
        return this.#runtime.state.stored;
    }

    getBackendStatus(backendName) {
        const backend = this.#runtime.state.stored?.getBackend(backendName);
        const status = this.#runtime.state.backendStatus.get(backendName) || {};
        return {
            ...status,
            running: !!backend,
            watching: backend?.watching || false,
            // Network mount (NFS/CIFS/sshfs/…) detected from the kernel mount
            // table by the file driver, or declared in config. The UI badges it
            // and clients can warn before triggering an expensive full resync.
            remote: backend?.remote === true,
            transport: backend?.transport || null,
        };
    }

    #nudge(entry) {
        if (!this.#runtime.state.onBackendChanged || !entry?.backend) return;
        const backend = entry.backend;
        let state = this.#runtime.state.changeNudges.get(backend);
        if (!state) { state = { timer: null, pending: null }; this.#runtime.state.changeNudges.set(backend, state); }
        if (state.timer) { state.pending = entry.seq; return; }
        this.#emitNudge(backend, entry.seq);
        state.timer = setTimeout(() => {
            state.timer = null;
            if (state.pending != null) {
                const seq = state.pending;
                state.pending = null;
                this.#emitNudge(backend, seq);
            }
        }, NUDGE_THROTTLE_MS);
        state.timer.unref?.();
    }

    #emitNudge(backend, seq) {
        try { this.#runtime.state.onBackendChanged({ backend, seq }); }
        catch (error) { this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend, error: error.message }, 'backend.changed listener failed'); }
    }

    async start() {
        if (this.#runtime.state.stored) return;

        try {
            this.#runtime.state.stored = new Stored({
                // Configured runtime root (default db/stored) — NOT a hidden
                // .stored/. Holds Stored's metadata index; the blob cache is
                // redirected to the workspace cache dir (services.stored.cache).
                root: this.#runtime.state.storedRootPath,
                cache: { path: this.#runtime.state.cachePath },
                checksums: ['sha256'],
                primaryChecksum: 'sha256',
                onStall: report => this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, ...report }, 'Stored mutation still pending'),
                replication: { captureAllWrites: true, ownerGuard: this.#runtime.state.replicaOwnerGuard },
                // Inline metadata extraction at ingest (EXIF/GPS/dimensions/media).
                // Graceful + optional: no-ops if parser deps are absent. Disable
                // with CANVAS_EXTRACT_DISABLED=true.
                extract: null, // Deep extraction runs only after filing, in resolveEmbeddingInput.
                // Displaced-blob retention (docs/durable-workspaces.md): bytes an
                // overwrite/delete replaces on a path backend stay recoverable
                // for this many days (0 = off). The primary's only versioning;
                // longer history is the backup system's job.
                retention: RETENTION_DAYS > 0 ? { days: RETENTION_DAYS } : null,
            });

            await this.#runtime.state.operations.run('start.backends', () => this.#runtime.backends.registerConfiguredBackends());

            this.#bindEvents();
            // Workspace launches background catch-up after becoming active.
            // Keep chokidar's ignoreInitial watcher running: scans reconcile the
            // snapshot while the watcher continues to capture live edits.
        } catch (error) {
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: error.message }, 'Stored home indexing unavailable');
            await this.stop();
        }
    }


    async stop() {
        for (const name of this.#runtime.state.resyncing) this.#runtime.state.resyncCancels.add(name);
        await Promise.allSettled([...this.#runtime.state.backgroundResyncs]);
        await Promise.all([...this.#runtime.state.backendNamespaces.values()]);
        for (const timer of this.#runtime.state.prunePending.values()) clearTimeout(timer);
        this.#runtime.state.prunePending.clear();
        this.#unbindEvents();
        await this.#runtime.state.documentMutations;
        if (!this.#runtime.state.stored) return;

        try {
            await this.#runtime.state.stored.stop();
        } catch (error) {
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: error.message }, 'Failed to stop stored home indexing');
        } finally {
            this.#runtime.state.stored = null;
            this.#runtime.state.backendStatus.clear();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event binding
    // ─────────────────────────────────────────────────────────────────────────

    #bindEvents() {
        this.#unbindEvents();
        if (!this.#runtime.state.stored?.on) return;

        // Generic object:* events from all backends; this index handles file
        // objects only — imap messages (kind:'message') + backend:state are
        // consumed by the mail service, which binds its own listeners.
        const dispatch = (payload) => {
            if (payload?.kind === 'message') return; // handled by the mail service
            const promise = this.#runtime.projection.upsertDocument(payload); // kind 'file' (or legacy)
            if (payload?.backend && payload?.key) this.#runtime.objects.trackUpsert(`${payload.backend}:${payload.key}`, promise);
            return promise;
        };
        const eventMap = {
            'object:add': dispatch,
            'object:change': dispatch,
            'object:unlink': (payload) => this.#runtime.projection.unlinkDocument(payload),
            // Location mutations that preserve content identity (copy/move
            // between backends, cache eviction). These MUST be patched in
            // place: routing them through unlink+add would drop the document's
            // curated tree placements and rebuild it under a new id.
            'object:move': (payload) => {
                const promise = this.#runtime.projection.applyLocationChange(payload);
                if (payload?.to?.backend && payload?.to?.key) this.#runtime.objects.trackUpsert(`${payload.to.backend}:${payload.to.key}`, promise);
                return promise;
            },
            'object:location:add': (payload) => this.#runtime.projection.applyLocationChange(payload),
            'object:location:remove': (payload) => this.#runtime.projection.applyLocationChange(payload),
            // Change-log advance → throttled `backend.changed` nudge.
            'change': (entry) => this.#nudge(entry),
        };

        this.#runtime.state.listeners = Object.entries(eventMap).map(([eventName, handler]) => {
            const listener = async (payload = {}) => {
                try {
                    await handler(payload);
                } catch (error) {
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, eventName, error: error.message }, 'Stored file sync failed');
                }
            };
            this.#runtime.state.stored.on(eventName, listener);
            return { eventName, listener };
        });
    }

    #unbindEvents() {
        if (!this.#runtime.state.stored?.off) {
            this.#runtime.state.listeners = [];
            return;
        }
        for (const { eventName, listener } of this.#runtime.state.listeners) {
            this.#runtime.state.stored.off(eventName, listener);
        }
        this.#runtime.state.listeners = [];
    }

    locationEndpoints(...args) { return this.#runtime.transfers.locationEndpoints(...args); }
    readableLocationEndpoints(...args) { return this.#runtime.transfers.readableLocationEndpoints(...args); }
    transferDocument(...args) { return this.#runtime.transfers.transferDocument(...args); }
    locationUrlsOnBackends(...args) { return this.#runtime.transfers.locationUrlsOnBackends(...args); }
    deleteLocations(...args) { return this.#runtime.transfers.deleteLocations(...args); }
    copyObject(...args) { return this.#runtime.transfers.copyObject(...args); }
    moveObject(...args) { return this.#runtime.transfers.moveObject(...args); }
    withKeyLock(...args) { return this.#runtime.objects.withKeyLock(...args); }
    withKeysLock(...args) { return this.#runtime.objects.withKeysLock(...args); }
    recordReplicaApplied(...args) { return this.#runtime.replicas.recordReplicaApplied(...args); }
    replicaVersion(...args) { return this.#runtime.replicas.replicaVersion(...args); }
    forgetReplica(...args) { return this.#runtime.replicas.forgetReplica(...args); }
    replicaProtection(...args) { return this.#runtime.replicas.replicaProtection(...args); }
    writeObject(...args) { return this.#runtime.objects.writeObject(...args); }
    removeObject(...args) { return this.#runtime.objects.removeObject(...args); }
    listRetained(...args) { return this.#runtime.objects.listRetained(...args); }
    restoreRetained(...args) { return this.#runtime.objects.restoreRetained(...args); }
    get retention() { return this.#runtime.objects.retention; }
    listTrash(...args) { return this.#runtime.objects.listTrash(...args); }
    restoreTrash(...args) { return this.#runtime.objects.restoreTrash(...args); }
    discardTrash(...args) { return this.#runtime.objects.discardTrash(...args); }
    renameObject(...args) { return this.#runtime.objects.renameObject(...args); }
    statObject(...args) { return this.#runtime.objects.statObject(...args); }
    listObjects(...args) { return this.#runtime.objects.listObjects(...args); }
    changes(...args) { return this.#runtime.objects.changes(...args); }
    resolveObject(...args) { return this.#runtime.objects.resolveObject(...args); }
    getBackendTreeRoot(...args) { return this.#runtime.backends.getBackendTreeRoot(...args); }
    createBackendContainer(...args) { return this.#runtime.backends.createBackendContainer(...args); }
    deleteBackendContainer(...args) { return this.#runtime.backends.deleteBackendContainer(...args); }
    renameBackendContainer(...args) { return this.#runtime.backends.renameBackendContainer(...args); }
    resyncInBackground(...args) { return this.#runtime.scans.resyncInBackground(...args); }
    cancelResync(...args) { return this.#runtime.scans.cancelResync(...args); }
    resync(...args) { return this.#runtime.scans.resync(...args); }
    getBackendDiskUsage(...args) { return this.#runtime.backends.getBackendDiskUsage(...args); }
    persistBlob(...args) { return this.#runtime.content.persistBlob(...args); }
    statBlobByChecksum(...args) { return this.#runtime.content.statBlobByChecksum(...args); }
    applyBackendConfig(...args) { return this.#runtime.backends.applyBackendConfig(...args); }
    getEffectiveExclusions(...args) { return this.#runtime.backends.getEffectiveExclusions(...args); }
    deleteStoredUrl(...args) { return this.#runtime.backends.deleteStoredUrl(...args); }
    reconcileRemovedLocations(...args) { return this.#runtime.projection.reconcileRemovedLocations(...args); }
    gcOrphanedDocuments(...args) { return this.#runtime.projection.gcOrphanedDocuments(...args); }
    resolve(...args) { return this.#runtime.content.resolve(...args); }
    static THUMBNAIL_SIZES = [128, 256, 512, 1024];
    getThumbnail(...args) { return this.#runtime.thumbnails.getThumbnail(...args); }
    static PDF_THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;
    static PDF_THUMBNAIL_TIMEOUT_MS = 20_000;
    purgeThumbnails(...args) { return this.#runtime.thumbnails.purgeThumbnails(...args); }
    clearThumbnailCache(...args) { return this.#runtime.thumbnails.clearThumbnailCache(...args); }
    describeLocations(...args) { return this.#runtime.content.describeLocations(...args); }
    destroy(...args) { return this.#runtime.content.destroy(...args); }
    resolveBackendForTreePath(...args) { return this.#runtime.backends.resolveBackendForTreePath(...args); }
    getBackendRootPath(...args) { return this.#runtime.backends.getBackendRootPath(...args); }
}
