import { SyncConflicts } from './SyncConflicts.js';

// Workspace delegates this domain to a collaborator. Runtime dependencies stay
// private to the local host; the public Workspace API is the transport boundary.
export default class WorkspaceReplicas {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }


    // ── Replicas (docs/durable-workspaces.md) ─────────────────────────────
    //
    // workspace.json `replicas: [{ device, role: full|cache, required }]` —
    // which device mirrors count toward "protected". The per-document evidence
    // (what each device reports it holds) lives in the stored index.

    get replicas() {
        const raw = this.#runtime.state.configStore.get('replicas', []);
        return (Array.isArray(raw) ? raw : [])
            .filter((r) => r && typeof r.device === 'string' && r.device.trim())
            .map((r) => ({ device: r.device.trim(), role: r.role === 'cache' ? 'cache' : 'full', required: r.required === true }));
    }

    get requiredReplicas() { return this.#workspace.replicas.filter((r) => r.required).map((r) => r.device); }

    setReplica(deviceId, patch = {}) {
        const device = String(deviceId || '').trim();
        if (!device) throw Object.assign(new Error('deviceId is required'), { statusCode: 400, code: 'INVALID_DEVICE' });
        const current = this.#workspace.replicas;
        const existing = current.find((r) => r.device === device) || { device, role: 'full', required: false };
        const next = {
            device,
            role: patch.role === 'cache' || patch.role === 'full' ? patch.role : existing.role,
            required: typeof patch.required === 'boolean' ? patch.required : existing.required,
        };
        if (next.role === 'cache') next.required = false;   // a cache never counts
        const list = [...current.filter((r) => r.device !== device), next];
        this.#runtime.state.configStore.set('replicas', list);
        this.#workspace.emit('replicas.changed', { id: this.#workspace.id, replicas: list });
        return next;
    }

    removeReplica(deviceId) {
        const device = String(deviceId || '').trim();
        const current = this.#workspace.replicas;
        const list = current.filter((r) => r.device !== device);
        if (list.length === current.length) return false;
        this.#runtime.state.configStore.set('replicas', list);
        this.#workspace.emit('replicas.changed', { id: this.#workspace.id, replicas: list });
        return true;
    }

    async recordReplicaApplied(deviceId, pairs, options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.recordReplicaApplied(deviceId, pairs, options);
    }

    async forgetReplica(deviceId) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.forgetReplica(deviceId);
    }

    async replicaProtection(address = 'workspace:home', options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.replicaProtection(address, { required: this.#workspace.requiredReplicas, ...options });
    }

    // ── Sync conflict inbox (see lib/SyncConflicts.js) ──────────────────────
    #syncConflicts = null;

    #getSyncConflicts() {
        if (!this.#syncConflicts) {
            this.#syncConflicts = new SyncConflicts({ workspace: this.#workspace, getDb: () => this.#runtime.getActiveDb(), logger: this.#runtime.state.logger });
        }
        return this.#syncConflicts;
    }

    async createSyncConflict(input = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#getSyncConflicts().create(input);
    }

    async listSyncConflicts() {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#getSyncConflicts().list();
    }

    async resolveSyncConflict(docId, options = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#getSyncConflicts().resolve(docId, options);
    }
}
