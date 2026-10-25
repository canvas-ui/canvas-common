import { randomUUID } from 'node:crypto';
import DatabaseBackups, { BACKUP_RETENTION } from 'canvas-synapsd/src/backups/DatabaseBackups.js';

const busy = message => Object.assign(new Error(message), { statusCode: 409 });

export default class WorkspaceBackups {
    #workspace;
    #runtime;
    #timer;
    #pending;
    #jobs = [];
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }
    get busy() { return Boolean(this.#pending); }
    get restoring() { return this.#jobs.some(job => job.action === 'restore' && job.status === 'running'); }
    #manager() { return new DatabaseBackups(this.#workspace.dbPath); }
    async status() {
        return { retention: BACKUP_RETENTION, backups: await this.#manager().list(), jobs: this.#jobs,
            isActive: this.#workspace.isActive };
    }
    async startup() {
        if (this.#pending) { await this.#pending; }
        return this.#manager().create('startup');
    }
    schedule() {
        clearInterval(this.#timer);
        this.#timer = setInterval(() => {
            if (!this.#pending && this.#workspace.isActive) { this.start({ action: 'backup', kind: 'hourly' }); }
        }, 60 * 60 * 1000);
        this.#timer.unref?.();
    }
    async pause() {
        clearInterval(this.#timer);
        if (!this.restoring) { await this.#pending; }
    }
    start({ action = 'backup', kind = 'manual', backupId, confirm } = {}) {
        if (this.#pending || this.#runtime.state.startPromise || this.#runtime.state.protectionPromise) {
            throw busy('Workspace maintenance or startup is already running');
        }
        if (action !== 'backup' && action !== 'restore') { throw Object.assign(new Error('Invalid backup action'), { statusCode: 400 }); }
        if (action === 'restore' && (confirm !== true || !backupId)) {
            throw Object.assign(new Error('Choose a backup and confirm restoration'), { statusCode: 400 });
        }
        const job = { id: randomUUID(), action, kind, backupId, status: 'running',
            createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
        this.#jobs = [job, ...this.#jobs].slice(0, 30);
        this.#pending = Promise.resolve().then(async () => {
            if (action === 'restore') {
                if (!await this.#workspace.stop('database-restore')) { throw new Error('Workspace could not be stopped; nothing was restored'); }
                await this.#runtime.operations.drain();
                job.result = await this.#manager().restore(backupId);
            } else {
                job.result = this.#workspace.isActive
                    ? await this.#runtime.state.db.createBackup(kind)
                    : await this.#manager().create(kind);
            }
            job.status = 'completed';
        }).catch(error => {
            job.status = 'failed'; job.error = error.message;
            this.#runtime.state.logger.error({ err: error, workspaceId: this.#workspace.id, action }, 'Workspace backup operation failed');
        }).finally(() => { job.finishedAt = new Date().toISOString(); this.#pending = null; });
        return job;
    }
}
