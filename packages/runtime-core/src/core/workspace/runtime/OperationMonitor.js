import { performance } from 'node:perf_hooks';

/** Reports unresolved work while it is still pending. Never times out a write,
 * releases its lock, or logs arguments (which may contain credentials/content).
 * A single timer serves every operation in a workspace.
 */
export default class OperationMonitor {
    #pending = new Map();
    #timer = null;
    #report;
    #threshold;
    constructor(report, { thresholdMs = 5000 } = {}) {
        this.#report = report;
        this.#threshold = Math.max(1, thresholdMs);
    }
    async drain() { await Promise.allSettled([...this.#pending.values()].map(item => item.promise)); }
    snapshot() {
        const now = performance.now();
        return [...this.#pending.values()].map(({ operation, started }) => ({ operation, elapsedMs: Math.round(now - started) }));
    }
    run(operation, action) {
        const started = performance.now();
        const result = action();
        if (!result || typeof result.then !== 'function') return result;
        const key = Symbol(operation);
        this.#pending.set(key, { operation, started, promise: result });
        if (!this.#timer) {
            this.#timer = setInterval(() => {
                const pending = this.snapshot().filter(op => op.elapsedMs >= this.#threshold);
                if (pending.length) {
                    try { this.#report({ pendingCount: this.#pending.size, operations: pending.slice(0, 12) }); }
                    catch { /* Diagnostics never interfere with pending work. */ }
                }
            }, this.#threshold);
            this.#timer.unref?.();
        }
        return Promise.resolve(result).finally(() => {
            this.#pending.delete(key);
            if (!this.#pending.size) { clearInterval(this.#timer); this.#timer = null; }
        });
    }
}
