import { setImmediate as yieldToIO } from 'node:timers/promises';
import { HOME_STORED_BACKEND } from './contracts.js';

export default class Rescan {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    // A rescan's absence decisions and a directory move must observe the same
    // namespace. Reserve the slot synchronously, including queued operations.
    async acquireBackendNamespace(backendName) {
        const prior = this.#runtime.state.backendNamespaces.get(backendName) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        this.#runtime.state.backendNamespaces.set(backendName, current);
        await prior;
        return () => {
            if (this.#runtime.state.backendNamespaces.get(backendName) === current) this.#runtime.state.backendNamespaces.delete(backendName);
            release();
        };
    }

    /**
     * Launch a resync without blocking the caller. Validation errors are thrown
     * synchronously; the (potentially slow) scan runs in the background and its
     * outcome is recorded in the backend status (queryable via getBackendStatus).
     */
    resyncInBackground(backendName = HOME_STORED_BACKEND) {
        this.#runtime.backends.assertResyncable(backendName);
        if (this.#runtime.state.resyncing.has(backendName)) {
            return { backend: backendName, started: false, alreadyRunning: true };
        }
        const task = this.#index.resync(backendName).catch((error) => {
            this.#runtime.backends.setBackendError(backendName, error);
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, error: error.message }, 'Background resync failed');
        });
        this.#runtime.state.backgroundResyncs.add(task);
        void task.finally(() => this.#runtime.state.backgroundResyncs.delete(task));
        return { backend: backendName, started: true, resyncing: true };
    }

    /**
     * Request cancellation of an in-flight resync. The walk stops at the next
     * file boundary. Nothing is reconciled from the partial snapshot (no
     * orphaning), and already-indexed files stay indexed — a later resync
     * resumes cheaply via the checksum cache, so cancel + re-run ≈ pause.
     */
    cancelResync(backendName = HOME_STORED_BACKEND) {
        if (!this.#runtime.state.resyncing.has(backendName)) {
            return { backend: backendName, resyncing: false, cancelled: false };
        }
        this.#runtime.state.resyncCancels.add(backendName);
        return { backend: backendName, cancelRequested: true };
    }

    async resync(backendName = HOME_STORED_BACKEND) {
        this.#runtime.backends.assertResyncable(backendName);

        // Re-entrancy guard: a resync of the same backend already in flight must
        // not be duplicated (the scan is expensive and writes are not idempotent
        // under concurrency).
        if (this.#runtime.state.resyncing.has(backendName)) {
            return { backend: backendName, count: null, alreadyRunning: true };
        }
        this.#runtime.state.resyncCancels.delete(backendName);
        this.#runtime.state.resyncing.add(backendName);
        this.#patchResyncState(backendName, {
            resyncing: true,
            resyncStartedAt: new Date().toISOString(),
            progress: { scanned: 0, total: null },
        });

        const releaseNamespace = await this.acquireBackendNamespace(backendName);
        try {
            // Liveness gate: an absent mountpoint or a different filesystem at
            // the root scans as "empty", which a differ would read as "all
            // deleted". Verify the root (and its fsid snapshot from mount
            // creation) BEFORE touching anything; on failure the backend goes
            // offline and nothing is removed — stale is a state, not a deletion.
            const backend = this.#runtime.state.stored.getBackend(backendName);
            const config = this.#runtime.state.dataBackends[backendName] || {};
            const portableRoot = this.#runtime.backends.isWorkspaceOwnedRoot(backendName, config);
            if (typeof backend?.verifyRoot === 'function') {
                const liveness = await backend.verifyRoot(portableRoot ? null : config.fsid || null);
                if (!liveness.ok) {
                    this.#patchResyncState(backendName, {
                        offline: true,
                        lastError: `mount unavailable (${liveness.reason})`,
                    });
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, reason: liveness.reason }, 'Resync skipped: backend root failed liveness check');
                    return { backend: backendName, ok: false, offline: true, reason: liveness.reason };
                }
                this.#patchResyncState(backendName, { offline: false }, { quiet: true });
                // First successful verify: snapshot the filesystem identity into
                // the mount config so later resyncs can tell "unmounted" from
                // "emptied".
                if (!portableRoot && !config.fsid && liveness.fsid && typeof this.#runtime.state.persistBackendConfig === 'function') {
                    this.#runtime.state.dataBackends = { ...this.#runtime.state.dataBackends, [backendName]: { ...config, fsid: liveness.fsid } };
                    await Promise.resolve(this.#runtime.state.persistBackendConfig(backendName, { fsid: liveness.fsid })).catch((err) =>
                        this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, error: err.message }, 'Failed to persist mount fsid snapshot'));
                }
            }

            // Structural pre-pass: mirror the folder skeleton into the backends
            // tree and size the progress bar — readdir only, so even a large
            // network mount shows its subtree within seconds while checksums
            // stream in behind it.
            const total = await this.#mirrorBackendShape(backendName);
            if (total !== null) this.#patchResyncState(backendName, { progress: { scanned: 0, total } });

            // Stream: each hashed file is upserted (doc + tree path) as the walk
            // runs. A single bad file must not kill an hours-long scan — upsert
            // failures are logged and counted, not thrown.
            let scanned = 0;
            let failed = 0;
            const upserted = new Set();
            const consume = async (file) => {
                // Cancellation: throwing here aborts the backend's walk at the
                // current file (onFile is awaited inline by the scan loop).
                if (this.#runtime.state.resyncCancels.has(backendName)) {
                    const err = new Error('resync cancelled');
                    err.code = 'RESYNC_CANCELLED';
                    throw err;
                }
                if (file?.key == null || upserted.has(file.key)) return;
                upserted.add(file.key);
                try {
                    await this.#runtime.projection.upsertDocument(file);
                } catch (error) {
                    failed += 1;
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, key: file.key, error: error.message }, 'Resync document upsert failed');
                }
                scanned += 1;
                if (scanned % 25 === 0) {
                    this.#patchResyncState(backendName, { progress: { scanned, total } }, { quiet: scanned % 100 !== 0 });
                    await yieldToIO();
                }
            };

            let scanResult;
            try {
                scanResult = await this.#runtime.state.operations.run('resync.scan', () => this.#runtime.state.stored.scan(backendName, {
                    onFile: consume, isCancelled: () => this.#runtime.state.resyncCancels.has(backendName),
                }));
                if (scanResult?.ok === false || !Array.isArray(scanResult?.files)) {
                    throw new Error(`Backend scan did not return a usable snapshot: ${scanResult?.reason || 'missing files'}`);
                }
                // Backends whose scan() does not stream still get their rows here.
                for (const file of scanResult.files) await consume(file);
                // An empty snapshot has no onFile boundary at which to notice
                // Stop sync. Never interpret a cancelled scan as mass absence.
                if (this.#runtime.state.resyncCancels.has(backendName)) throw Object.assign(new Error('resync cancelled'), { code: 'RESYNC_CANCELLED' });
            } catch (error) {
                if (error?.code !== 'RESYNC_CANCELLED') throw error;
                // Cancelled: the snapshot is partial, so NOTHING may be
                // reconciled from it (a differ would read the unwalked rest as
                // "all deleted"). Indexed rows stay; a later resync resumes via
                // the checksum cache.
                this.#runtime.state.logger.info({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, scanned }, 'Resync cancelled by user');
                this.#patchResyncState(backendName, { lastError: null, cancelledAt: new Date().toISOString() });
                return { backend: backendName, cancelled: true, scanned };
            }
            const { files } = scanResult;
            const scanErrors = scanResult.errors?.[backendName] || null;

            // Reconcile absences only against a usable snapshot: a dead root
            // means the walk never happened (double-guard behind the liveness
            // gate above — the mount can vanish mid-resync too).
            if (scanErrors?.root) {
                this.#patchResyncState(backendName, { offline: true, lastError: `mount unavailable (${scanErrors.root})` });
                return { backend: backendName, ok: false, offline: true, reason: scanErrors.root };
            }
            if (scanResult.complete === false) {
                this.#patchResyncState(backendName, { lastError: 'Scan incomplete; absence reconciliation skipped' });
                return { backend: backendName, ok: false, complete: false, count: files.length, failed, orphaned: 0 };
            }
            const orphaned = await this.#runtime.projection.purgeOrphanedPaths(backendName, files, scanErrors);
            // Global stale-local-path cleanup: drop locations whose backend was
            // renamed/removed (dead-backend refs like the legacy fs:home). Gated to
            // the home resync so the all-file-docs scan runs once, not per backend.
            if (backendName === HOME_STORED_BACKEND) {
                await this.#runtime.projection.purgeDeadBackendLocations().catch((error) =>
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: error.message }, 'Dead-backend location purge failed'));
            }
            // Folder shells: every empty node under the mirror root that is not a
            // directory on disk any more goes (the skeleton pass re-inserted the
            // ones that still exist, so those stay even when empty).
            const shapeDirs = this.#runtime.state.lastShapeDirs.get(backendName);
            const backendRoot = this.#runtime.backends.getBackendRootPath(backendName);
            if (backendRoot && Array.isArray(shapeDirs) && typeof this.#runtime.state.sweepBackendPaths === 'function') {
                const swept = await Promise.resolve(this.#runtime.state.sweepBackendPaths(backendRoot, shapeDirs)).catch((error) => {
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, error: error.message }, 'Empty backend folder sweep failed');
                    return 0;
                });
                if (swept > 0) this.#runtime.state.logger.info({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, swept }, 'Removed empty backend folders no longer on disk');
            }
            this.#patchResyncState(backendName, {
                lastScanAt: new Date().toISOString(),
                lastError: failed > 0 ? `${failed} of ${files.length} files failed to index` : null,
                fileCount: files.length,
                orphaned,
                progress: { scanned, total: files.length },
            }, { quiet: true });

            // Retention GC: purge orphans past the window. Default retention is
            // -1 (keep forever) — explicit cleanup goes through the feature/orphaned
            // filter or gcOrphanedDocuments().
            const retentionDays = typeof this.#runtime.state.getOrphanRetentionDays === 'function' ? this.#runtime.state.getOrphanRetentionDays() : -1;
            if (Number.isFinite(retentionDays) && retentionDays >= 0) {
                await this.#index.gcOrphanedDocuments({ retentionDays }).catch((error) =>
                    this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: error.message }, 'Orphan GC failed'));
            }

            return { backend: backendName, count: files.length, failed, orphaned };
        } finally {
            releaseNamespace();
            this.#runtime.state.resyncing.delete(backendName);
            this.#runtime.state.resyncCancels.delete(backendName);
            this.#patchResyncState(backendName, { resyncing: false });
        }
    }

    // Merge a status patch + notify the resync observer (Workspace re-emits it
    // to clients). `quiet` skips the observer for high-frequency updates.
    #patchResyncState(backendName, patch = {}, { quiet = false } = {}) {
        const next = { ...(this.#runtime.state.backendStatus.get(backendName) || {}), ...patch };
        this.#runtime.state.backendStatus.set(backendName, next);
        if (quiet || typeof this.#runtime.state.onResyncStateChange !== 'function') return;
        try {
            this.#runtime.state.onResyncStateChange({
                backend: backendName,
                // Mirror node the client should badge (null for unmirrored backends).
                treePath: this.#runtime.backends.getBackendRootPath(backendName),
                resyncing: next.resyncing === true,
                progress: next.progress || null,
                lastScanAt: next.lastScanAt || null,
                lastError: next.lastError || null,
            });
        } catch { /* observer must never break a resync */ }
    }

    // Mirror the mount's directory skeleton under its backends-tree root and
    // return the file count for progress totals (null when unsupported).
    async #mirrorBackendShape(backendName) {
        try {
            const root = this.#runtime.backends.getBackendRootPath(backendName);
            if (!root || typeof this.#runtime.state.insertBackendPath !== 'function') return null;
            const shape = await this.#runtime.state.stored.shape?.(backendName);
            if (!shape?.ok) return null;
            let mirrored = 0;
            for (const dir of shape.dirs) {
                if (++mirrored % 25 === 0) await yieldToIO();
                if (this.#runtime.state.resyncCancels.has(backendName)) break;
                await this.#runtime.state.insertBackendPath(`${root}/${dir}`);
            }
            this.#runtime.state.lastShapeDirs.set(backendName, Array.isArray(shape.dirs) ? [...shape.dirs] : []);
            return shape.files;
        } catch (error) {
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, error: error.message }, 'Backend skeleton mirror failed');
            return null;
        }
    }
}
