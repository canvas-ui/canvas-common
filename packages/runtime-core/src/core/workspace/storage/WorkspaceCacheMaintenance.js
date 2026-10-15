import { randomUUID } from 'node:crypto';

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// Runtime job receipts keep long maintenance requests out of HTTP timeouts.
// The Stored mutation queue also makes workspace shutdown wait for maintenance.
export default class WorkspaceCacheMaintenance {
    #getStored;
    #run;
    #jobs = [];

    constructor(getStored, run = action => action()) {
        this.#getStored = getStored;
        this.#run = run;
    }

    #stores(stored) {
        return [
            { id: 'workspace:cache', label: 'Workspace cache', store: stored?.cache },
            { id: 'workspace:data', label: 'Workspace data', store: stored?.getBackend('workspace:data') },
        ];
    }

    status() {
        const stored = this.#getStored();
        return {
            stores: this.#stores(stored).map(({ id, label, store }) => ({ id, label,
                canCollect: typeof store?.collectGarbage === 'function',
                canVerify: typeof store?.verify === 'function',
                canCompact: typeof store?.compact === 'function',
            })),
            jobs: this.#jobs.map(job => ({ ...job })),
        };
    }

    start({ store: storeId, action, confirm = false }) {
        if (!['collect', 'verify', 'compact'].includes(action)) throw fail('Unknown cache maintenance action', 400);
        if (action === 'verify' && confirm !== true) throw fail('Confirm verification may remove corrupted content', 400);
        const stored = this.#getStored();
        if (!stored) throw fail('Workspace storage is not running', 503);
        const target = this.#stores(stored).find(item => item.id === storeId);
        if (!target) throw fail('Unknown cache store', 400);
        const method = action === 'collect' ? 'collectGarbage' : action;
        if (typeof target.store?.[method] !== 'function') throw fail('Update canvas-stored to enable this maintenance operation', 503);
        if (this.#jobs.some(job => ['queued', 'running'].includes(job.status))) throw fail('Cache maintenance is already running', 409);
        const job = { id: randomUUID(), store: storeId, action, status: 'queued',
            createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null, error: null };
        this.#jobs = [job, ...this.#jobs].slice(0, 16);
        // Start in a fresh microtask so both synchronous and asynchronous errors
        // become a failed receipt and the POST always returns promptly.
        void Promise.resolve().then(() => this.#run(() => stored.withStorageMutation(async () => {
            job.status = 'running';
            job.startedAt = new Date().toISOString();
            return target.store[method]();
        }, `cache.${action}`))).then(result => {
            job.result = result;
            job.status = 'completed';
        }, error => {
            job.error = error.message || String(error);
            job.status = 'failed';
        }).finally(() => { job.finishedAt = new Date().toISOString(); });
        return { ...job };
    }
}
