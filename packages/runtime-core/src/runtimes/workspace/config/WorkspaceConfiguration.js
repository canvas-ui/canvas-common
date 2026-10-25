import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { containsSecrets, protectionError, writePrivateJson, redactSecrets } from '../security/WorkspaceCrypto.js';
import path from 'path';

import { WorkspaceStoredIndex } from '../storage/WorkspaceStoredIndex.js';
import { normalizeRemovalPolicy } from '../storage/removal-policy.js';
import { WORKSPACE_INTERNAL_DIRNAME, WORKSPACE_LAYOUTS, normalizeWorkspaceLayout, workspaceDirectories, workspaceStoredDefault, workspaceServices } from './constants.js';

export default class WorkspaceConfiguration {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    /*
    * Getters / Setters
    */
    get id() { return this.#runtime.state.configStore.get('id'); }
    get name() { return this.#runtime.state.configStore.get('name'); }
    get label() { return this.#runtime.state.configStore.get('label', this.#workspace.name || this.#workspace.id); }
    get description() { return this.#runtime.state.configStore.get('description'); }
    get color() { return this.#runtime.state.configStore.get('color'); }
    get icon() { return this.#runtime.state.configStore.get('icon', null); }
    get homeScreen() { return this.#runtime.state.configStore.get('homeScreen', {}); }
    get links() { return this.#runtime.state.configStore.get('links', {}); }
    get type() { return this.#runtime.state.configStore.get('type', 'workspace'); }
    /**
     * On-disk folder structure this workspace was created with:
     *   'full' — visible runtime dirs at the root, user drive in `home/`
     *   'home' — the root IS the user's roaming drive, internals in `.workspace/`
     * Fixed at creation; only decides the DEFAULTS behind `internals`/`services`,
     * which remain the authority for every resolved path.
     */
    get layout() { return normalizeWorkspaceLayout(this.#runtime.state.configStore.get('layout')); }
    /** Hidden internals dir (`home` layout). Null for the `full` layout. */
    get internalsPath() {
        return this.#workspace.layout === WORKSPACE_LAYOUTS.HOME
            ? path.join(this.#runtime.state.rootPath, WORKSPACE_INTERNAL_DIRNAME)
            : null;
    }
    get owner() { return this.#workspace.options.owner ?? this.#runtime.state.configStore.get('owner'); }
    get rootPath() { return this.#runtime.state.rootPath; }
    get protection() { return { mode: this.#runtime.state.crypto.mode, secretsUnlocked: this.#runtime.state.crypto.unlocked, withoutSecrets: this.#runtime.state.withoutSecrets }; }
    get lastStopReason() { return this.#runtime.state.configStore.get('lastStopReason', null); }
    get stoppedAt() { return this.#runtime.state.configStore.get('stoppedAt', null); }

    async configureProtection(options) {
        if (this.#workspace.backups.busy || this.#workspace.isActive || this.#runtime.state.startPromise || this.#runtime.state.protectionPromise) throw protectionError('WORKSPACE_MUST_STOP', 'Stop the workspace before changing protection', 409);
        this.#runtime.state.protectionPromise = (async () => {
            try {
                const result = await this.#runtime.state.crypto.configure(options);
                this.migrateSecrets();
                this.#runtime.state.configStore.set('protection', { mode: result.mode });
                return result;
            } finally { this.#runtime.state.crypto.stop(); }
        })();
        try { return await this.#runtime.state.protectionPromise; }
        finally { this.#runtime.state.protectionPromise = null; }
    }

    migrateSecrets() {
        if (!this.#runtime.state.crypto.unlocked) return;
        const services = this.#runtime.state.crypto.protect(this.#runtime.state.configStore.get('services', {}));
        this.#runtime.state.crypto.resolve(services);
        this.#runtime.state.configStore.set('services', services);
        // Mail and connector accounts use stored.json.
        const storedFile = path.join(this.#workspace.configDir, 'stored.json');
        if (existsSync(storedFile)) {
            const namespace = path.relative(this.#runtime.state.rootPath, path.join(this.#workspace.configDir, 'stored')).split(path.sep).join('/');
            const config = this.#runtime.state.crypto.protect(JSON.parse(readFileSync(storedFile, 'utf8')), namespace);
            this.#runtime.state.crypto.resolve(config);
            writePrivateJson(storedFile, config);
        }
        // Linked-device auth is credential material, not document data.
        const sessions = path.join(this.#workspace.configDir, 'whatsapp');
        if (existsSync(sessions)) for (const entry of readdirSync(sessions, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = path.join(sessions, entry.name, 'session.json');
            if (!existsSync(file)) continue;
            const raw = readFileSync(file, 'utf8');
            const session = JSON.parse(raw);
            if (session.secretRef) this.#runtime.state.crypto.resolve(session.secretRef);
            else writePrivateJson(file, { secretRef: this.#runtime.state.crypto.protect({ password: raw }, `whatsapp/${entry.name}`).password });
        }
    }
    resolveCredentials(config) {
        if (this.#runtime.state.withoutSecrets && containsSecrets(config)) throw protectionError('WORKSPACE_SECRETS_LOCKED', 'Start with the PIN/password to use authenticated integrations');
        return this.#runtime.state.crypto.resolve(config);
    }
    resolveIntegrationConfig(config) { return this.resolveCredentials(config); }
    runtimeBackends() {
        return Object.fromEntries(Object.entries(this.#workspace.dataBackends).map(([name, config]) => [name,
            this.#runtime.state.withoutSecrets && containsSecrets(config) ? { ...config, enabled: false } : this.resolveCredentials(config)]));
    }
    get config() { return this.#runtime.state.configStore.store; }
    get acl() { return this.#runtime.state.configStore.get('acl'); }
    get publicCanvasShares() { return this.#runtime.state.configStore.get('publicCanvasShares', {}); }

    // stored's config (services.stored): { root, cache, sync, backends } —
    // stored is storage only: its metadata index root, its in-workspace working
    // store (cache), sync policies, and the storage-backend map.
    #storedConfig() {
        const defaults = workspaceStoredDefault(this.#workspace.layout);
        const configured = (this.#runtime.state.configStore.get('services') || {}).stored || {};
        return {
            ...defaults,
            ...configured,
            // #mergeConfigMap is one level deep — materialize the nested
            // backends map explicitly against the storage defaults.
            backends: WorkspaceConfiguration.#mergeConfigMap(defaults.backends, configured.backends || {}),
        };
    }

    // Storage backends only (services.stored.backends) — the cache is NOT a
    // backend, it's stored's own working store (see cachePath).
    get dataBackends() {
        return this.#storedConfig().backends;
    }

    // Single write authority for services.stored.backends. Keeps the rest of
    // the stored config (root/cache/sync) as-is; materializing the full shape
    // on write is intentional — workspace.json stays self-describing.
    writeStoredBackends(backends) {
        const services = this.#runtime.state.configStore.get('services') || {};
        this.#runtime.state.configStore.set('services', this.#runtime.state.crypto.protect({ ...services, stored: { ...this.#storedConfig(), backends } }));
    }

    get services() {
        return WorkspaceConfiguration.#mergeConfigMap(workspaceServices(this.#workspace.layout), this.#runtime.state.configStore.get('services') || {});
    }

    /**
     * inferd's config (`services.inferd`): `{ providers?, spaces?, rules? }`.
     *
     * This lives IN workspace.json on purpose. A workspace is meant to be
     * self-contained and movable — stop it, tar it, scp it, run it under
     * canvas-edge from a folder with no canvas-server at all — and which model
     * its vectors were built with is part of what makes it readable elsewhere.
     * Server and per-user config are *defaults* that a fresh workspace inherits;
     * once set here, this layer wins and travels with the data.
     *
     * Empty ({}) means "inherit everything", which is the normal case.
     */
    get inferdConfig() {
        const configured = (this.#runtime.state.configStore.get('services') || {}).inferd;
        return configured && typeof configured === 'object' ? configured : {};
    }

    get stats() {
        if (!this.#workspace.isActive || !this.#runtime.state.db) return null;
        return this.#runtime.state.db.stats;
    }

    /**
     * Async stats superset including LanceDB FTS + dense-vector internals
     * (row counts, embedded-doc count, embedder/model state, queue backlog).
     * Used by the Workspace Settings UI. Returns null when inactive.
     */
    async getStats() {
        if (!this.#workspace.isActive || !this.#runtime.state.db) return null;
        const stats = await this.#runtime.state.db.getStats();
        // Embedding progress. The queue is this workspace's own, so the backlog
        // shown here is genuinely its work — re-indexing a 3-doc workspace no
        // longer reports the server's other 800 pending jobs. Combined with the
        // per-space embeddedDocs (semantic.vectorSpaces) the UI can show a
        // re-embed in flight and how far it's got.
        if (this.#runtime.state.inferd?.workspaceStatus) {
            try {
                // Actual routing (what really embeds where) from the inferd router
                // rules — notes/emails + text-file blobs → text, image/* → image.
                // Surfaced so the UI shows reality, not synapsd's note-only gap default.
                // This workspace's own router — what it actually embeds with,
                // after workspace.json overrides the user/server defaults.
                const router = (await this.#runtime.state.inferd.contextForWorkspace(this.#workspace.id)).router;
                const routing = {};
                for (const r of (router?.rules || [])) {
                    const m = r.match || {};
                    const desc = m.schema != null ? String(m.schema)
                        : (m.contentType != null ? `mime ${String(m.contentType)}` : 'any');
                    (routing[r.space] ||= []).push(desc);
                }
                // Which provider/model fills each space — now that both are config,
                // the UI should say what is actually running rather than imply the
                // old hardcoded pair.
                const spaces = {};
                for (const sp of (router?.spaces || [])) {
                    const rule = router.spaceRule(sp);
                    if (rule) { spaces[sp] = { provider: rule.provider, model: rule.model, dim: rule.dim }; }
                }
                stats.inferd = { queue: await this.#runtime.state.inferd.workspaceStatus(this.#workspace.id), routing, spaces };
            } catch { /* best effort */ }
        }
        return stats;
    }

    /**
     * Live-tune search knobs (persisted to workspace.json `semantic`, applied to
     * the running DB without a restart): image relevance floor + RRF fusion weights.
     * @param {{imageMaxDistance?: number|null, searchWeights?: {fts?:number, dense?:number, image?:number}}} tuning
     */
    async setSearchTuning(tuning = {}) {
        const current = this.#runtime.state.configStore.get('semantic', {}) || {};
        const next = { ...current };
        if (Object.prototype.hasOwnProperty.call(tuning, 'imageMaxDistance')) {
            next.imageMaxDistance = tuning.imageMaxDistance;
        }
        // Persisted alongside the ceiling so the mode survives a restart — the
        // db applies them live, the config store is what replays them on start.
        if (tuning.imageFloorMode === 'relative' || tuning.imageFloorMode === 'absolute') {
            next.imageFloorMode = tuning.imageFloorMode;
        }
        if (Number.isFinite(tuning.imageRelativeMargin) && tuning.imageRelativeMargin > 0) {
            next.imageRelativeMargin = tuning.imageRelativeMargin;
        }
        if (tuning.searchWeights && typeof tuning.searchWeights === 'object') {
            next.searchWeights = { ...(current.searchWeights || {}), ...tuning.searchWeights };
        }
        this.#runtime.state.configStore.set('semantic', next);
        const applied = this.#runtime.state.db?.setSearchTuning ? this.#runtime.state.db.setSearchTuning(tuning) : null;
        this.#workspace.emit('semantic.changed', { id: this.#workspace.id, semantic: next });
        return { semantic: next, applied };
    }

    // Resolve a config path value (absolute / `{WORKSPACE_ROOT}` template /
    // workspace-relative) to an absolute path.
    #resolveWorkspacePath(value) {
        if (!value) return null;
        const resolved = value.includes('{WORKSPACE_ROOT}')
            ? value.replaceAll('{WORKSPACE_ROOT}', this.#runtime.state.rootPath)
            : (path.isAbsolute(value) ? value : path.join(this.#runtime.state.rootPath, value));
        return path.resolve(resolved);
    }

    // Workspace INTERNALS (db/config/var/tmp …). The workspace.json `internals`
    // map overrides the defaults. Storage locations (home/data/cache) are NOT here — those are
    // stored's config (see #storedConfig/#backendRoot); this is only the
    // non-service runtime dirs.
    #resolveDir(key) {
        const internals = this.#runtime.state.configStore.get('internals', {}) || {};
        // Layout only supplies the fallback: an explicit internals entry always
        // wins, so a hand-edited workspace.json stays authoritative.
        return this.#resolveWorkspacePath(internals[key] ?? workspaceDirectories(this.#workspace.layout)[key]);
    }

    // Single authority for a storage backend's byte-root: stored's backend config
    // (dataBackends). home/data/cache resolve through here so WebDAV, the /home
    // API, and stored's indexer can never point at different dirs.
    #backendRoot(backendName, fallbackDirKey) {
        return this.#resolveWorkspacePath(this.#workspace.dataBackends[backendName]?.root) ?? this.#resolveDir(fallbackDirKey);
    }

    get homePath() {
        return this.#backendRoot('workspace:home', 'home');
    }

    get dataPath() {
        return this.#backendRoot('workspace:data', 'data');
    }

    /** stored's in-workspace working store (thumbnails, staging) — NOT a backend. */
    get cachePath() {
        return this.#resolveWorkspacePath(this.#storedConfig().cache) ?? this.#resolveDir('cache');
    }

    get dbPath() {
        return this.#resolveDir('db');
    }

    /** Stored's runtime root (metadata index; blob cache lives at cachePath). */
    get storedRootPath() {
        return this.#resolveWorkspacePath(this.#storedConfig().root) ?? this.#resolveDir('stored');
    }

    get gitPath() {
        return this.#resolveWorkspacePath(this.#workspace.services.git?.root) ?? this.#resolveDir('git');
    }

    get gitInternalPath() { return path.join(this.#workspace.gitPath, 'internal'); }

    // Derived from gitPath, not resolved independently: hooks live INSIDE the
    // git working dir, so a remapped/relocated git root (or the `home` layout's
    // .workspace/Git) must take them with it.
    get hooksPath() {
        const configured = (this.#runtime.state.configStore.get('internals', {}) || {}).hooks
            ?? (this.#runtime.state.configStore.get('directories', {}) || {}).hooks;
        return configured ? this.#resolveWorkspacePath(configured) : path.join(this.#workspace.gitInternalPath, 'hooks');
    }

    /** Git working-dir scripts (rule/hook scripts), sibling of hooks/. */
    get scriptsPath() {
        return path.join(this.#workspace.gitInternalPath, 'scripts');
    }

    /** Per-workspace service config dir (`config/*.json`). */
    get configDir() {
        return this.#resolveDir('config');
    }

    get rolesPath() {
        return this.#resolveDir('roles');
    }

    get varPath() {
        return this.#resolveDir('var');
    }

    /** Hook/rule run + pending-action logs (runs.jsonl, pending.jsonl). */
    get varHooksPath() {
        return this.#resolveDir('varHooks');
    }

    /**
     * Every absolute path this workspace uses for its own runtime state. The
     * indexed file backends exclude anything in here that falls under their
     * root — the workspace must never index its own db/cache/git, which is what
     * would otherwise happen in the `home` layout where the home backend's root
     * IS the workspace root.
     */
    get internalPaths() {
        return [
            path.join(this.#runtime.state.rootPath, '.workspace'),
            path.join(this.#runtime.state.rootPath, '.agent'),
            this.#workspace.dbPath,
            this.#workspace.storedRootPath,
            this.#workspace.cachePath,
            this.#workspace.dataPath,
            this.#workspace.gitPath,
            this.#workspace.configDir,
            this.#workspace.varPath,
            this.#workspace.rolesPath,
        ].filter(Boolean);
    }

    // Cheap start-time sanity check. A hand-edited (or half-migrated) config can
    // point an internal dir at a place the home backend would happily index; the
    // exclusions above already neutralise it, so this only warns — a workspace
    // must still start.
    assertLayoutSane() {
        const home = this.#workspace.homePath;
        if (this.#workspace.layout !== WORKSPACE_LAYOUTS.HOME) { return; }
        if (path.resolve(home) !== path.resolve(this.#runtime.state.rootPath)) {
            this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, home, root: this.#runtime.state.rootPath },
                'home-layout workspace: workspace:home root is not the workspace root');
        }
        const internals = this.#workspace.internalsPath;
        for (const dir of this.#workspace.internalPaths) {
            if (dir === internals || dir === path.join(this.#runtime.state.rootPath, '.agent')) { continue; }
            if (!path.resolve(dir).startsWith(path.resolve(internals) + path.sep)) {
                this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, dir },
                    'home-layout workspace: internal dir lives outside .workspace/ (excluded from indexing, but visible to the user)');
            }
        }
    }

    isDataBackendEnabled(backendName) {
        return this.#workspace.dataBackends[backendName]?.enabled === true;
    }

    isServiceEnabled(serviceName) {
        return this.#workspace.services[serviceName]?.enabled === true;
    }

    // Structural local stores every workspace depends on: workspace:data is the
    // managed blob target (persistBlob/stored:// addressing). It can't be
    // disabled, and as a managed (non-browseable, never exported) store the
    // readOnly knob is meaningless. (stored's cache is not a backend at all —
    // see services.stored.cache.)
    static #ALWAYS_ON_BACKENDS = new Set([WorkspaceStoredIndex.DATA_BLOB_BACKEND]);

    async setDataBackendConfig(backendName, patch) {
        if (patch && 'removalPolicy' in patch) patch = { ...patch, removalPolicy: normalizeRemovalPolicy(patch.removalPolicy) };
        if (WorkspaceConfiguration.#ALWAYS_ON_BACKENDS.has(backendName)) {
            if (patch?.enabled === false) {
                throw new Error(`Data backend "${backendName}" is structural and cannot be disabled`);
            }
            if (patch && 'readOnly' in patch) {
                throw new Error(`Data backend "${backendName}" is a managed store — read-only does not apply`);
            }
        }
        if (patch && 'scanOnStart' in patch && typeof patch.scanOnStart !== 'boolean') {
            throw new Error('scanOnStart must be a boolean');
        }
        const dataBackends = this.#workspace.dataBackends;
        const next = { ...dataBackends[backendName], ...patch };
        dataBackends[backendName] = next;
        this.writeStoredBackends(dataBackends);
        this.#workspace.emit('dataBackends.changed', { backend: backendName, config: this.#workspace.dataBackends[backendName] });
        if (this.#runtime.state.storedIndex?.isRunning) {
            await this.#runtime.state.storedIndex.applyBackendConfig(backendName, this.runtimeBackends()[backendName], this.#runtime.state.withoutSecrets && containsSecrets(next) ? { ...patch, enabled: false } : patch).catch((err) =>
                this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, backend: backendName, error: err.message }, 'Failed to apply data-backend config'),
            );
        }
    }

    // Database maintenance settings (Workspaces > Settings > Database).
    // Last-location removal drops the index entry by default. Opt into keeping
    // orphaned documents (and their curation), optionally with a GC window.
    get databaseSettings() {
        return { orphanPolicy: 'remove', orphanRetentionDays: -1, ...(this.#runtime.state.configStore.get('database') || {}) };
    }

    setDatabaseSettings(patch = {}) {
        if ('orphanPolicy' in patch && !['remove', 'keep'].includes(patch.orphanPolicy)) {
            throw Object.assign(new Error('orphanPolicy must be remove or keep'), { statusCode: 400 });
        }
        if ('orphanRetentionDays' in patch && (!Number.isInteger(patch.orphanRetentionDays) || patch.orphanRetentionDays < -1)) {
            throw Object.assign(new Error('orphanRetentionDays must be an integer >= -1'), { statusCode: 400 });
        }
        const next = { ...this.#workspace.databaseSettings, ...patch };
        this.#runtime.state.configStore.set('database', next);
        this.#workspace.emit('databaseSettings.changed', { workspaceId: this.#workspace.id, settings: next });
        return next;
    }

    /** Purge orphaned (feature/orphaned) documents past the retention window. */
    async gcOrphanedDocuments(options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.gcOrphanedDocuments(options);
    }

    setServiceConfig(serviceName, config) {
        const services = this.#workspace.services;
        services[serviceName] = { ...services[serviceName], ...config };
        this.#runtime.state.configStore.set('services', this.#runtime.state.crypto.protect(services));
        this.#workspace.emit('services.changed', { service: serviceName, config: redactSecrets(this.#workspace.services[serviceName]) });
    }

    setPublicCanvasShares(shares) {
        if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return false;
        this.#runtime.state.configStore.set('publicCanvasShares', shares);
        this.#workspace.emit('publicCanvasShares.changed', { id: this.#workspace.id, publicCanvasShares: shares });
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Links
    // ─────────────────────────────────────────────────────────────────────────

    listLinks(type = null) {
        const links = this.#workspace.links || {};
        if (!type) return links;
        return Array.isArray(links[type]) ? links[type] : [];
    }

    addLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.#workspace.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (arr.includes(ref)) return true;

        links[type] = [...arr, ref];
        this.#runtime.state.configStore.set('links', links);
        this.#workspace.emit('links.changed', { id: this.#workspace.id, type, action: 'add', ref });
        return true;
    }

    removeLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.#workspace.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (!arr.length) return true;

        links[type] = arr.filter(r => r !== ref);
        this.#runtime.state.configStore.set('links', links);
        this.#workspace.emit('links.changed', { id: this.#workspace.id, type, action: 'remove', ref });
        return true;
    }

    static #mergeConfigMap(defaults, overrides) {
        const out = {};
        for (const [key, value] of Object.entries(defaults || {})) {
            out[key] = { ...(value || {}) };
        }
        for (const [key, value] of Object.entries(overrides || {})) {
            out[key] = { ...(out[key] || {}), ...(value || {}) };
        }
        return out;
    }

    static resolveWorkspaceRoot(value, rootPath) {
        if (typeof value !== 'string') return value;
        return value.replaceAll('{WORKSPACE_ROOT}', rootPath);
    }
}
