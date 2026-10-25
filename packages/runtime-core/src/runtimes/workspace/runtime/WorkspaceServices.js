import { WorkspaceStoredIndex } from '../storage/WorkspaceStoredIndex.js';
import { WorkspaceMailIndex } from '../connectors/imap/index.js';
import { WorkspaceConnectorIndex } from '../connectors/index.js';
import StoragePolicyService from '../storage/policies/service.js';
import { getServerDevice } from '../../../utils/host-device.js';
import Workspace from '../Workspace.js';

export default class WorkspaceServices {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    #buildStoredIndex() {
        return new WorkspaceStoredIndex({
            rootPath: this.#runtime.state.rootPath,
            cachePath: this.#workspace.cachePath,
            dataPath: this.#workspace.dataPath,
            homePath: this.#workspace.homePath,
            storedRootPath: this.#workspace.storedRootPath,
            dataBackends: this.#runtime.config.runtimeBackends(),
            // Never index ourselves: any of the workspace's own runtime dirs
            // that happens to live inside an indexed backend root is excluded
            // structurally. Load-bearing for the `home` layout (home backend
            // root == workspace root), harmless for `full`.
            internalPaths: this.#workspace.internalPaths,
            workspaceId: this.#workspace.id,
            // This server's device identity — authority for the device-scoped
            // file:// locations of external fs mounts.
            device: getServerDevice(),
            logger: this.#runtime.state.logger,
            put: (record, options = {}) => this.#workspace.put(record, { ...options, allowBackendsWrite: true }),
            unlink: (id, options = {}, unlinkOptions = {}) => this.#workspace.unlink(id, options, { ...unlinkOptions, allowBackendsWrite: true }),
            getBackendsTreeSelector: this.#workspace.getBackendsTreeSelector.bind(this.#workspace),
            getDb: () => this.#runtime.state.db,
            policyDirectoryMove: (phase, input) => this.#runtime.state.storagePolicyService?.directoryMove(phase, input),
            policyRemove: input => this.#runtime.state.storagePolicyService?.removeFromBackend(input),
            // imap:// byte-ops are delegated to the mail service.
            describeImapLocation: (url) => this.#runtime.state.mailIndex?.describeImapLocation(url) ?? null,
            destroyImapLocation: (url) => this.#runtime.state.mailIndex?.destroyImapLocation(url) ?? null,
            lockBackendNode: (path, holder) => this.#workspace.lockBackendTreeNode(path, holder),
            unlockBackendNode: (path, holder) => this.#workspace.unlockBackendTreeNode(path, holder),
            // Skeleton mirroring: bare directory nodes under the backend's
            // mirror root (documents insert their own paths as they stream in).
            insertBackendPath: (treePath) => this.#workspace.getBackendsTree().insertPath(treePath, { ignoreLocks: true }),
            moveBackendPath: async (from, to, { validateOnly = false } = {}) => {
                const tree = this.#workspace.getBackendsTree();
                if (!tree.supportsStorageMoves) throw Object.assign(new Error('Folder moves require canvas-synapsd 3.23.5 or newer'), { statusCode: 503 });
                if (validateOnly) return;
                if (tree.pathExists(from)) await tree.movePath(from, to, true, { ignoreLocks: true });
                else if (!tree.pathExists(to)) await tree.insertPath(to, { ignoreLocks: true });
            },
            pruneBackendPath: (treePath) => this.#workspace.pruneEmptyBackendPaths(treePath),
            sweepBackendPaths: (rootPath, keepDirs) => this.#workspace.sweepEmptyBackendPaths(rootPath, keepDirs),
            // Resync lifecycle/progress → ws clients (tree spinner, settings).
            onResyncStateChange: (state) => this.#workspace.emit('backend.resync.changed', { ...state, workspaceId: this.#workspace.id }),
            // Change-log advance (throttled per backend) → the nudge device
            // mirrors subscribe to; `seq` is the log head to poll from.
            onBackendChanged: ({ backend, seq }) => this.#workspace.emit('backend.changed', { workspaceId: this.#workspace.id, workspaceName: this.#workspace.name, backend, seq }),
            // Quiet config persist (mount fsid snapshot on first successful
            // liveness check) — must NOT re-enter applyBackendConfig.
            persistBackendConfig: (name, patch) => {
                const dataBackends = this.#workspace.dataBackends;
                dataBackends[name] = { ...dataBackends[name], ...patch };
                this.#runtime.config.writeStoredBackends(dataBackends);
            },
            onLocationsRemoved: input => this.#workspace.observeSourceRemoval(input),
            onRemovalReady: ids => this.#workspace.trashOperations.ready(ids),
            replicaOwnerGuard: owner => !owner.startsWith('workspace-document:') || !this.#workspace.isRemovalHeld(Number(owner.slice('workspace-document:'.length))),
            // Orphan-GC retention (Settings > Database), -1 = keep forever.
            getOrphanRetentionDays: () => Number(this.#workspace.databaseSettings.orphanRetentionDays ?? -1),
            getOrphanPolicy: () => this.#workspace.databaseSettings.orphanPolicy,
        });
    }

    async startStoredIndex() {
        this.#workspace.assertActive();
        if (this.#runtime.state.servicesStartPromise) return this.#runtime.state.servicesStartPromise;
        if (this.#runtime.state.storedIndex?.isRunning) return;
        this.#runtime.state.servicesStartPromise = this.#startServices().finally(() => {
            this.#runtime.state.servicesStartPromise = null;
        });
        return this.#runtime.state.servicesStartPromise;
    }

    async #startServices() {
        this.#runtime.state.storedIndex = this.#buildStoredIndex();
        await this.#runtime.operations.run('start.stored', () => this.#runtime.state.storedIndex.start());
        if (this.#runtime.state.storedIndex.stored?.replicas) {
            this.#runtime.state.storagePolicyService = new StoragePolicyService({ workspace: this.#workspace,
                stored: this.#runtime.state.storedIndex.stored, state: this.#runtime.state.db.internalStore, logger: this.#runtime.state.logger });
            this.#runtime.state.storagePolicyService.start();
        }
        await this.#runtime.operations.run('start.mail', () => this.#startMailIndex());
        await this.#runtime.operations.run('start.connectors', () => this.#startConnectorIndex());
        this.#workspace.trashOperations.schedule();
    }

    async stopStoredIndex() {
        await this.#runtime.state.servicesStartPromise?.catch(() => {});
        await this.#runtime.state.trashOperations?.stop();
        await this.#runtime.state.storagePolicyService?.stop();
        this.#runtime.state.storagePolicyService = null;
        await this.#stopConnectorIndex();
        await this.#stopMailIndex();
        if (!this.#runtime.state.storedIndex) return;
        await this.#runtime.state.storedIndex.stop();
        this.#runtime.state.storedIndex = null;
        this.#runtime.state.trashOperations = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMAP mailboxes — delegated to the per-workspace mail service
    // (WorkspaceMailIndex). Config in config/stored.json; the mail service
    // shares the blob indexer's Stored instance to run imap backends.
    // ─────────────────────────────────────────────────────────────────────────

    #buildMailIndex() {
        return new WorkspaceMailIndex({
            resolveCredentials: (config) => this.#runtime.config.resolveCredentials(config),
            secretsLocked: () => this.#runtime.state.withoutSecrets,
            protectConfig: (config) => this.#runtime.state.crypto.protect(config, 'config/stored'),
            rootPath: this.#runtime.state.rootPath,
            configDir: this.#workspace.configDir,
            varPath: this.#workspace.varPath,
            homePath: this.#workspace.homePath,
            workspaceId: this.#workspace.id,
            logger: this.#runtime.state.logger,
            put: (record, options = {}) => this.#workspace.put(record, { ...options, allowBackendsWrite: true }),
            putMany: (records, options = {}) => this.#workspace.putMany(records, { ...options, allowBackendsWrite: true }),
            // Attachment File docs: link an already-indexed blob into a mailbox
            // folder, and draw the `includes` edge from its Email.
            link: (id, options = {}) => this.#workspace.link(id, { ...options, allowBackendsWrite: true }),
            linkMany: (ids, options = {}) => this.#workspace.linkMany(ids, { ...options, allowBackendsWrite: true }),
            assertRelation: (fromId, predicate, toId) => this.#workspace.assertRelation(fromId, predicate, toId),
            getBackendsTreeSelector: this.#workspace.getBackendsTreeSelector.bind(this.#workspace),
            insertBackendPath: (treePath) => this.#workspace.getBackendsTree().insertPath(treePath, { ignoreLocks: true }),
            getDb: () => this.#runtime.state.db,
            // Persist email/attachment blobs into the local content-addressable
            // data store (workspace:data) via the blob indexer.
            persistBlob: (buffer) => this.#runtime.state.storedIndex.persistBlob(buffer),
            lockBackendNode: (path, holder) => this.#workspace.lockBackendTreeNode(path, holder),
            unlockBackendNode: (path, holder) => this.#workspace.unlockBackendTreeNode(path, holder),
            // Threading: a reply lands where its parent is filed.
            inheritThreadMemberships: (replyId, parentId) => this.#workspace.inheritThreadMemberships(replyId, parentId),
            reconcileRemovedLocations: (doc, urls, options) => this.#runtime.state.storedIndex.reconcileRemovedLocations(doc, urls, options),
        });
    }

    // Started alongside the blob indexer (and stopped before it). The mail
    // service is otherwise self-owned — it manages its own ImapBackend instances.
    async #startMailIndex() {
        if (this.#runtime.state.mailIndex?.isRunning) return;
        this.#runtime.state.mailIndex = this.#buildMailIndex();
        // Forward the mail service's object:* / source:state / error events with
        // workspaceId + source stamped (same envelope as the db runtime events).
        this.#runtime.state.mailRuntimeBinding = this.#runtime.createRuntimeListener(this.#runtime.state.mailIndex, 'imap');
        await this.#runtime.state.mailIndex.start();
    }

    async #stopMailIndex() {
        if (this.#runtime.state.mailRuntimeBinding) {
            this.#runtime.state.mailRuntimeBinding.emitter.off('**', this.#runtime.state.mailRuntimeBinding.listener);
            this.#runtime.state.mailRuntimeBinding = null;
        }
        if (!this.#runtime.state.mailIndex) return;
        await this.#runtime.state.mailIndex.stop();
        this.#runtime.state.mailIndex = null;
    }

    async mail() {
        if (!this.#runtime.state.mailIndex?.isRunning) await this.startStoredIndex();
        return this.#runtime.state.mailIndex;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connectors (github / slack / gcal / teams) — delegated to the
    // per-workspace connector service (WorkspaceConnectorIndex). Config in
    // config/stored.json alongside the storage + imap backends; synced docs
    // land only in the backends tree. See docs/connectors.md.
    // ─────────────────────────────────────────────────────────────────────────

    #buildConnectorIndex() {
        return new WorkspaceConnectorIndex({
            onContacts: async (account, contacts) => {
                this.#runtime.contacts.startContactExtraction();
                await this.#runtime.contacts.contacts.syncWhatsAppContacts(account, contacts);
            },
            sessionSecrets: {
                seal: (json, accountHash) => this.#runtime.state.crypto.protect({ password: json }, `whatsapp/${accountHash}`).password,
                open: (ref) => this.#runtime.state.crypto.resolve(ref),
            },
            resolveCredentials: (config) => this.#runtime.config.resolveCredentials(config),
            secretsLocked: () => this.#runtime.state.withoutSecrets,
            protectConfig: (config) => this.#runtime.state.crypto.protect(config, 'config/stored'),
            rootPath: this.#runtime.state.rootPath,
            configDir: this.#workspace.configDir,
            varPath: this.#workspace.varPath,
            homePath: this.#workspace.homePath,
            gitPath: this.#workspace.gitPath,
            removeBackendPath: async (treePath) => {
                const tree = this.#workspace.getBackendsTree();
                const docs = await tree.findRecursive(treePath);
                if (!docs || docs.isEmpty) await tree.removePath(treePath, true, { ignoreLocks: true });
            },
            linkDocument: async (id, placement) => {
                const tree = this.#workspace.getTree(placement.tree);
                if (!tree || tree.name === Workspace.BACKENDS_TREE_NAME) throw new Error('Git mapping destination must be a virtual tree');
                const paths = await this.#workspace.listDocumentTreeMemberships(id, placement.tree);
                if (!paths.includes(placement.path)) return this.#workspace.link(id, tree.type === Workspace.DIRECTORY_TYPE
                    ? { context: null, directory: placement }
                    : { context: placement, directory: null });
            },
            ensureBackendMembership: async (id, treePath) => {
                const paths = await this.#workspace.listDocumentTreeMemberships(id, Workspace.BACKENDS_TREE_NAME);
                if (!paths.includes(treePath)) await this.#workspace.link(id, {
                    context: null, directory: this.#workspace.getBackendsTreeSelector(treePath), allowBackendsWrite: true,
                });
            },
            workspaceId: this.#workspace.id,
            logger: this.#runtime.state.logger,
            put: (record, options = {}) => this.#workspace.put(record, { ...options, allowBackendsWrite: true }),
            getBackendsTreeSelector: this.#workspace.getBackendsTreeSelector.bind(this.#workspace),
            insertBackendPath: async (treePath, { label } = {}) => {
                const tree = this.#workspace.getBackendsTree();
                const result = await tree.insertPath(treePath, { ignoreLocks: true });
                const layer = tree.getLayerForPath(treePath);
                if (label && layer && layer.label !== label) await tree.updateLayer(layer.id, { label });
                return result;
            },
            pruneBackendPath: (treePath) => this.#workspace.pruneEmptyBackendPaths(treePath),
            sweepBackendPaths: (rootPath, keepDirs) => this.#workspace.sweepEmptyBackendPaths(rootPath, keepDirs),
            lockBackendNode: (path, holder) => this.#workspace.lockBackendTreeNode(path, holder),
            unlockBackendNode: (path, holder) => this.#workspace.unlockBackendTreeNode(path, holder),
            // Deletion-sync (pruneRemoved): enumerate a connector's mirror docs
            // and drop locations of source-deleted items with the stored
            // index's orphan-not-delete semantics.
            listDocumentIdsUnderBackendPath: (treePath) => this.#workspace.documentIdsUnderScope(`${Workspace.BACKENDS_TREE_NAME}://${treePath}`),
            getDocumentsByIdArray: (ids) => this.#workspace.getDocumentsByIdArray(ids),
            reconcileRemovedLocations: async (doc, urls) => {
                if (doc.metadata?.source === 'git' && await this.#runtime.contacts.isUserFiled(doc.id)) {
                    const paths = await this.#workspace.listDocumentTreeMemberships(doc.id, Workspace.BACKENDS_TREE_NAME);
                    await this.#runtime.getActiveDb().put({ id: doc.id, locations: doc.locations.filter(l => !urls.includes(l.url)), orphanedAt: new Date().toISOString() }, { context: null });
                    if (paths.length) await this.#runtime.getActiveDb().unlink(doc.id, { context: null, directory: { tree: Workspace.BACKENDS_TREE_NAME, path: paths } });
                    return doc.id;
                }
                if (!this.#runtime.state.storedIndex?.isRunning) await this.startStoredIndex();
                return this.#runtime.state.storedIndex.reconcileRemovedLocations(doc, urls);
            },
            // Threading: parent lookup by identity checksum + reply-follows-root.
            resolveDocumentIdByChecksum: async (checksum) => {
                const doc = await this.#runtime.getActiveDb().getByChecksumString(checksum, { parse: false });
                return doc?.id ?? null;
            },
            inheritThreadMemberships: (replyId, rootId) => this.#workspace.inheritThreadMemberships(replyId, rootId),
        });
    }

    async #startConnectorIndex() {
        if (this.#runtime.state.connectorIndex?.isRunning) return;
        this.#runtime.state.connectorIndex = this.#buildConnectorIndex();
        this.#runtime.state.connectorRuntimeBinding = this.#runtime.createRuntimeListener(this.#runtime.state.connectorIndex, 'connectors');
        await this.#runtime.state.connectorIndex.start();
    }

    async #stopConnectorIndex() {
        if (this.#runtime.state.connectorRuntimeBinding) {
            this.#runtime.state.connectorRuntimeBinding.emitter.off('**', this.#runtime.state.connectorRuntimeBinding.listener);
            this.#runtime.state.connectorRuntimeBinding = null;
        }
        if (!this.#runtime.state.connectorIndex) return;
        await this.#runtime.state.connectorIndex.stop();
        this.#runtime.state.connectorIndex = null;
    }

    async connectors() {
        if (!this.#runtime.state.connectorIndex?.isRunning) await this.startStoredIndex();
        return this.#runtime.state.connectorIndex;
    }

    // Read-only view that does NOT boot sources (safe for status polls).
    connectorsReadonly() {
        return this.#runtime.state.connectorIndex?.isRunning ? this.#runtime.state.connectorIndex : this.#buildConnectorIndex();
    }

    mailReadonly() {
        return this.#runtime.state.mailIndex?.isRunning ? this.#runtime.state.mailIndex : this.#buildMailIndex();
    }

    // IMAP wrappers backing the unified backend facade (listBackends / addBackend
    // / syncBackend / containers). getImapStatus feeds the services status view.
    async listImapMailboxes() { return this.mailReadonly().listMailboxes(); }
    async getImapStatus() { return this.mailReadonly().getImapStatus(); }
    async saveImapMailbox(input) { return (await this.mail()).saveMailbox(input); }
    async removeImapMailbox(id) { return (await this.mail()).removeMailbox(id); }
    // Connection probes must not start polling every configured account.
    async testImapMailbox(id) { return this.mailReadonly().testMailbox(id); }
    async listImapMailboxFolders(id) { return this.mailReadonly().listMailboxFolders(id); }
    async discoverImapFolders(input) { return this.mailReadonly().discoverFolders(input); }
    async subscribeImapFolders(id, folders) { return (await this.mail()).subscribeFolders(id, folders); }
    async moveImapMessages(documentIds, targetPath) { return (await this.mail()).moveMessages(documentIds, targetPath); }
    async moveImapMessagesToFolder(documentIds, folder) { return (await this.mail()).moveMessagesToFolder(documentIds, folder); }

    // Ingest one raw RFC822 message as an Email document (+ its attachments as
    // File docs with `includes` edges). The mail service's own backends push
    // whole fetch batches internally; this is the entry point for everything
    // else that holds a raw message — a future SMTP send filing its own copy
    // into Sent, an import, a test.
    async ingestEmailMessage(payload) { return (await this.mail()).ingestMessage(payload); }
    async ingestEmailBatch(payloads) { return (await this.mail()).ingestBatch(payloads); }

    // Service-level enable/disable for 'imap'.
    async enableImap() { await this.startStoredIndex(); return this.#workspace.getImapStatus(); }
    async disableImap() { if (this.#runtime.state.mailIndex?.isRunning) await this.#runtime.state.mailIndex.disableImap(); return true; }
}
