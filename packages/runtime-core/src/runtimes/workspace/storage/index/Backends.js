import path from 'path';
import { randomUUID } from 'node:crypto';
import getFolderSize from 'get-folder-size';
import { parseLocationUrl, deviceFileUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { normalizeSegment } from '../../../../utils/backend-documents.js';
import { DEFAULT_SYNC_EXCLUSIONS, WORKSPACE_INTERNAL_EXCLUSIONS } from '../../config/constants.js';
import { HOME_STORED_BACKEND, DATA_BLOB_BACKEND, STORED_DRIVERS, LOCAL_DRIVERS, CONTAINER_DRIVERS, REMOTE_RESTART_KEYS, objectsError } from './contracts.js';

export default class Backends {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    assertResyncable(backendName) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config?.enabled) throw new Error(`Data backend "${backendName}" is disabled`);
        if (!config?.resync) throw new Error(`Data backend "${backendName}" does not support resync`);
        if (!this.#runtime.state.stored.getBackend(backendName)) throw new Error(`Data backend "${backendName}" is not registered`);
    }

    // ── Container (folder) mutation on a writable file backend ────────────────
    // The backend does the fs op; the Workspace facade updates the tree mirror.
    // The mirror tree root for a backend (/<driver>/<address> in the backends tree).
    getBackendTreeRoot(backendName) {
        return this.getBackendRootPath(backendName);
    }

    #mutableFileBackend(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config) throw new Error(`Unknown data backend: ${backendName}`);
        if (!CONTAINER_DRIVERS.has(config.driver)) throw new Error(`Backend "${backendName}" has no mutable folders`);
        if (config.readOnly === true) throw new Error(`Backend "${backendName}" is read-only`);
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const backend = this.#runtime.state.stored.getBackend(backendName);
        if (!backend) throw new Error(`Data backend "${backendName}" is not registered`);
        return backend;
    }

    async createBackendContainer(backendName, key) {
        const backend = this.#mutableFileBackend(backendName);
        const normalized = this.#runtime.objects.objectKey(backend, this.#runtime.objects.objectsBackend(backendName, { write: true }).root, key);
        const coordinated = await this.#runtime.state.policyDirectoryMove?.('create', { backend: backendName, key: normalized });
        if (coordinated) return coordinated;
        return typeof this.#runtime.state.stored.ensureDirectory === 'function' ? this.#runtime.state.stored.ensureDirectory(backendName, normalized) : backend.createContainer(normalized);
    }

    async deleteBackendContainer(backendName, key) {
        const backend = this.#mutableFileBackend(backendName);
        const root = this.#runtime.objects.objectsBackend(backendName, { write: true }).root;
        const normalized = this.#runtime.objects.objectKey(backend, root, key);
        if (this.#runtime.state.stored.supportsScopedFolderDeletion !== true) throw objectsError('Upgrade canvas-stored to 1.12.1 or newer for deletion limited to this backend folder', 'STORED_TOO_OLD', 501);
        const remote = this.#runtime.state.dataBackends[backendName].driver === 'gdrive';
        if (remote && typeof this.#runtime.state.stored.removeDirectory !== 'function') throw objectsError('Upgrade canvas-stored for native Drive folder deletion', 'STORED_TOO_OLD', 501);
        return this.#index.withKeyLock(backendName, normalized, async () => {
            if (!remote && !await backend.statContainer?.(normalized)) return { ok: true, key: normalized, type: 'directory' };
            const release = await this.#runtime.scans.acquireBackendNamespace(backendName);
            try {
                const method = remote ? 'removeDirectory' : 'trashDirectory';
                const result = await this.#runtime.state.stored[method](backendName, normalized, { origin: `backend-delete:${randomUUID()}` });
                await this.#runtime.state.documentMutations;
                return result;
            } finally { release(); }
        });
    }

    async renameBackendContainer(backendName, fromKey, toKey) {
        this.#mutableFileBackend(backendName);
        const result = await this.#index.renameObject(backendName, fromKey, toKey, { directory: true, operationId: randomUUID() });
        if (!result?.ok) {
            const status = { 'not-found': 404, 'target-exists': 409, 'read-only-target': 403, 'invalid-key': 400 }[result?.reason] || 409;
            throw objectsError(`Folder move refused: ${result?.reason || 'unknown error'}`, result?.reason || 'MOVE_FAILED', status);
        }
        return result;
    }

    /**
     * On-demand disk usage for a local backend. Uses get-folder-size (cross-
     * platform, hardlink/inode-aware — stored's commit() hardlinks, so a naive
     * walk double-counts; `loose` skips unreadable entries). Potentially slow on
     * large trees (a whole home dir), which is why it only runs when explicitly
     * requested; the result is cached on the backend status so list/status
     * reads can show the last computed value.
     */
    async getBackendDiskUsage(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        const isLocal = !!config && LOCAL_DRIVERS.has(config.driver);
        if (!isLocal) throw new Error(`Backend "${backendName}" has no local disk usage`);

        const root = this.resolveBackendRoot(backendName, config);
        const bytes = await getFolderSize.loose(root);
        const usage = { backend: backendName, bytes, computedAt: new Date().toISOString() };
        this.#runtime.state.backendStatus.set(backendName, {
            ...(this.#runtime.state.backendStatus.get(backendName) || {}),
            diskUsage: usage,
        });
        return usage;
    }

    /**
     * Apply a data-backend config change to the running stored runtime. Lets
     * the UI flip `enabled` / `watch` without a workspace restart.
     *   - enabled: register & start (and resync if supported) / unregister
     *   - watch: start/stop chokidar on the live backend
     * Other fields just update the cached config (read by #getBackendRootPath
     * et al.) and take effect on the next event.
     */
    async applyBackendConfig(name, fullConfig = {}, patch = {}) {
        if (!this.#runtime.state.stored) return;
        this.#runtime.state.dataBackends = { ...this.#runtime.state.dataBackends, [name]: fullConfig };
        const configured = this.#runtime.state.stored.getBackend(name);
        if (configured && 'removalPolicy' in patch) configured.config.removalPolicy = fullConfig.removalPolicy;

        const isLocal = STORED_DRIVERS.has(fullConfig.driver) && fullConfig.supported !== false;

        if ('enabled' in patch) {
            const live = this.#runtime.state.stored.getBackend(name);
            if (patch.enabled && !live && isLocal) {
                await this.#registerBackend(name, fullConfig);
                this.#runtime.state.backendStatus.set(name, { lastScanAt: null, lastError: null });
                await this.#applyBackendNodeLock(name, true);
                if (fullConfig.resync) {
                    // Initial/catch-up scan can be slow (a whole external
                    // folder) — never block the enable/add call on it.
                    try { this.#index.resyncInBackground(name); } catch (err) { this.setBackendError(name, err); }
                }
            } else if (!patch.enabled && live) {
                await live.stop?.().catch(() => {});
                // removeBackend is async (awaits watcher stop before dropping
                // the registry entry) — must be awaited or a re-add races it.
                await this.#runtime.state.stored.removeBackend?.(name);
                this.#runtime.state.backendStatus.delete(name);
                await this.#applyBackendNodeLock(name, false);
            }
        }

        // Remote drivers: credentials/root live on the instance — swap it out
        // when they change (stop → remove → add, watcher restored from config).
        if (!LOCAL_DRIVERS.has(fullConfig.driver) && REMOTE_RESTART_KEYS.some((k) => k in patch) && !('enabled' in patch)) {
            const live = this.#runtime.state.stored.getBackend(name);
            if (live && fullConfig.enabled && fullConfig.supported !== false) {
                await live.stop?.().catch(() => {});
                await this.#runtime.state.stored.removeBackend?.(name);
                await this.#registerBackend(name, fullConfig);
            }
        }

        if ('watch' in patch) {
            const live = this.#runtime.state.stored.getBackend(name);
            if (live) {
                if (patch.watch && !live.watching) {
                    await live.watch?.();
                    // Catch up on anything that landed while watch was off —
                    // in the background, the toggle must not block on a scan.
                    if (fullConfig.resync) {
                        try { this.#index.resyncInBackground(name); } catch (err) { this.setBackendError(name, err); }
                    }
                } else if (!patch.watch && live.watching) {
                    await live.stop?.();
                }
            }
        }

        // New exclusion patterns require rebuilding the backend's matcher
        // (chokidar + list/scan share it): re-register the live backend. A
        // follow-up resync applies exclusions retroactively (unlink-only).
        // Skip when 'enabled' just (re)registered the backend above — the fresh
        // registration already carries the full config, exclusions included.
        if ('exclude' in patch && !('enabled' in patch && patch.enabled)) {
            const live = this.#runtime.state.stored.getBackend(name);
            if (live && isLocal && fullConfig.enabled) {
                await live.stop?.().catch(() => {});
                // Async remove must complete before the re-add or it collides.
                await this.#runtime.state.stored.removeBackend?.(name);
                await this.#registerBackend(name, fullConfig);
            }
        }
    }

    async #registerBackend(name, config) {
        await this.#runtime.state.operations.run(`backend.initialize:${name}`, async () => {
            const backend = this.#runtime.state.stored.addBackend(name, this.#backendRegistrationConfig(name, config));
            await backend.ready?.();
        });
    }

    async registerConfiguredBackends() {
        for (const [backendName, config] of Object.entries(this.#runtime.state.dataBackends || {})) {
            if (!config?.enabled || config.supported === false || !STORED_DRIVERS.has(config.driver)) continue;

            try {
                await this.#registerBackend(backendName, config);
                this.#runtime.state.backendStatus.set(backendName, { lastScanAt: null, lastError: null });
                await this.#applyBackendNodeLock(backendName, true);
            } catch (error) {
                this.setBackendError(backendName, error);
            }
        }
    }

    // Shared registration config: resolved root + effective exclusions (defaults
    // ∪ per-backend user patterns) wired into the driver's shared ignore matcher.
    #backendRegistrationConfig(backendName, config = {}) {
        if (!LOCAL_DRIVERS.has(config.driver)) return this.#remoteRegistrationConfig(backendName, config);
        const root = this.resolveBackendRoot(backendName, config);
        return {
            ...config,
            root,
            // A workspace can roam between machines/filesystems. Old resyncs
            // persisted host-specific dev/ino values even for its own stores.
            // Ignore those there; external mounts retain their identity gate.
            fsid: this.isWorkspaceOwnedRoot(backendName, config) ? null : config.fsid,
            ignored: this.#effectiveExclusions(config, root),
            // External (device-anchored) mounts must never auto-create their
            // mountpoint: a created-empty dir at an unmounted path would make
            // "absent" scan as "empty". Managed workspace stores may create.
            createRoot: config.device?.id ? false : config.createRoot !== false,
            provider: config.provider || 'fs',
            account: config.account || 'workspace',
            container: config.container || (backendName === HOME_STORED_BACKEND ? 'home' : 'data'),
        };
    }

    isWorkspaceOwnedRoot(backendName, config) {
        if (![HOME_STORED_BACKEND, DATA_BLOB_BACKEND].includes(backendName)
            || config.device?.id || config.createRoot === false) return false;
        const relative = path.relative(this.#runtime.state.rootPath, this.resolveBackendRoot(backendName, config));
        return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    }

    // Remote drivers have no on-disk root and no exclusion matcher: the config
    // goes to the driver as-is (credentials included — the driver is the only
    // consumer), plus the source descriptor stored stamps on every location.
    #remoteRegistrationConfig(backendName, config = {}) {
        const { root: _root, exclude: _exclude, ...rest } = config;
        return {
            ...rest,
            provider: config.provider || config.driver,
            account: config.account || backendName,
            container: config.container || config.folderId || 'root',
            algorithms: ['sha256'],
        };
    }

    #effectiveExclusions(config = {}, backendRoot = null) {
        if (config.driver !== 'file') return undefined;
        const user = Array.isArray(config.exclude) ? config.exclude.filter((p) => typeof p === 'string' && p.trim()) : [];
        return [...this.#structuralExclusions(backendRoot), ...DEFAULT_SYNC_EXCLUSIONS, ...user];
    }

    /**
     * Root-anchored patterns for the workspace's own runtime dirs that live
     * inside this backend's root. The `home` layout puts the home backend's
     * root AT the workspace root, so `.workspace/` (and anything a config
     * remapped out of it) has to be pruned explicitly — dotfiles are excluded
     * by default too, but that rule is user-facing policy while this one is
     * structural: without it the workspace indexes its own database.
     */
    #structuralExclusions(backendRoot) {
        const patterns = [...WORKSPACE_INTERNAL_EXCLUSIONS];
        if (!backendRoot) return patterns;
        const root = path.resolve(backendRoot);
        for (const internal of this.#runtime.state.internalPaths) {
            if (internal === root || !internal.startsWith(root + path.sep)) continue;
            const rel = path.relative(root, internal).split(path.sep).join('/');
            if (!rel || rel.startsWith('..')) continue;
            patterns.push(rel, `${rel}/**`);
        }
        return [...new Set(patterns)];
    }

    /** Effective exclusion patterns for a backend (structural + defaults + user), for the API. */
    getEffectiveExclusions(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config) return [];
        return this.#effectiveExclusions(config, this.resolveBackendRoot(backendName, config)) ?? [];
    }

    isConfiguredLocalBackend(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        return !!config && config.supported !== false && STORED_DRIVERS.has(config.driver);
    }

    /**
     * Resolve a backend for byte-level ops (delete). A disabled-but-configured
     * LOCAL backend is registered transiently: the enable-lock forbids
     * destroying an active backend's whole subtree, so "disable, then destroy"
     * is the designed flow — the bytes must still be reachable afterwards.
     */
    ensureByteOpsBackend(backendName) {
        const live = this.#runtime.state.stored.getBackend(backendName);
        if (live) return { backend: live, transient: false };
        if (!this.isConfiguredLocalBackend(backendName)) return { backend: null, transient: false };
        const config = this.#runtime.state.dataBackends[backendName];
        this.#runtime.state.stored.addBackend(backendName, {
            ...this.#backendRegistrationConfig(backendName, config),
            // Byte-ops only — never start a watcher on a transiently-registered
            // (disabled) backend.
            watch: false,
        });
        return { backend: this.#runtime.state.stored.getBackend(backendName), transient: true };
    }

    /**
     * Delete the bytes behind a single stored:// URL (blob-cascade seam for
     * plain index-deletes of managed-store-only documents). Refuses read-only
     * and unknown backends; registers a disabled local backend transiently.
     */
    async deleteStoredUrl(url) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const parsed = parseLocationUrl(url);
        if (parsed?.scheme !== 'stored') throw new Error(`Not a stored:// URL: ${url}`);
        const { backend, transient } = this.ensureByteOpsBackend(parsed.backend);
        try {
            if (!backend || !backend.canDelete || this.#runtime.state.dataBackends[parsed.backend]?.readOnly === true) {
                return { ok: false, reason: 'backend is read-only or not configured' };
            }
            return await this.#runtime.state.stored.deleteByUrl(url);
        } finally {
            if (transient) await this.#runtime.state.stored.removeBackend?.(parsed.backend);
        }
    }

    // Enable-lock: while a backend is enabled its /<driver>/<address> mirror
    // node in the backends tree is structurally locked (can't be removed/
    // renamed). Released on disable/remove — NOT on stop() (the config still
    // says enabled).
    async #applyBackendNodeLock(backendName, enabled) {
        const root = this.getBackendRootPath(backendName);
        if (!root) return;
        const hook = enabled ? this.#runtime.state.lockBackendNode : this.#runtime.state.unlockBackendNode;
        if (!hook) return;
        await Promise.resolve(hook(root, backendName)).catch((err) =>
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, backend: backendName, error: err.message }, 'Backend node lock update failed'));
    }

    resolveBackendRoot(backendName, config = {}) {
        const configuredRoot = config.root || '';
        if (configuredRoot.includes('{WORKSPACE_ROOT}')) {
            return configuredRoot.replaceAll('{WORKSPACE_ROOT}', this.#runtime.state.rootPath);
        }
        if (backendName === HOME_STORED_BACKEND) return this.#runtime.state.homePath;
        if (backendName === DATA_BLOB_BACKEND) return this.#runtime.state.dataPath;
        return configuredRoot || this.#runtime.state.dataPath;
    }

    /**
     * Stable tree node for a backend under the strict mirror schema:
     *   /<driver>/<resource-address> (in the dedicated backends tree)
     * The resource address is the backend name (e.g. 'workspace:home'); remote
     * drivers (s3, …) may extend this with container/bucket segments later.
     *
     * Mirrored backends are the enumerable, non-managed ones: managed blob
     * stores (workspace:data) are opaque by design — their
     * documents are filed by the connector that persisted them (e.g. mail under
     * /imap/...). Config presence, not `enabled`, gates the path so the
     * disable-then-destroy flow can still resolve a disabled backend's subtree.
     */
    getBackendRootPath(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config || config.supported === false) return null;
        if (config.managed === true) return null;
        const driver = String(config.driver || 'file').toLowerCase();
        const live = this.#runtime.state.stored?.getBackend(backendName);
        // Offline/disabled backends fall back to the driver's static answer so
        // the disable-then-destroy flow still resolves the mirror subtree.
        const canEnumerate = live ? live.capabilities?.canEnumerate === true : CONTAINER_DRIVERS.has(driver);
        if (!canEnumerate) return null;
        // Case/unicode-preserving: the mount slug is user-facing ("Fotky" must
        // not become "fotky" in the tree). Only path-hostile chars are squashed.
        const address = String(backendName || '').replace(/[^\p{L}\p{N}._:@-]+/gu, '-');
        // Anchor-first mirror grammar — the first segment names what the data is
        // anchored to, not the driver (driver stays a config/API concept):
        //   /workspace/<store>        workspace-anchored (workspace:home → /workspace/home)
        //   /device/<device>/<mount>  device-anchored fs mounts (device segment is
        //                             the config snapshot — stable across renames)
        //   /<driver>/<address>       connectors/remotes (imap, s3, …)
        const deviceSegment = config.device?.name
            ? String(config.device.name).replace(/[^\p{L}\p{N}._@-]+/gu, '-')
            : null;
        if (deviceSegment) return `/device/${deviceSegment}/${address}`;
        if (backendName.startsWith('workspace:')) {
            const store = normalizeSegment(backendName.slice('workspace:'.length)).replace(/\//g, '-');
            return `/workspace/${store}`;
        }
        return `/${driver}/${address}`;
    }

    /**
     * External (device-scoped) mount info for a backend: a user-added file
     * backend rooted outside the workspace (config.device snapshot present).
     * These get a portable file://<deviceId>/<abs-path> location alongside the
     * server-local stored:// one. Returns { deviceId, root } or null.
     */
    externalMountInfo(backendName) {
        const config = this.#runtime.state.dataBackends[backendName];
        if (!config || config.driver !== 'file' || !config.device?.id) return null;
        const root = config.root || '';
        if (!root || root.includes('{WORKSPACE_ROOT}')) return null;
        return { deviceId: config.device.id, root };
    }

    /** file://<deviceId>/<abs-path> twin URL for a key on an external mount (or null). */
    deviceFileLocationUrl(backendName, key) {
        const mount = this.externalMountInfo(backendName);
        if (!mount || !key) return null;
        return deviceFileUrl(mount.deviceId, path.join(mount.root, key));
    }

    /**
     * Map a file://<deviceId>/<path> location to a local absolute path — only
     * when the authority is this server's device and the path lies under a
     * configured external mount root (a crafted location must never read
     * arbitrary server files). Returns { abs, backendName } or null.
     */
    resolveLocalDevicePath(deviceId, key) {
        if (!this.#runtime.state.device?.deviceId || deviceId !== this.#runtime.state.device.deviceId) return null;
        const abs = path.resolve('/', String(key || ''));
        for (const backendName of Object.keys(this.#runtime.state.dataBackends || {})) {
            const mount = this.externalMountInfo(backendName);
            if (!mount) continue;
            const root = path.resolve(mount.root);
            if (abs === root || abs.startsWith(root + path.sep)) return { abs, backendName };
        }
        return null;
    }

    /**
     * Inverse of #getBackendRootPath: map a backends-tree path back to the
     * configured backend it mirrors (prefix match). Returns the backend name or
     * null when no configured backend owns the path (e.g. imap subtrees — those
     * are the mail service's, resolved separately).
     */
    resolveBackendForTreePath(treePath) {
        const normalized = String(treePath || '').replace(/\/+/g, '/').replace(/\/$/, '');
        for (const backendName of Object.keys(this.#runtime.state.dataBackends || {})) {
            const root = this.getBackendRootPath(backendName);
            if (root && (normalized === root || normalized.startsWith(`${root}/`))) return backendName;
        }
        return null;
    }

    /** Public accessor for the mirror node of a backend (Workspace lock wiring). */


    setBackendError(backendName, error) {
        this.#runtime.state.backendStatus.set(backendName, {
            ...(this.#runtime.state.backendStatus.get(backendName) || {}),
            lastError: error?.message || String(error),
        });
    }
}
