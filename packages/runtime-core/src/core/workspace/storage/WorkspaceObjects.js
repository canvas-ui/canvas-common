import { isConnectorDriver } from '../services/connectors/index.js';
import Workspace from '../Workspace.js';

export default class WorkspaceObjects {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    /**
     * Copy or move an object from one storage backend to another.
     *
     * Content identity is preserved either way — the document keeps its id,
     * checksums and every curated placement; only `locations[]` changes. A move
     * releases the source solely after the destination write is durable, so a
     * failed transfer degrades to a copy and never to data loss.
     *
     * @param {string} driver Source driver ('file', 'cacache', …)
     * @param {string} address Source backend address
     * @param {object} options
     * @param {string} options.key Object key on the source backend
     * @param {string} options.to Target backend address
     * @param {string} [options.targetKey] Key on the target (defaults to `key`)
     * @param {'copy'|'move'} [options.mode='copy']
     */
    async transferBackendObject(driver, address, { key, to, targetKey, mode = 'copy' } = {}) {
        if (isConnectorDriver(driver) || driver === 'imap') {
            throw new Error(`Backend "${driver}/${address}" does not store transferable objects`);
        }
        if (!key) throw new Error('Object key is required');
        if (!to) throw new Error('A target backend is required');
        if (mode !== 'copy' && mode !== 'move') throw new Error(`Unknown transfer mode: ${mode}`);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();

        const url = `stored://${address}/${key}`;
        const result = mode === 'move'
            ? await this.#runtime.state.storedIndex.moveObject(url, { to, key: targetKey })
            : await this.#runtime.state.storedIndex.copyObject(url, { to, key: targetKey });
        // stored reports refusals as { ok:false, reason } — surface them as
        // errors so the HTTP layer does not answer 200 for a transfer that
        // never happened.
        if (!result?.ok) {
            const detail = result?.detail ? ` (${result.detail})` : '';
            throw new Error(`${mode} failed: ${result?.reason || 'unknown error'}${detail}`);
        }
        return result;
    }

    // ── Keyed objects — the hub side of a device mirror ─────────────────────
    // (backend, key) addressing with HTTP-style preconditions over a
    // path-addressed local backend; see WorkspaceStoredIndex.writeObject.

    #assertObjectsDriver(driver, address) {
        if (isConnectorDriver(driver) || driver === 'imap') {
            throw Object.assign(new Error(`Backend "${driver}/${address}" does not expose keyed objects`), { code: 'UNSUPPORTED_BACKEND', statusCode: 400 });
        }
    }

    async writeBackendObject(driver, address, key, source, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.writeObject(address, key, source, options);
    }

    async removeBackendObject(driver, address, key, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.removeObject(address, key, options);
    }

    async renameBackendObject(driver, address, from, to, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.renameObject(address, from, to, options);
    }

    async listBackendRetained(driver, address, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return { retention: this.#runtime.state.storedIndex.retention, retained: this.#runtime.state.storedIndex.listRetained(address, options) };
    }

    async listBackendTrash(driver, address, options = {}) {
        if (driver !== 'file') throw Object.assign(new Error('Backend Trash is supported by file backends'), { statusCode: 400 });
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.listTrash(address, options);
    }

    async restoreBackendTrash(driver, address, ids, options = {}) {
        if (driver !== 'file') throw Object.assign(new Error('Backend Trash is supported by file backends'), { statusCode: 400 });
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        const result = await this.#runtime.state.storedIndex.restoreTrash(address, ids, options);
        this.#workspace.emit('backend.tree.changed', { workspaceId: this.#workspace.id, treeName: Workspace.BACKENDS_TREE_NAME, backend: address });
        return result;
    }

    async discardBackendTrash(driver, address, ids) {
        if (driver !== 'file') throw Object.assign(new Error('Backend Trash is supported by file backends'), { statusCode: 400 });
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        const result = await this.#runtime.state.storedIndex.discardTrash(address, ids);
        this.#workspace.emit('backend.tree.changed', { workspaceId: this.#workspace.id, treeName: Workspace.BACKENDS_TREE_NAME, backend: address });
        return result;
    }

    getBackendTrashTree() {
        const node = (name, label, metadata, children = []) => ({
            id: `backend-trash:${name}`, name, label, type: 'directory', description: 'Deleted backend files and folders',
            color: null, locked: true, metadata: { backendTrash: true, ...metadata }, children,
        });
        return node('Trash', 'Trash', {}, this.#runtime.backends.listStorageBackends()
            .filter(b => b.driver === 'file' && b.enabled !== false)
            .map(b => node(encodeURIComponent(b.address), b.label || b.address, { driver: b.driver, address: b.address })));
    }

    async restoreBackendRetained(driver, address, sha256, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.restoreRetained(address, sha256, options);
    }

    async statBackendObject(driver, address, key) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.statObject(address, key);
    }

    async listBackendObjects(driver, address, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.listObjects(address, options);
    }

    async backendChanges(driver, address, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.changes(address, options);
    }

    async resolveBackendObject(driver, address, key, options = {}) {
        this.#assertObjectsDriver(driver, address);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.resolveObject(address, key, options);
    }

    /** Bytes behind any of this workspace's location URLs (`{ data, ranged }`). */
    async resolveStoredUrl(url, options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.resolve(url, options);
    }
}
