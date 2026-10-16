import path from 'path';
import { normalizeSegment } from '../../../utils/backend-documents.js';
import { isConnectorDriver, CONNECTOR_SCHEMES } from '../services/connectors/index.js';

export default class WorkspaceContainers {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }


    // Mailboxes belonging to one imap account (the account's folder set).
    async #imapAccountMailboxes(address) {
        return (await this.#workspace.listImapMailboxes())
            .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
    }

    async listBackendContainers(driver, address, { available = false } = {}) {
        if (isConnectorDriver(driver)) {
            // `available` and subscribed coincide for connectors in v1: the
            // driver lists what its config exposes (repos/channels/calendars).
            return (await this.#runtime.integrations.connectors()).listContainers(driver, address);
        }
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" has no containers`);
        if (available) {
            // Folders available on the server (for subscribing more), from the
            // account's primary mailbox creds.
            const [primary] = await this.#imapAccountMailboxes(address);
            if (!primary) throw new Error(`No IMAP mailbox for account "${address}"`);
            return this.#workspace.listImapMailboxFolders(primary.id);
        }
        return (await this.#workspace.getBackend('imap', address)).containers || [];
    }

    // Write-back into a connector container (v1: caldav events on a backend
    // configured readOnly:false). Remote-first, then mirrored locally.
    async createBackendContainerDocument(driver, address, container, payload = {}) {
        if (!isConnectorDriver(driver)) throw new Error(`Backend "${driver}/${address}" does not support document creation`);
        return (await this.#runtime.integrations.connectors()).createDocument(driver, address, container, payload);
    }

    // Resolve a synced document's provenance URL for its connector driver.
    async #connectorDocRef(driver, docId) {
        const doc = await this.#workspace.get(Number(docId));
        if (!doc) throw new Error(`Document ${docId} not found`);
        const scheme = CONNECTOR_SCHEMES[driver];
        const provenanceUrl = (doc.locations || [])
            .map((l) => l?.url)
            .find((url) => typeof url === 'string' && url.startsWith(`${scheme}://`));
        if (!provenanceUrl) throw new Error(`Document ${docId} has no ${driver} provenance location`);
        return { provenanceUrl };
    }

    // Write-back: update the remote object behind a synced connector document
    // (e.g. edit/close a GitHub issue). The driver's mirror re-ingests, so the
    // local doc reflects the remote's post-update state.
    async updateBackendDocument(driver, address, docId, patch = {}) {
        if (!isConnectorDriver(driver)) throw new Error(`Backend "${driver}/${address}" does not support document updates`);
        const ref = await this.#connectorDocRef(driver, docId);
        return (await this.#runtime.integrations.connectors()).updateDocument(driver, address, ref, patch);
    }

    // Write-back: delete the remote object (or its terminal equivalent —
    // GitHub closes as not_planned). When the remote is truly gone and no
    // mirror remains (caldav), the local document is dropped too.
    async deleteBackendDocument(driver, address, docId) {
        if (!isConnectorDriver(driver)) throw new Error(`Backend "${driver}/${address}" does not support document deletion`);
        const ref = await this.#connectorDocRef(driver, docId);
        const result = await (await this.#runtime.integrations.connectors()).deleteDocument(driver, address, ref);
        if (result.removedRemote && !result.hasMirror) {
            await this.#workspace.deleteMany([Number(docId)], { emitEvent: true }).catch((err) =>
                this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, docId, error: err.message }, 'Remote deleted but local mirror removal failed'));
        }
        return result;
    }

    async syncBackendContainer(driver, address, name) {
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" has no containers`);
        const container = (await this.#workspace.listBackendContainers('imap', address)).find((c) => c.name === name);
        if (!container) throw new Error(`Container "${name}" not found on imap/${address}`);
        return (await this.#runtime.integrations.mail()).syncMailbox(container.mailboxId, { full: true });
    }

    // Add containers: imap → subscribe folders (per-folder mailboxes); file →
    // create real directories under the backend root (each folder is a relative
    // path key like "docs" or "docs/2024").
    async addBackendContainers(driver, address, folders = []) {
        if (driver === 'imap') {
            const [primary] = await this.#imapAccountMailboxes(address);
            if (!primary) throw new Error(`No IMAP mailbox for account "${address}"`);
            return this.#workspace.subscribeImapFolders(primary.id, folders);
        }
        if (driver === 'file') {
            const created = [];
            for (const folder of folders) created.push(await this.#workspace.createBackendFolder(driver, address, folder));
            return created;
        }
        throw new Error(`Backend "${driver}/${address}" has no containers`);
    }

    async removeBackendContainer(driver, address, name) {
        if (driver === 'imap') {
            const target = (await this.#imapAccountMailboxes(address)).find((m) => (m.folder || 'INBOX') === name);
            if (!target) throw new Error(`Container "${name}" not found on imap/${address}`);
            return this.#workspace.removeImapMailbox(target.id);
        }
        if (driver === 'file' || driver === 'gdrive') return this.#workspace.deleteBackendFolder(driver, address, name);
        throw new Error(`Backend "${driver}/${address}" has no containers`);
    }

    // ── File-backend folder ops ───────────────────────────────────────────────
    // Fs op runs on the (writable) file driver; the directory-tree mirror is
    // updated here so empty folders are visible (docs alone would never surface
    // an empty dir — the watcher only sees file events). Folder "name" is a
    // relative path key under the backend root.
    #backendFolderKey(name) {
        const key = String(name || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
        if (!key || key.split('/').some((seg) => seg === '..' || seg === '.')) {
            throw new Error(`Invalid folder name: ${name}`);
        }
        return key;
    }

    async #directoryTreeForBackends() {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#workspace.getBackendsTree();
    }

    // Drivers with real, mutable directories (stored CONTAINER_DRIVERS).
    static #FOLDER_DRIVERS = new Set(['file']);

    #assertFolderDriver(driver) {
        if (!WorkspaceContainers.#FOLDER_DRIVERS.has(driver)) throw new Error(`Driver "${driver}" has no mutable folders`);
    }

    /**
     * Storage-policy helpers: a mirrored folder on a backend by its key
     * (idempotent — the driver's createContainer is an ensureDir), and the
     * removal of one mirrored copy through the backend's recoverable Trash.
     */
    async ensureMirrorFolderKey(backendName, key) {
        const driver = this.#workspace.dataBackends[backendName]?.driver || 'file';
        return this.#workspace.createBackendFolder(driver, backendName, key);
    }

    async removeMirroredObject(backendName, key, options = {}) {
        const driver = this.#workspace.dataBackends[backendName]?.driver || 'file';
        return this.#workspace.removeBackendObject(driver, backendName, key, options);
    }

    async createBackendFolder(driver, address, name) {
        this.#assertFolderDriver(driver);
        const key = this.#backendFolderKey(name);
        const tree = await this.#directoryTreeForBackends();
        await this.#runtime.state.storedIndex.createBackendContainer(address, key);
        const root = this.#runtime.state.storedIndex.getBackendTreeRoot(address);
        if (root) await tree.insertPath(`${root}/${key}`, { ignoreLocks: true });
        return { driver, address, folder: key };
    }

    async deleteBackendFolder(driver, address, name) {
        if (driver !== 'gdrive') this.#assertFolderDriver(driver);
        const key = this.#backendFolderKey(name);
        const tree = await this.#directoryTreeForBackends();
        // Stored moves the complete directory into recoverable backend Trash
        // and drops indexed locations, including when the watcher is disabled.
        await this.#runtime.state.storedIndex.deleteBackendContainer(address, key);
        const root = this.#runtime.state.storedIndex.getBackendTreeRoot(address);
        if (root) await tree.removePath(`${root}/${key}`, true).catch(() => {});
        return { driver, address, folder: key, removed: true };
    }

    async renameBackendFolder(driver, address, fromName, toName) {
        this.#assertFolderDriver(driver);
        const fromKey = this.#backendFolderKey(fromName);
        const wanted = this.#backendFolderKey(toName);
        // UI rename sends a leaf name. An explicit path is backend-relative;
        // callers moving to the root can use moveBackendFolder directly.
        const toKey = String(toName).includes('/') ? wanted : path.posix.join(path.posix.dirname(fromKey), wanted);
        return this.#workspace.moveBackendFolder(driver, address, fromKey, toKey);
    }

    async moveBackendFolder(driver, address, fromName, toName) {
        this.#assertFolderDriver(driver);
        const fromKey = this.#backendFolderKey(fromName);
        const toKey = this.#backendFolderKey(toName);
        await this.#directoryTreeForBackends();
        await this.#runtime.state.storedIndex.renameBackendContainer(address, fromKey, toKey);
        return { driver, address, from: fromKey, to: toKey };
    }

    // The backends tree is a projection of storage. Its drag/drop operation
    // must move bytes through Stored, never mutate directory metadata alone.
    async moveBackendsTreePath(fromPath, toPath) {
        await this.#directoryTreeForBackends();
        const locate = (value) => {
            const normalized = `/${String(value).split('/').filter(Boolean).join('/')}`;
            const roots = Object.entries(this.#workspace.dataBackends).map(([address, config]) => ({
                address, driver: config.driver, root: this.#runtime.state.storedIndex.getBackendTreeRoot(address),
            })).filter(b => b.root).sort((a, b) => b.root.length - a.root.length);
            const backend = roots.find(b => normalized === b.root || normalized.startsWith(`${b.root}/`));
            return backend ? { ...backend, key: normalized.slice(backend.root.length + 1) } : null;
        };
        const from = locate(fromPath);
        const to = locate(toPath);
        if (!from?.key || !to?.key || from.driver !== 'file' || to.driver !== 'file' || from.address !== to.address) {
            throw Object.assign(new Error('Folder moves require two paths within the same writable file backend; backend roots cannot be moved'), { statusCode: 400 });
        }
        const moved = await this.#workspace.moveBackendFolder('file', from.address, from.key, to.key);
        return { data: { ...moved, pathFrom: fromPath, pathTo: toPath }, count: 1, error: null };
    }

    // Pre-create folder discovery — probe a connector with candidate creds
    // before any instance exists (the "add account" flow).
    async discoverBackendFolders(driver, config = {}) {
        if (driver !== 'imap') throw new Error(`Driver "${driver}" does not support folder discovery`);
        return this.#workspace.discoverImapFolders(config);
    }
}
