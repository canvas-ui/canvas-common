import EventEmitter from 'eventemitter2';
import WorkspaceCrypto, { protectionError, redactSecrets } from './security/WorkspaceCrypto.js';
import { workspaceStopped } from './runtime/errors.js';
import * as fsPromises from 'fs/promises';

import { createLogger } from '../../utils/log.js';
import Db from 'canvas-synapsd';
import { BACKENDS_TREE_NAME } from '../../utils/backend-documents.js';
import { WorkspaceTokens } from './security/WorkspaceTokens.js';
import { WorkspaceMembers } from './security/WorkspaceMembers.js';
import { instrumentDb } from '../../utils/perf-monitor.js';
import WorkspaceTrashOperations from './services/trash/index.js';
import { WORKSPACE_STATUS_CODES } from './configuration/constants.js';
import { createWorkspaceState } from './runtime/state.js';
import WorkspaceConfiguration from './configuration/WorkspaceConfiguration.js';
import WorkspacePins from './navigation/WorkspacePins.js';
import WorkspaceDocuments from './documents/WorkspaceDocuments.js';
import WorkspaceInference from './inference/WorkspaceInference.js';
import WorkspaceTrash from './documents/WorkspaceTrash.js';
import WorkspaceTimelines from './queries/WorkspaceTimelines.js';
import WorkspaceQueries from './queries/WorkspaceQueries.js';
import WorkspaceTrees from './trees/WorkspaceTrees.js';
import WorkspaceIndexes from './queries/WorkspaceIndexes.js';
import WorkspaceBackends from './storage/WorkspaceBackends.js';
import WorkspaceObjects from './storage/WorkspaceObjects.js';
import WorkspaceTransfers from './storage/WorkspaceTransfers.js';
import WorkspaceReplicas from './storage/WorkspaceReplicas.js';
import WorkspaceContainers from './storage/WorkspaceContainers.js';
import WorkspaceContent from './storage/WorkspaceContent.js';
import WorkspaceServices from './runtime/WorkspaceServices.js';
import WorkspaceContacts from './services/contacts/WorkspaceContacts.js';
import WorkspaceMessaging from './services/messages/WorkspaceMessaging.js';
import OperationMonitor from './runtime/OperationMonitor.js';

// Stable public API and runtime lifecycle. Domain collaborators live beside it.
class Workspace extends EventEmitter {
    #runtime;

    // Tree names
    static CONTEXT_TREE_NAME = 'context';
    static DIRECTORY_TREE_NAME = 'directory';
    // Dedicated backend-mirror tree (type directory, linkContextRoot:false).
    // Paths inside it are /<driver>/<resource-address>/<resource-path>.
    static BACKENDS_TREE_NAME = BACKENDS_TREE_NAME;
    // Where a document goes when a filesystem-style delete removes its LAST
    // placement. A real path in the default directory tree — so listing,
    // restoring and emptying are ordinary tree operations — but dot-prefixed so
    // it stays out of `Trees/directory/` listings; WebDAV and canvas-fuse
    // present it as `Trash/` at the workspace root.
    static TRASH_PATH = '/.trash';
    // Tree types (used by the db layer)
    static CONTEXT_TYPE = 'context';
    static DIRECTORY_TYPE = 'directory';
    // Default cosine-distance floor for the dense side of vector/hybrid search.
    // synapsd applies no floor by default (pure mechanism); Workspace sets the
    // product policy: drop kNN neighbours past this cosine distance so the dense
    // side can't pollute results with "nearest but irrelevant" hits (kNN always
    // returns its top-K regardless of absolute similarity). 0.35 distance = 0.65
    // cosine similarity — a solid relevance bar for bge-small (normalized).
    // Empirically separates genuinely-related notes (~0.27) from degenerate
    // near-centroid embeddings of empty/trivial content (~0.40+), which match any
    // query. Callers may override via an explicit maxDistance (pass 2 to disable).
    static DEFAULT_MAX_COSINE_DISTANCE = 0.35;
    // Per-backend enable-lock holder prefix on /<driver>/<address> in the
    // backends tree
    static BACKEND_NODE_LOCK_PREFIX = 'system:backend:';
    get trashOperations() { return this.#runtime.state.trashOperations ??= new WorkspaceTrashOperations({ workspace: this, state: this.#getActiveDb().internalStore }); }
    isRemovalHeld(id) { return this.trashOperations.held(id); }

    get storagePolicyService() { return this.#runtime.state.storagePolicyService; }
    get storageOperations() { return this.#runtime.state.storedIndex?.stored?.replicas; }

    constructor(options) {
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {})
        });
        this.#runtime = { state: createWorkspaceState() };
        this.#runtime.config = new WorkspaceConfiguration(this, this.#runtime);
        this.#runtime.pins = new WorkspacePins(this, this.#runtime);
        this.#runtime.docs = new WorkspaceDocuments(this, this.#runtime);
        this.#runtime.inference = new WorkspaceInference(this, this.#runtime);
        this.#runtime.trash = new WorkspaceTrash(this, this.#runtime);
        this.#runtime.timelines = new WorkspaceTimelines(this, this.#runtime);
        this.#runtime.queries = new WorkspaceQueries(this, this.#runtime);
        this.#runtime.trees = new WorkspaceTrees(this, this.#runtime);
        this.#runtime.indexes = new WorkspaceIndexes(this, this.#runtime);
        this.#runtime.backends = new WorkspaceBackends(this, this.#runtime);
        this.#runtime.objects = new WorkspaceObjects(this, this.#runtime);
        this.#runtime.transfers = new WorkspaceTransfers(this, this.#runtime);
        this.#runtime.replicas = new WorkspaceReplicas(this, this.#runtime);
        this.#runtime.containers = new WorkspaceContainers(this, this.#runtime);
        this.#runtime.content = new WorkspaceContent(this, this.#runtime);
        this.#runtime.integrations = new WorkspaceServices(this, this.#runtime);
        this.#runtime.contacts = new WorkspaceContacts(this, this.#runtime);
        this.#runtime.messages = new WorkspaceMessaging(this, this.#runtime);
        this.#runtime.getActiveDb = this.#getActiveDb.bind(this);
        this.#runtime.createRuntimeListener = this.#createRuntimeListener.bind(this);
        this.options = options;

        if (!options.rootPath) throw new Error('Root path is required');
        if (!options.configStore) throw new Error('Config store is required');

        this.#runtime.state.rootPath = options.rootPath;
        this.#runtime.state.crypto = new WorkspaceCrypto(options.rootPath);
        this.#runtime.state.configStore = options.configStore;
        this.#runtime.state.logger = options.logger || createLogger('workspace');
        this.#runtime.operations = new OperationMonitor(report => this.#runtime.state.logger.warn(
            { workspaceId: this.id, ...report }, 'Workspace operations still pending'));
        this.#runtime.state.configuredInferd = options.inferd || null;
        this.#runtime.state.inferd = this.#runtime.state.configuredInferd;

        this.#runtime.state.tokens = new WorkspaceTokens({ configStore: this.#runtime.state.configStore, workspaceId: this.id });
        this.#runtime.state.members = new WorkspaceMembers({ configStore: this.#runtime.state.configStore });

        // A persisted active flag is not a live runtime after a restart.
        if (this.#runtime.state.configStore.get('status') === WORKSPACE_STATUS_CODES.ACTIVE) {
            this.#runtime.state.configStore.set('lastStopReason', 'server-restart');
            this.#runtime.state.configStore.set('stoppedAt', new Date().toISOString());
            this.#runtime.state.configStore.set('status', WORKSPACE_STATUS_CODES.INACTIVE);
        }
    }
    get status() { return this.#runtime.state.status; }
    get runtimeDiagnostics() { return this.#runtime.operations.snapshot(); }
    get isActive() { return this.#runtime.state.status === WORKSPACE_STATUS_CODES.ACTIVE; }
    assertActive() { if (!this.isActive) throw workspaceStopped(this); }

    get db() {
        if (!this.#runtime.state.db) throw new Error('Database not initialized');
        return this.#runtime.state.db;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    // Concurrent callers (WebDAV auto-start fires one per parallel request)
    // must share ONE in-flight start: isActive only flips near the end, so an
    // unserialized second call would re-run the whole sequence against a fresh
    // #db whose tree registry isn't loaded yet — duplicating the pre-created
    // trees ("context" et al.) in LMDB.
    async start(options = {}) {
        if (this.#runtime.state.protectionPromise) throw protectionError('WORKSPACE_BUSY', 'Workspace protection is being changed', 409);
        if (this.isActive) return this;
        if (this.#runtime.state.startPromise) return this.#runtime.state.startPromise;
        this.#runtime.state.startPromise = this.#runtime.operations.run('start', () => this.#doStart(options))
            .finally(() => { this.#runtime.state.startPromise = null; });
        return this.#runtime.state.startPromise;
    }

    async #doStart({ passphrase, withoutSecrets = false } = {}) {
        this.#runtime.state.logger.debug({ workspaceId: this.id }, 'Starting workspace');
        let startupStage = 'configuration';
        const stage = (name) => {
            startupStage = name;
            this.#runtime.state.logger.info({ workspaceId: this.id, stage: name }, 'Workspace startup stage');
        };
        try {
            this.#runtime.state.withoutSecrets = false;
            const configuredMode = this.#runtime.state.configStore.get('protection')?.mode;
            if (configuredMode && configuredMode !== 'none' && !this.#runtime.state.crypto.protected) {
                throw protectionError('WORKSPACE_KEYS_CORRUPT', 'Workspace keyslot file is missing');
            }
            if (this.#runtime.state.crypto.protected) {
                const mode = this.#runtime.state.crypto.mode;
                if (withoutSecrets && mode === 'secrets' && !passphrase) this.#runtime.state.withoutSecrets = true;
                else await this.#runtime.state.crypto.unlock(passphrase);
            } else if (withoutSecrets) this.#runtime.state.withoutSecrets = true;
            this.#runtime.state.inferd = this.#runtime.state.withoutSecrets ? null : this.#runtime.state.configuredInferd;
            this.#runtime.config.migrateConfigSchema();
            this.#runtime.config.migrateSecrets();
            this.#runtime.config.assertLayoutSane();
            await Promise.all([
                // `home` layout: the internals dir must exist before anything
                // below it is created, and it is the one dir the user's drive
                // (= the root) must never surface.
                ...(this.internalsPath ? [fsPromises.mkdir(this.internalsPath, { recursive: true })] : []),
                fsPromises.mkdir(this.cachePath, { recursive: true }),
                fsPromises.mkdir(this.dataPath, { recursive: true }),
                fsPromises.mkdir(this.homePath, { recursive: true }),
                fsPromises.mkdir(this.hooksPath, { recursive: true }),
            ]);

            const dbPath = this.dbPath;
            // Resolve this workspace's embedding backends BEFORE synapsd starts:
            // the vector spaces (tables + ledger keys) are latched at Db
            // construction. workspace.json wins over the owner's defaults, so a
            // moved/standalone workspace keeps embedding as its vectors were built.
            const inferdSpaces = !this.#runtime.state.withoutSecrets && this.#runtime.state.inferd?.spaceConfigsForWorkspace
                ? await this.#runtime.state.inferd.spaceConfigsForWorkspace(this.id, { userId: this.owner, config: this.#runtime.config.resolveCredentials(this.inferdConfig) }).catch((err) => {
                    this.#runtime.state.logger.warn({ workspaceId: this.id, error: err.message }, 'inferd space config resolve failed; using defaults');
                    return undefined;
                })
                : undefined;
            stage('database.open');
            this.#runtime.state.db = new Db({
                path: dbPath,
                // synapsd owns no model; if the inferd service is present, hand it
                // the query embedder so dense/hybrid search works. Absent → FTS.
                semantic: !this.#runtime.state.withoutSecrets && this.#runtime.state.inferd
                    ? {
                        // Bound to the OWNER: a query must be embedded by the same
                        // model that filled the space, or the kNN is noise.
                        embedQuery: (text, space) => this.#runtime.state.inferd.embedQueryForWorkspace(this.id, text, space),
                        // The inferd router owns each space's model + dim, so it also
                        // owns where those vectors live: a space on its baseline model
                        // keeps the original table, any other model gets its own table
                        // AND its own presence/seen ledger. That is what makes a model
                        // swap reversible — switch back and the previous vectors are
                        // still there, still marked embedded, nothing to redo.
                        spaces: inferdSpaces,
                        // Workspace-level search tuning (persisted in workspace.json
                        // under `semantic`). Undefined → synapsd defaults.
                        imageMaxDistance: (this.#runtime.state.configStore.get('semantic', {}) || {}).imageMaxDistance,
                        imageFloorMode: (this.#runtime.state.configStore.get('semantic', {}) || {}).imageFloorMode,
                        imageRelativeMargin: (this.#runtime.state.configStore.get('semantic', {}) || {}).imageRelativeMargin,
                        searchWeights: (this.#runtime.state.configStore.get('semantic', {}) || {}).searchWeights,
                    }
                    : undefined,
                // Every synapsd write shares one lock, so a 2 ms paste can wait
                // seconds behind ingest/embedding work. Name the holders when it
                // does (CANVAS_SLOW_WRITE_MS, default 1000).
                slowWriteMs: Number(process.env.CANVAS_SLOW_WRITE_MS) || 1000,
                onSlowWrite: (report) => this.#runtime.state.logger.warn({ workspaceId: this.id, ...report }, report.pending
                    ? 'Synapsd write still pending' : 'Slow synapsd write completed'),
            });
            instrumentDb(this.#runtime.state.db);
            stage('database.initialize');
            await this.#runtime.operations.run('start.database', () => this.#runtime.state.db.start());
            stage('trees.initialize');
            await this.#runtime.operations.run('start.context-tree', () => this.#runtime.trees.ensureContextTree());
            await this.#runtime.operations.run('start.directory-tree', () => this.#runtime.trees.ensureDirectoryTree());
            await this.#runtime.operations.run('start.backends-tree', () => this.#runtime.trees.ensureBackendsTree());
            stage('inference.register');
            this.#bindRuntimeEvents();
            this.#runtime.inference.registerInferd();
            // Resume interrupted embedding: the inferd queue is in-memory, so a
            // restart mid-ingest strands docs in the durable bitmap ledger until
            // something re-drives them. Reconcile is a cheap idempotent bitmap
            // read when there is no gap — safe to fire on every start.
            if (!this.#runtime.state.withoutSecrets && this.#runtime.state.inferd?.reconcile) {
                this.#runtime.state.inferd.reconcile(this.id).then((r) => {
                    if (r?.enqueued > 0) {
                        this.#runtime.state.logger.info({ workspaceId: this.id, enqueued: r.enqueued }, 'Embedding reconcile resumed pending docs');
                    }
                }).catch((err) =>
                    this.#runtime.state.logger.warn({ workspaceId: this.id, error: err.message }, 'Start-time embedding reconcile failed'));
            }
            // Mark ACTIVE before booting stored/mail indices: their initial sync
            // (IMAP scan → ingestMessage → #put → #getActiveDb) needs isActive,
            // otherwise every fetched message rejects with "Workspace not active".
            stage('services.start');
            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            if (this.isServiceEnabled('home') || Object.values(this.dataBackends).some(cfg => cfg?.enabled && cfg.supported !== false)) {
                await this.#runtime.operations.run('start.services', () => this.#runtime.integrations.startStoredIndex());
                for (const [name, cfg] of Object.entries(this.dataBackends)) {
                    if (!cfg?.enabled || !cfg.resync || cfg.supported === false || !(cfg.scanOnStart ?? (cfg.driver === 'file'))) continue;
                    // Reconcile files changed while the workspace was stopped.
                    // Keep startup responsive; cached checksums make unchanged
                    // files cheap, and resync state drives the UI progress indicator.
                    // Remote mounts retain their existing catch-up behavior.
                    try { this.#runtime.state.storedIndex.resyncInBackground(name); } catch (err) {
                        this.#runtime.state.logger.warn({ workspaceId: this.id, backend: name, error: err.message }, 'Start-time resync failed to start');
                    }
                }
            }

            this.#runtime.contacts.startContactExtraction();
            // Background, once per workspace: never delays start.
            this.#runtime.contacts.runDataMigrations().catch((err) =>
                this.#runtime.state.logger.warn({ workspaceId: this.id, error: err.message }, 'Data migrations failed; will retry on next start'));

            stage('ready');
            this.emit('started', { id: this.id });
            return this;
        } catch (err) {
            this.#runtime.state.logger.error({ workspaceId: this.id, stage: startupStage, err }, 'Failed to start workspace');
            try { await this.#runtime.integrations.stopStoredIndex(); } catch { /* continue cleanup */ }
            await this.#runtime.contacts.stopContactExtraction();
            this.#runtime.inference.unregisterInferd();
            await Promise.allSettled([...this.#runtime.state.embedEligibilityPending]);
            this.#unbindRuntimeEvents();
            try { await this.#runtime.state.db?.shutdown(); } catch { /* continue cleanup */ }
            this.#runtime.state.db = null;
            this.#runtime.state.crypto.stop();
            this.#runtime.state.withoutSecrets = false;
            this.#setStatus(WORKSPACE_STATUS_CODES.INACTIVE);
            throw err;
        }
    }

    async stop(reason = 'user-request') {
        if (this.#runtime.state.protectionPromise) { try { await this.#runtime.state.protectionPromise; } catch { /* release keys below */ } }
        if (this.#runtime.state.startPromise) { try { await this.#runtime.state.startPromise; } catch { /* already stopped */ } }
        this.#runtime.state.configStore.set('lastStopReason', reason);
        this.#runtime.state.configStore.set('stoppedAt', new Date().toISOString());
        if (this.#runtime.state.status === WORKSPACE_STATUS_CODES.INACTIVE) { this.#runtime.state.crypto.stop(); return true; }

        this.#runtime.state.logger.debug({ workspaceId: this.id }, 'Stopping workspace');
        try {
            this.#runtime.inference.unregisterInferd();
            await Promise.allSettled([...this.#runtime.state.embedEligibilityPending]);
            // Sessions subscribe to db events and hold its bitmaps — drop them
            // before the db goes away, or they keep firing against a dead handle.
            this.#runtime.queries.closeSessions();
            await this.#runtime.integrations.stopStoredIndex();
            await this.#runtime.contacts.stopContactExtraction();
            if (this.#runtime.state.db) {
                this.#unbindRuntimeEvents();
                await this.#runtime.state.db.shutdown();
                this.#runtime.state.db = null;
            }
            this.#setStatus(WORKSPACE_STATUS_CODES.INACTIVE);
            this.emit('stopped', { id: this.id });
            return true;
        } catch (err) {
            console.error(`Error stopping workspace "${this.id}": ${err.message}`);
            this.#setStatus(WORKSPACE_STATUS_CODES.ERROR);
            return false;
        } finally {
            this.#runtime.state.crypto.stop();
            this.#runtime.state.withoutSecrets = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CRUD Methods
    // ─────────────────────────────────────────────────────────────────────────

    #getActiveDb() {
        if (!this.isActive || !this.#runtime.state.db) throw workspaceStopped(this);
        return this.#runtime.state.db;
    }

    toJSON() {
        return {
            ...redactSecrets(this.config),
            id: this.id,
            owner: this.owner,
            icon: this.icon,
            homeScreen: this.homeScreen,
            status: this.status,
            protection: this.protection,
            lastStopReason: this.lastStopReason,
            stoppedAt: this.stoppedAt,
            isActive: this.isActive,
            rootPath: this.rootPath
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Runtime event forwarding
    // ─────────────────────────────────────────────────────────────────────────

    #setStatus(status) {
        if (this.#runtime.state.status !== status) {
            this.#runtime.state.status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }

    #bindRuntimeEvents() {
        this.#unbindRuntimeEvents();
        if (!this.#runtime.state.db) return;
        this.#runtime.state.runtimeListeners = [this.#createRuntimeListener(this.#runtime.state.db, 'db')].filter(Boolean);
    }

    #unbindRuntimeEvents() {
        for (const binding of this.#runtime.state.runtimeListeners) {
            binding.emitter.off('**', binding.listener);
        }
        this.#runtime.state.runtimeListeners = [];
    }

    #createRuntimeListener(emitter, source) {
        if (!emitter?.on) return null;

        const workspace = this;
        const listener = function (payload = {}) {
            const eventName = this.event;
            if (!eventName) return;

            const eventPayload = payload && typeof payload === 'object'
                ? { ...payload }
                : { value: payload };

            if (!eventPayload.workspaceId) eventPayload.workspaceId = workspace.id;
            if (!eventPayload.source) eventPayload.source = source;

            workspace.emit(eventName, eventPayload);
        };

        emitter.on('**', listener);
        return { emitter, listener };
    }

    get id() { return this.#runtime.config.id; }
    get name() { return this.#runtime.config.name; }
    get label() { return this.#runtime.config.label; }
    get description() { return this.#runtime.config.description; }
    get color() { return this.#runtime.config.color; }
    get icon() { return this.#runtime.config.icon; }
    get homeScreen() { return this.#runtime.config.homeScreen; }
    get links() { return this.#runtime.config.links; }
    get type() { return this.#runtime.config.type; }
    get layout() { return this.#runtime.config.layout; }
    get internalsPath() { return this.#runtime.config.internalsPath; }
    get owner() { return this.#runtime.config.owner; }
    get rootPath() { return this.#runtime.config.rootPath; }
    get protection() { return this.#runtime.config.protection; }
    get lastStopReason() { return this.#runtime.config.lastStopReason; }
    get stoppedAt() { return this.#runtime.config.stoppedAt; }
    configureProtection(...args) { return this.#runtime.operations.run('config.configureProtection', () => this.#runtime.config.configureProtection(...args)); }
    resolveIntegrationConfig(...args) { return this.#runtime.operations.run('config.resolveIntegrationConfig', () => this.#runtime.config.resolveIntegrationConfig(...args)); }
    get config() { return this.#runtime.config.config; }
    get acl() { return this.#runtime.config.acl; }
    get publicCanvasShares() { return this.#runtime.config.publicCanvasShares; }
    get dataBackends() { return this.#runtime.config.dataBackends; }
    get services() { return this.#runtime.config.services; }
    get inferdConfig() { return this.#runtime.config.inferdConfig; }
    imageSummaryStatus(...args) { return this.#runtime.operations.run('inference.imageSummaryStatus', () => this.#runtime.inference.imageSummaryStatus(...args)); }
    setInferdConfig(...args) { return this.#runtime.operations.run('inference.setInferdConfig', () => this.#runtime.inference.setInferdConfig(...args)); }
    startImageSummaries(...args) { return this.#runtime.operations.run('inference.startImageSummaries', () => this.#runtime.inference.startImageSummaries(...args)); }
    stopImageSummaries(...args) { return this.#runtime.operations.run('inference.stopImageSummaries', () => this.#runtime.inference.stopImageSummaries(...args)); }
    imageDocumentIds(...args) { return this.#runtime.operations.run('inference.imageDocumentIds', () => this.#runtime.inference.imageDocumentIds(...args)); }
    setDocumentSummary(...args) { return this.#runtime.operations.run('inference.setDocumentSummary', () => this.#runtime.inference.setDocumentSummary(...args)); }
    get stats() { return this.#runtime.config.stats; }
    getStats(...args) { return this.#runtime.operations.run('config.getStats', () => this.#runtime.config.getStats(...args)); }
    setSearchTuning(...args) { return this.#runtime.operations.run('config.setSearchTuning', () => this.#runtime.config.setSearchTuning(...args)); }
    get homePath() { return this.#runtime.config.homePath; }
    get dataPath() { return this.#runtime.config.dataPath; }
    get cachePath() { return this.#runtime.config.cachePath; }
    get dbPath() { return this.#runtime.config.dbPath; }
    get storedRootPath() { return this.#runtime.config.storedRootPath; }
    get gitPath() { return this.#runtime.config.gitPath; }
    get gitInternalPath() { return this.#runtime.config.gitInternalPath; }
    get hooksPath() { return this.#runtime.config.hooksPath; }
    get scriptsPath() { return this.#runtime.config.scriptsPath; }
    get configDir() { return this.#runtime.config.configDir; }
    get rolesPath() { return this.#runtime.config.rolesPath; }
    get varPath() { return this.#runtime.config.varPath; }
    get varHooksPath() { return this.#runtime.config.varHooksPath; }
    get internalPaths() { return this.#runtime.config.internalPaths; }
    isDataBackendEnabled(...args) { return this.#runtime.operations.run('config.isDataBackendEnabled', () => this.#runtime.config.isDataBackendEnabled(...args)); }
    isServiceEnabled(...args) { return this.#runtime.operations.run('config.isServiceEnabled', () => this.#runtime.config.isServiceEnabled(...args)); }
    setDataBackendConfig(...args) { return this.#runtime.operations.run('config.setDataBackendConfig', () => this.#runtime.config.setDataBackendConfig(...args)); }
    get databaseSettings() { return this.#runtime.config.databaseSettings; }
    setDatabaseSettings(...args) { return this.#runtime.operations.run('config.setDatabaseSettings', () => this.#runtime.config.setDatabaseSettings(...args)); }
    gcOrphanedDocuments(...args) { return this.#runtime.operations.run('config.gcOrphanedDocuments', () => this.#runtime.config.gcOrphanedDocuments(...args)); }
    setServiceConfig(...args) { return this.#runtime.operations.run('config.setServiceConfig', () => this.#runtime.config.setServiceConfig(...args)); }
    setPublicCanvasShares(...args) { return this.#runtime.operations.run('config.setPublicCanvasShares', () => this.#runtime.config.setPublicCanvasShares(...args)); }
    listLinks(...args) { return this.#runtime.operations.run('config.listLinks', () => this.#runtime.config.listLinks(...args)); }
    addLink(...args) { return this.#runtime.operations.run('config.addLink', () => this.#runtime.config.addLink(...args)); }
    removeLink(...args) { return this.#runtime.operations.run('config.removeLink', () => this.#runtime.config.removeLink(...args)); }
    get pins() { return this.#runtime.pins.pins; }
    static normalizePinPath(...args) { return WorkspacePins.normalizePinPath(...args); }
    addPin(...args) { return this.#runtime.operations.run('pins.addPin', () => this.#runtime.pins.addPin(...args)); }
    removePin(...args) { return this.#runtime.operations.run('pins.removePin', () => this.#runtime.pins.removePin(...args)); }
    reorderPins(...args) { return this.#runtime.operations.run('pins.reorderPins', () => this.#runtime.pins.reorderPins(...args)); }
    listPins(...args) { return this.#runtime.operations.run('pins.listPins', () => this.#runtime.pins.listPins(...args)); }
    put(...args) { return this.#runtime.operations.run('docs.put', () => this.#runtime.docs.put(...args)); }
    link(...args) { return this.#runtime.operations.run('docs.link', () => this.#runtime.docs.link(...args)); }
    static THREAD_CASCADE_LIMIT = WorkspaceDocuments.THREAD_CASCADE_LIMIT;
    static leafPaths(...args) { return WorkspaceDocuments.leafPaths(...args); }
    inheritThreadMemberships(...args) { return this.#runtime.operations.run('docs.inheritThreadMemberships', () => this.#runtime.docs.inheritThreadMemberships(...args)); }
    unlink(...args) { return this.#runtime.operations.run('docs.unlink', () => this.#runtime.docs.unlink(...args)); }
    delete(...args) { return this.#runtime.operations.run('docs.delete', () => this.#runtime.docs.delete(...args)); }
    get(...args) { return this.#runtime.operations.run('docs.get', () => this.#runtime.docs.get(...args)); }
    has(...args) { return this.#runtime.operations.run('docs.has', () => this.#runtime.docs.has(...args)); }
    putMany(...args) { return this.#runtime.operations.run('docs.putMany', () => this.#runtime.docs.putMany(...args)); }
    storeDocumentEmbeddings(...args) { return this.#runtime.operations.run('inference.storeDocumentEmbeddings', () => this.#runtime.inference.storeDocumentEmbeddings(...args)); }
    applyInferdSpaces(...args) { return this.#runtime.operations.run('inference.applyInferdSpaces', () => this.#runtime.inference.applyInferdSpaces(...args)); }
    documentIdsUnderScope(...args) { return this.#runtime.operations.run('inference.documentIdsUnderScope', () => this.#runtime.inference.documentIdsUnderScope(...args)); }
    getUnembeddedDocIds(...args) { return this.#runtime.operations.run('inference.getUnembeddedDocIds', () => this.#runtime.inference.getUnembeddedDocIds(...args)); }
    clearSpace(...args) { return this.#runtime.operations.run('inference.clearSpace', () => this.#runtime.inference.clearSpace(...args)); }
    listVectorTables(...args) { return this.#runtime.operations.run('inference.listVectorTables', () => this.#runtime.inference.listVectorTables(...args)); }
    dropVectorTable(...args) { return this.#runtime.operations.run('inference.dropVectorTable', () => this.#runtime.inference.dropVectorTable(...args)); }
    resolveEmbeddingInput(...args) { return this.#runtime.operations.run('inference.resolveEmbeddingInput', () => this.#runtime.inference.resolveEmbeddingInput(...args)); }
    linkMany(...args) { return this.#runtime.operations.run('docs.linkMany', () => this.#runtime.docs.linkMany(...args)); }
    unlinkMany(...args) { return this.#runtime.operations.run('docs.unlinkMany', () => this.#runtime.docs.unlinkMany(...args)); }
    deleteMany(...args) { return this.#runtime.operations.run('docs.deleteMany', () => this.#runtime.docs.deleteMany(...args)); }
    clearThumbnailCache(...args) { return this.#runtime.operations.run('docs.clearThumbnailCache', () => this.#runtime.docs.clearThumbnailCache(...args)); }
    resolveDocument(...args) { return this.#runtime.operations.run('content.resolveDocument', () => this.#runtime.content.resolveDocument(...args)); }
    persistBlob(...args) { return this.#runtime.operations.run('content.persistBlob', () => this.#runtime.content.persistBlob(...args)); }
    statBlobByChecksum(...args) { return this.#runtime.operations.run('content.statBlobByChecksum', () => this.#runtime.content.statBlobByChecksum(...args)); }
    getByChecksumString(...args) { return this.#runtime.operations.run('docs.getByChecksumString', () => this.#runtime.docs.getByChecksumString(...args)); }
    listDocumentTreeMemberships(...args) { return this.#runtime.operations.run('docs.listDocumentTreeMemberships', () => this.#runtime.docs.listDocumentTreeMemberships(...args)); }
    listDocumentPlacements(...args) { return this.#runtime.operations.run('docs.listDocumentPlacements', () => this.#runtime.docs.listDocumentPlacements(...args)); }
    assertRelation(...args) { return this.#runtime.operations.run('docs.assertRelation', () => this.#runtime.docs.assertRelation(...args)); }
    retractRelation(...args) { return this.#runtime.operations.run('docs.retractRelation', () => this.#runtime.docs.retractRelation(...args)); }
    messageThread(...args) { return this.#runtime.operations.run('docs.messageThread', () => this.#runtime.docs.messageThread(...args)); }
    listDocumentRelations(...args) { return this.#runtime.operations.run('docs.listDocumentRelations', () => this.#runtime.docs.listDocumentRelations(...args)); }
    getTrashSelector(...args) { return this.#runtime.operations.run('trash.getTrashSelector', () => this.#runtime.trash.getTrashSelector(...args)); }
    observeSourceRemoval(...args) { return this.#runtime.operations.run('trash.observeSourceRemoval', () => this.#runtime.trash.observeSourceRemoval(...args)); }
    finishRemovalObservation(...args) { return this.#runtime.operations.run('trash.finishRemovalObservation', () => this.#runtime.trash.finishRemovalObservation(...args)); }
    trashFromSourceLoss(...args) { return this.#runtime.operations.run('trash.trashFromSourceLoss', () => this.#runtime.trash.trashFromSourceLoss(...args)); }
    removeTrackedCopy(...args) { return this.#runtime.operations.run('trash.removeTrackedCopy', () => this.#runtime.trash.removeTrackedCopy(...args)); }
    verifyRemovalSource(...args) { return this.#runtime.operations.run('trash.verifyRemovalSource', () => this.#runtime.trash.verifyRemovalSource(...args)); }
    actOnRemovalCopy(...args) { return this.#runtime.operations.run('trash.actOnRemovalCopy', () => this.#runtime.trash.actOnRemovalCopy(...args)); }
    setMailboxRemovalPolicy(...args) { return this.#runtime.operations.run('trash.setMailboxRemovalPolicy', () => this.#runtime.trash.setMailboxRemovalPolicy(...args)); }
    listTrash(...args) { return this.#runtime.operations.run('trash.listTrash', () => this.#runtime.trash.listTrash(...args)); }
    restoreFromTrash(...args) { return this.#runtime.operations.run('trash.restoreFromTrash', () => this.#runtime.trash.restoreFromTrash(...args)); }
    emptyTrash(...args) { return this.#runtime.operations.run('trash.emptyTrash', () => this.#runtime.trash.emptyTrash(...args)); }
    listTimelines(...args) { return this.#runtime.operations.run('timelines.listTimelines', () => this.#runtime.timelines.listTimelines(...args)); }
    createTimeline(...args) { return this.#runtime.operations.run('timelines.createTimeline', () => this.#runtime.timelines.createTimeline(...args)); }
    hasTimeline(...args) { return this.#runtime.operations.run('timelines.hasTimeline', () => this.#runtime.timelines.hasTimeline(...args)); }
    deleteTimeline(...args) { return this.#runtime.operations.run('timelines.deleteTimeline', () => this.#runtime.timelines.deleteTimeline(...args)); }
    queryTimeline(...args) { return this.#runtime.operations.run('timelines.queryTimeline', () => this.#runtime.timelines.queryTimeline(...args)); }
    timelineHistogram(...args) { return this.#runtime.operations.run('timelines.timelineHistogram', () => this.#runtime.timelines.timelineHistogram(...args)); }
    insertTimelineEntry(...args) { return this.#runtime.operations.run('timelines.insertTimelineEntry', () => this.#runtime.timelines.insertTimelineEntry(...args)); }
    insertTimelineEntries(...args) { return this.#runtime.operations.run('timelines.insertTimelineEntries', () => this.#runtime.timelines.insertTimelineEntries(...args)); }
    removeTimelineEntry(...args) { return this.#runtime.operations.run('timelines.removeTimelineEntry', () => this.#runtime.timelines.removeTimelineEntry(...args)); }
    getTimelineScales(...args) { return this.#runtime.operations.run('timelines.getTimelineScales', () => this.#runtime.timelines.getTimelineScales(...args)); }
    decomposeTimelineRange(...args) { return this.#runtime.operations.run('timelines.decomposeTimelineRange', () => this.#runtime.timelines.decomposeTimelineRange(...args)); }
    hasByChecksumString(...args) { return this.#runtime.operations.run('docs.hasByChecksumString', () => this.#runtime.docs.hasByChecksumString(...args)); }
    emitTreeDocumentEvent(...args) { return this.#runtime.operations.run('docs.emitTreeDocumentEvent', () => this.#runtime.docs.emitTreeDocumentEvent(...args)); }
    list(...args) { return this.#runtime.operations.run('queries.list', () => this.#runtime.queries.list(...args)); }
    search(...args) { return this.#runtime.operations.run('queries.search', () => this.#runtime.queries.search(...args)); }
    searchRefined(...args) { return this.#runtime.operations.run('queries.searchRefined', () => this.#runtime.queries.searchRefined(...args)); }
    searchCompound(...args) { return this.#runtime.operations.run('queries.searchCompound', () => this.#runtime.queries.searchCompound(...args)); }
    normalizeSessionSpec(...args) { return this.#runtime.operations.run('queries.normalizeSessionSpec', () => this.#runtime.queries.normalizeSessionSpec(...args)); }
    openSession(...args) { return this.#runtime.operations.run('queries.openSession', () => this.#runtime.queries.openSession(...args)); }
    buildMatch(...args) { return this.#runtime.operations.run('queries.buildMatch', () => this.#runtime.queries.buildMatch(...args)); }
    searchByImage(...args) { return this.#runtime.operations.run('queries.searchByImage', () => this.#runtime.queries.searchByImage(...args)); }
    getTree(...args) { return this.#runtime.operations.run('trees.getTree', () => this.#runtime.trees.getTree(...args)); }
    listTrees(...args) { return this.#runtime.operations.run('trees.listTrees', () => this.#runtime.trees.listTrees(...args)); }
    createTree(...args) { return this.#runtime.operations.run('trees.createTree', () => this.#runtime.trees.createTree(...args)); }
    renameTree(...args) { return this.#runtime.operations.run('trees.renameTree', () => this.#runtime.trees.renameTree(...args)); }
    destroyTree(...args) { return this.#runtime.operations.run('trees.destroyTree', () => this.#runtime.trees.destroyTree(...args)); }
    getContextTree(...args) { return this.#runtime.operations.run('trees.getContextTree', () => this.#runtime.trees.getContextTree(...args)); }
    getDirectoryTree(...args) { return this.#runtime.operations.run('trees.getDirectoryTree', () => this.#runtime.trees.getDirectoryTree(...args)); }
    getDefaultContextTree(...args) { return this.#runtime.operations.run('trees.getDefaultContextTree', () => this.#runtime.trees.getDefaultContextTree(...args)); }
    getDefaultDirectoryTree(...args) { return this.#runtime.operations.run('trees.getDefaultDirectoryTree', () => this.#runtime.trees.getDefaultDirectoryTree(...args)); }
    exportSubtree(...args) { return this.#runtime.operations.run('trees.exportSubtree', () => this.#runtime.trees.exportSubtree(...args)); }
    importSubtree(...args) { return this.#runtime.operations.run('trees.importSubtree', () => this.#runtime.trees.importSubtree(...args)); }
    removeBackendsTreePath(...args) { return this.#runtime.operations.run('trees.removeBackendsTreePath', () => this.#runtime.trees.removeBackendsTreePath(...args)); }
    destroyBackendsTreePath(...args) { return this.#runtime.operations.run('trees.destroyBackendsTreePath', () => this.#runtime.trees.destroyBackendsTreePath(...args)); }
    lockBackendTreeNode(...args) { return this.#runtime.operations.run('trees.lockBackendTreeNode', () => this.#runtime.trees.lockBackendTreeNode(...args)); }
    unlockBackendTreeNode(...args) { return this.#runtime.operations.run('trees.unlockBackendTreeNode', () => this.#runtime.trees.unlockBackendTreeNode(...args)); }
    getContextTreeSelector(...args) { return this.#runtime.operations.run('trees.getContextTreeSelector', () => this.#runtime.trees.getContextTreeSelector(...args)); }
    getDirectoryTreeSelector(...args) { return this.#runtime.operations.run('trees.getDirectoryTreeSelector', () => this.#runtime.trees.getDirectoryTreeSelector(...args)); }
    getBackendsTreeSelector(...args) { return this.#runtime.operations.run('trees.getBackendsTreeSelector', () => this.#runtime.trees.getBackendsTreeSelector(...args)); }
    getBackendsTree(...args) { return this.#runtime.operations.run('trees.getBackendsTree', () => this.#runtime.trees.getBackendsTree(...args)); }
    pruneEmptyBackendPaths(...args) { return this.#runtime.operations.run('trees.pruneEmptyBackendPaths', () => this.#runtime.trees.pruneEmptyBackendPaths(...args)); }
    sweepEmptyBackendPaths(...args) { return this.#runtime.operations.run('trees.sweepEmptyBackendPaths', () => this.#runtime.trees.sweepEmptyBackendPaths(...args)); }
    getDocumentsByIdArray(...args) { return this.#runtime.operations.run('indexes.getDocumentsByIdArray', () => this.#runtime.indexes.getDocumentsByIdArray(...args)); }
    listDatasets(...args) { return this.#runtime.operations.run('indexes.listDatasets', () => this.#runtime.indexes.listDatasets(...args)); }
    deleteDataset(...args) { return this.#runtime.operations.run('indexes.deleteDataset', () => this.#runtime.indexes.deleteDataset(...args)); }
    listBitmaps(...args) { return this.#runtime.operations.run('indexes.listBitmaps', () => this.#runtime.indexes.listBitmaps(...args)); }
    getBitmap(...args) { return this.#runtime.operations.run('indexes.getBitmap', () => this.#runtime.indexes.getBitmap(...args)); }
    deleteBitmap(...args) { return this.#runtime.operations.run('indexes.deleteBitmap', () => this.#runtime.indexes.deleteBitmap(...args)); }
    getBitmapRawBuffer(...args) { return this.#runtime.operations.run('indexes.getBitmapRawBuffer', () => this.#runtime.indexes.getBitmapRawBuffer(...args)); }
    clearDatabaseSync(...args) { return this.#runtime.operations.run('indexes.clearDatabaseSync', () => this.#runtime.indexes.clearDatabaseSync(...args)); }
    createToken(...args) { return this.#runtime.operations.run('tokens.create', () => this.#runtime.state.tokens.create(...args)); }
    listTokens(...args) { return this.#runtime.operations.run('tokens.list', () => this.#runtime.state.tokens.list(...args)); }
    deleteToken(...args) { return this.#runtime.operations.run('tokens.delete', () => this.#runtime.state.tokens.delete(...args)); }
    verifyToken(...args) { return this.#runtime.operations.run('tokens.verify', () => this.#runtime.state.tokens.verify(...args)); }
    get isUniverse() { return this.type === 'universe'; }
    listMembers(...args) { return this.#runtime.operations.run('members.list', () => this.#runtime.state.members.list(...args)); }
    getMember(...args) { return this.#runtime.operations.run('members.get', () => this.#runtime.state.members.get(...args)); }
    grantMember(...args) {
        return this.#runtime.operations.run('members.grant', () => {
            if (this.isUniverse) throw new Error('The universe workspace cannot be shared');
            return this.#runtime.state.members.grant(...args);
        });
    }
    revokeMember(...args) { return this.#runtime.operations.run('members.revoke', () => this.#runtime.state.members.revoke(...args)); }
    startHomeService(...args) { return this.#runtime.operations.run('backends.startHomeService', () => this.#runtime.backends.startHomeService(...args)); }
    stopHomeService(...args) { return this.#runtime.operations.run('backends.stopHomeService', () => this.#runtime.backends.stopHomeService(...args)); }
    messagingAccounts(...args) { return this.#runtime.operations.run('messages.messagingAccounts', () => this.#runtime.messages.messagingAccounts(...args)); }
    messageSendStatus(...args) { return this.#runtime.operations.run('messages.messageSendStatus', () => this.#runtime.messages.messageSendStatus(...args)); }
    messageReplyTarget(...args) { return this.#runtime.operations.run('messages.messageReplyTarget', () => this.#runtime.messages.messageReplyTarget(...args)); }
    sendMessage(...args) { return this.#runtime.operations.run('messages.sendMessage', () => this.#runtime.messages.sendMessage(...args)); }
    messageConnection(...args) { return this.#runtime.operations.run('messages.messageConnection', () => this.#runtime.messages.messageConnection(...args)); }
    listBackends(...args) { return this.#runtime.operations.run('backends.listBackends', () => this.#runtime.backends.listBackends(...args)); }
    listBackendDocuments(...args) { return this.#runtime.operations.run('backends.listBackendDocuments', () => this.#runtime.backends.listBackendDocuments(...args)); }
    listBackendsByDriver(...args) { return this.#runtime.operations.run('backends.listBackendsByDriver', () => this.#runtime.backends.listBackendsByDriver(...args)); }
    getBackend(...args) { return this.#runtime.operations.run('backends.getBackend', () => this.#runtime.backends.getBackend(...args)); }
    addBackend(...args) { return this.#runtime.operations.run('backends.addBackend', () => this.#runtime.backends.addBackend(...args)); }
    transferBackendObject(...args) { return this.#runtime.operations.run('objects.transferBackendObject', () => this.#runtime.objects.transferBackendObject(...args)); }
    writeBackendObject(...args) { return this.#runtime.operations.run('objects.writeBackendObject', () => this.#runtime.objects.writeBackendObject(...args)); }
    removeBackendObject(...args) { return this.#runtime.operations.run('objects.removeBackendObject', () => this.#runtime.objects.removeBackendObject(...args)); }
    renameBackendObject(...args) { return this.#runtime.operations.run('objects.renameBackendObject', () => this.#runtime.objects.renameBackendObject(...args)); }
    listBackendRetained(...args) { return this.#runtime.operations.run('objects.listBackendRetained', () => this.#runtime.objects.listBackendRetained(...args)); }
    listBackendTrash(...args) { return this.#runtime.operations.run('objects.listBackendTrash', () => this.#runtime.objects.listBackendTrash(...args)); }
    restoreBackendTrash(...args) { return this.#runtime.operations.run('objects.restoreBackendTrash', () => this.#runtime.objects.restoreBackendTrash(...args)); }
    discardBackendTrash(...args) { return this.#runtime.operations.run('objects.discardBackendTrash', () => this.#runtime.objects.discardBackendTrash(...args)); }
    getBackendTrashTree(...args) { return this.#runtime.operations.run('objects.getBackendTrashTree', () => this.#runtime.objects.getBackendTrashTree(...args)); }
    restoreBackendRetained(...args) { return this.#runtime.operations.run('objects.restoreBackendRetained', () => this.#runtime.objects.restoreBackendRetained(...args)); }
    statBackendObject(...args) { return this.#runtime.operations.run('objects.statBackendObject', () => this.#runtime.objects.statBackendObject(...args)); }
    listBackendObjects(...args) { return this.#runtime.operations.run('objects.listBackendObjects', () => this.#runtime.objects.listBackendObjects(...args)); }
    backendChanges(...args) { return this.#runtime.operations.run('objects.backendChanges', () => this.#runtime.objects.backendChanges(...args)); }
    get replicas() { return this.#runtime.replicas.replicas; }
    get requiredReplicas() { return this.#runtime.replicas.requiredReplicas; }
    setReplica(...args) { return this.#runtime.operations.run('replicas.setReplica', () => this.#runtime.replicas.setReplica(...args)); }
    removeReplica(...args) { return this.#runtime.operations.run('replicas.removeReplica', () => this.#runtime.replicas.removeReplica(...args)); }
    recordReplicaApplied(...args) { return this.#runtime.operations.run('replicas.recordReplicaApplied', () => this.#runtime.replicas.recordReplicaApplied(...args)); }
    forgetReplica(...args) { return this.#runtime.operations.run('replicas.forgetReplica', () => this.#runtime.replicas.forgetReplica(...args)); }
    replicaProtection(...args) { return this.#runtime.operations.run('replicas.replicaProtection', () => this.#runtime.replicas.replicaProtection(...args)); }
    resolveBackendObject(...args) { return this.#runtime.operations.run('objects.resolveBackendObject', () => this.#runtime.objects.resolveBackendObject(...args)); }
    resolveStoredUrl(...args) { return this.#runtime.operations.run('objects.resolveStoredUrl', () => this.#runtime.objects.resolveStoredUrl(...args)); }
    createSyncConflict(...args) { return this.#runtime.operations.run('replicas.createSyncConflict', () => this.#runtime.replicas.createSyncConflict(...args)); }
    listSyncConflicts(...args) { return this.#runtime.operations.run('replicas.listSyncConflicts', () => this.#runtime.replicas.listSyncConflicts(...args)); }
    resolveSyncConflict(...args) { return this.#runtime.operations.run('replicas.resolveSyncConflict', () => this.#runtime.replicas.resolveSyncConflict(...args)); }
    documentByteEndpoints(...args) { return this.#runtime.operations.run('transfers.documentByteEndpoints', () => this.#runtime.transfers.documentByteEndpoints(...args)); }
    transferDocumentBytes(...args) { return this.#runtime.operations.run('transfers.transferDocumentBytes', () => this.#runtime.transfers.transferDocumentBytes(...args)); }
    backendKeepsPaths(...args) { return this.#runtime.operations.run('transfers.backendKeepsPaths', () => this.#runtime.transfers.backendKeepsPaths(...args)); }
    transferDocumentsToBackends(...args) { return this.#runtime.operations.run('transfers.transferDocumentsToBackends', () => this.#runtime.transfers.transferDocumentsToBackends(...args)); }
    getBackendDiskUsage(...args) { return this.#runtime.operations.run('backends.getBackendDiskUsage', () => this.#runtime.backends.getBackendDiskUsage(...args)); }
    getDiskUsage(...args) { return this.#runtime.operations.run('backends.getDiskUsage', () => this.#runtime.backends.getDiskUsage(...args)); }
    updateBackend(...args) { return this.#runtime.operations.run('backends.updateBackend', () => this.#runtime.backends.updateBackend(...args)); }
    removeBackend(...args) { return this.#runtime.operations.run('backends.removeBackend', () => this.#runtime.backends.removeBackend(...args)); }
    syncBackend(...args) { return this.#runtime.operations.run('backends.syncBackend', () => this.#runtime.backends.syncBackend(...args)); }
    getBackendShape(...args) { return this.#runtime.operations.run('backends.getBackendShape', () => this.#runtime.backends.getBackendShape(...args)); }
    getBackendTreeRoot(...args) { return this.#runtime.operations.run('backends.getBackendTreeRoot', () => this.#runtime.backends.getBackendTreeRoot(...args)); }
    cancelSyncBackend(...args) { return this.#runtime.operations.run('backends.cancelSyncBackend', () => this.#runtime.backends.cancelSyncBackend(...args)); }
    testBackend(...args) { return this.#runtime.operations.run('backends.testBackend', () => this.#runtime.backends.testBackend(...args)); }
    listBackendContainers(...args) { return this.#runtime.operations.run('containers.listBackendContainers', () => this.#runtime.containers.listBackendContainers(...args)); }
    createBackendContainerDocument(...args) { return this.#runtime.operations.run('containers.createBackendContainerDocument', () => this.#runtime.containers.createBackendContainerDocument(...args)); }
    updateBackendDocument(...args) { return this.#runtime.operations.run('containers.updateBackendDocument', () => this.#runtime.containers.updateBackendDocument(...args)); }
    deleteBackendDocument(...args) { return this.#runtime.operations.run('containers.deleteBackendDocument', () => this.#runtime.containers.deleteBackendDocument(...args)); }
    syncBackendContainer(...args) { return this.#runtime.operations.run('containers.syncBackendContainer', () => this.#runtime.containers.syncBackendContainer(...args)); }
    addBackendContainers(...args) { return this.#runtime.operations.run('containers.addBackendContainers', () => this.#runtime.containers.addBackendContainers(...args)); }
    removeBackendContainer(...args) { return this.#runtime.operations.run('containers.removeBackendContainer', () => this.#runtime.containers.removeBackendContainer(...args)); }
    ensureMirrorFolderKey(...args) { return this.#runtime.operations.run('containers.ensureMirrorFolderKey', () => this.#runtime.containers.ensureMirrorFolderKey(...args)); }
    removeMirroredObject(...args) { return this.#runtime.operations.run('containers.removeMirroredObject', () => this.#runtime.containers.removeMirroredObject(...args)); }
    createBackendFolder(...args) { return this.#runtime.operations.run('containers.createBackendFolder', () => this.#runtime.containers.createBackendFolder(...args)); }
    deleteBackendFolder(...args) { return this.#runtime.operations.run('containers.deleteBackendFolder', () => this.#runtime.containers.deleteBackendFolder(...args)); }
    renameBackendFolder(...args) { return this.#runtime.operations.run('containers.renameBackendFolder', () => this.#runtime.containers.renameBackendFolder(...args)); }
    moveBackendFolder(...args) { return this.#runtime.operations.run('containers.moveBackendFolder', () => this.#runtime.containers.moveBackendFolder(...args)); }
    moveBackendsTreePath(...args) { return this.#runtime.operations.run('containers.moveBackendsTreePath', () => this.#runtime.containers.moveBackendsTreePath(...args)); }
    discoverBackendFolders(...args) { return this.#runtime.operations.run('containers.discoverBackendFolders', () => this.#runtime.containers.discoverBackendFolders(...args)); }
    describeDocumentLocations(...args) { return this.#runtime.operations.run('content.describeDocumentLocations', () => this.#runtime.content.describeDocumentLocations(...args)); }
    destroyDocument(...args) { return this.#runtime.operations.run('content.destroyDocument', () => this.#runtime.content.destroyDocument(...args)); }
    getDocumentThumbnail(...args) { return this.#runtime.operations.run('content.getDocumentThumbnail', () => this.#runtime.content.getDocumentThumbnail(...args)); }
    findIdentityByEmail(...args) { return this.#runtime.operations.run('contacts.findIdentityByEmail', () => this.#runtime.contacts.findIdentityByEmail(...args)); }
    drainContactExtraction(...args) { return this.#runtime.operations.run('contacts.drainContactExtraction', () => this.#runtime.contacts.drainContactExtraction(...args)); }
    refreshContactRelations(...args) { return this.#runtime.operations.run('contacts.refreshContactRelations', () => this.#runtime.contacts.refreshContactRelations(...args)); }
    extractEmailContacts(...args) { return this.#runtime.operations.run('contacts.extractEmailContacts', () => this.#runtime.contacts.extractEmailContacts(...args)); }
    extractMessageContacts(...args) { return this.#runtime.operations.run('contacts.extractMessageContacts', () => this.#runtime.contacts.extractMessageContacts(...args)); }
    listImapMailboxes(...args) { return this.#runtime.operations.run('integrations.listImapMailboxes', () => this.#runtime.integrations.listImapMailboxes(...args)); }
    getImapStatus(...args) { return this.#runtime.operations.run('integrations.getImapStatus', () => this.#runtime.integrations.getImapStatus(...args)); }
    saveImapMailbox(...args) { return this.#runtime.operations.run('integrations.saveImapMailbox', () => this.#runtime.integrations.saveImapMailbox(...args)); }
    removeImapMailbox(...args) { return this.#runtime.operations.run('integrations.removeImapMailbox', () => this.#runtime.integrations.removeImapMailbox(...args)); }
    testImapMailbox(...args) { return this.#runtime.operations.run('integrations.testImapMailbox', () => this.#runtime.integrations.testImapMailbox(...args)); }
    listImapMailboxFolders(...args) { return this.#runtime.operations.run('integrations.listImapMailboxFolders', () => this.#runtime.integrations.listImapMailboxFolders(...args)); }
    discoverImapFolders(...args) { return this.#runtime.operations.run('integrations.discoverImapFolders', () => this.#runtime.integrations.discoverImapFolders(...args)); }
    subscribeImapFolders(...args) { return this.#runtime.operations.run('integrations.subscribeImapFolders', () => this.#runtime.integrations.subscribeImapFolders(...args)); }
    ingestEmailMessage(...args) { return this.#runtime.operations.run('integrations.ingestEmailMessage', () => this.#runtime.integrations.ingestEmailMessage(...args)); }
    ingestEmailBatch(...args) { return this.#runtime.operations.run('integrations.ingestEmailBatch', () => this.#runtime.integrations.ingestEmailBatch(...args)); }
    enableImap(...args) { return this.#runtime.operations.run('integrations.enableImap', () => this.#runtime.integrations.enableImap(...args)); }
    disableImap(...args) { return this.#runtime.operations.run('integrations.disableImap', () => this.#runtime.integrations.disableImap(...args)); }
}

export default Workspace;
