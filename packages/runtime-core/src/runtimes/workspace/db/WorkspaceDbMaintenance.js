import { randomUUID } from 'node:crypto';

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export const DB_MAINTENANCE_ACTIONS = Object.freeze({
    'reindex:timelines': { label: 'Rebuild timelines', run: (db, _options, onProgress) => db.reindexCrudTimelines({ onProgress }) },
    'reindex:mime': { label: 'Rebuild file types', run: (db, _options, onProgress) => db.reindexMimeBitmaps({ onProgress }) },
    'reindex:search': { label: 'Rebuild word search', run: (db, { rebuild = false }, onProgress) => db.reindexSearchIndex({ rebuild: rebuild === true, onProgress }) },
    optimize: {
        label: 'Optimize indexes',
        async run(db, { space = null }) {
            const result = {};
            if (!space || space === 'fts') result.fts = await db.optimizeLance();
            if (!space) result.vectors = await db.optimizeVectors();
            else if (space !== 'fts') result.vectors = await db.optimizeVectors(space);
            return result;
        },
    },
});

/**
 * Index maintenance on the workspace's own database, run as jobs with a
 * receipt: a rebuild over a large workspace outlasts any HTTP timeout, so the
 * request returns at once and clients poll `status()` for the result. One job
 * at a time; each operation is idempotent and safe on the live workspace.
 */
export default class WorkspaceDbMaintenance {
    #getDb;
    #run;
    #jobs = [];

    constructor(getDb, run = action => action()) {
        this.#getDb = getDb;
        this.#run = run;
    }

    status() {
        return { jobs: this.#jobs.map(job => ({ ...job })) };
    }

    get(id) {
        const job = this.#jobs.find(item => item.id === id);
        return job ? { ...job } : null;
    }

    start({ action, options = {} }) {
        const operation = DB_MAINTENANCE_ACTIONS[action];
        if (!operation) throw fail('Unknown index maintenance action', 400);
        const db = this.#getDb();
        if (!db) throw fail('Workspace database is not running', 503);
        if (this.#jobs.some(job => ['queued', 'running'].includes(job.status))) throw fail('Index maintenance is already running', 409);
        const job = { id: randomUUID(), action, options, status: 'queued',
            createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, progress: null, result: null, error: null };
        this.#jobs = [job, ...this.#jobs].slice(0, 16);
        const onProgress = (progress) => { job.progress = { ...progress }; };
        // A fresh microtask turns synchronous and asynchronous errors alike into
        // a failed receipt, and the POST always returns promptly.
        void Promise.resolve().then(() => this.#run(() => {
            job.status = 'running';
            job.startedAt = new Date().toISOString();
            return operation.run(db, options, onProgress);
        })).then(result => {
            job.result = result;
            job.status = 'completed';
        }, error => {
            job.error = error.message || String(error);
            job.status = 'failed';
        }).finally(() => { job.finishedAt = new Date().toISOString(); });
        return { ...job };
    }
}
