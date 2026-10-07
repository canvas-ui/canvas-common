// Local performance diagnostics. OFF unless CANVAS_PERF_MONITOR=1; every
// record* call is a no-op otherwise. Not meant for deployed instances.
//
// Every CANVAS_PERF_MONITOR_INTERVAL_MS (default 10 s) a summary of the window
// just ended goes to stdout (plain lines, readable next to the pino output):
//   - event loop: delay p50/p99/max (ms) and utilization (% busy)
//   - db ops: synapsd calls by total time (count, avg, max). A write's time
//     includes waiting for the synapsd write lock.
//   - named spans (mail ingest phases, …)
//   - http: request count, p95, slowest requests
//   - socket: events pushed to browsers, by name
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const perfEnabled = process.env.CANVAS_PERF_MONITOR === '1' || process.env.CANVAS_PERF_MONITOR === 'true';
const INTERVAL_MS = Math.max(1000, Number(process.env.CANVAS_PERF_MONITOR_INTERVAL_MS) || 10000);
const SLOW_HTTP_MS = 500;
const RESOLUTION_MS = 10;

let window = freshWindow();
function freshWindow() {
    return { ops: new Map(), http: [], socket: new Map() };
}

function bump(map, name, ms) {
    const s = map.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
    s.count++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms);
    map.set(name, s);
}

/** Record one timed operation (db call or named span). */
export function recordOp(name, ms) {
    if (perfEnabled) bump(window.ops, name, ms);
}

/** Time an async function as a named span. */
export async function timeSpan(name, fn) {
    if (!perfEnabled) return fn();
    const start = performance.now();
    try { return await fn(); } finally { recordOp(name, performance.now() - start); }
}

export function recordHttp(method, url, statusCode, ms) {
    if (!perfEnabled) return;
    // Keep query strings out: they carry search terms and tokens.
    window.http.push({ route: `${method} ${String(url).split('?')[0]}`, statusCode, ms });
}

export function recordSocketEvent(eventName) {
    if (perfEnabled) window.socket.set(eventName, (window.socket.get(eventName) || 0) + 1);
}

// Methods that are plumbing, not work.
const SKIP_METHODS = new Set(['constructor', 'on', 'off', 'once', 'emit', 'addListener', 'removeListener', 'onAny', 'offAny', 'listeners']);

/**
 * Wrap a synapsd instance's public methods so each call is timed. Instance
 * properties shadow the prototype; `this` stays the instance, so private
 * fields keep working. Nested calls (put → get) are counted separately.
 */
export function instrumentDb(db) {
    if (!perfEnabled || !db || db.__perfInstrumented) return db;
    const seen = new Set();
    for (let proto = Object.getPrototypeOf(db); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (seen.has(name) || SKIP_METHODS.has(name) || name.startsWith('_')) continue;
            seen.add(name);
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (!descriptor || typeof descriptor.value !== 'function') continue; // getters stay untouched
            const original = descriptor.value;
            const label = `db.${name}`;
            db[name] = function timed(...args) {
                const start = performance.now();
                let result;
                try { result = original.apply(this, args); }
                catch (error) { recordOp(label, performance.now() - start); throw error; }
                if (result && typeof result.then === 'function') {
                    return result.finally(() => recordOp(label, performance.now() - start));
                }
                recordOp(label, performance.now() - start);
                return result;
            };
        }
    }
    Object.defineProperty(db, '__perfInstrumented', { value: true });
    return db;
}

const fmt = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

function summarize(histogram, elu) {
    const w = window;
    window = freshWindow();
    // The histogram samples every RESOLUTION_MS, and each sample includes that
    // wait: subtract it so an idle loop reads ~0 ms of lag.
    const lag = (ns) => fmt(Math.max(0, ns / 1e6 - RESOLUTION_MS));
    const loop = {
        p50: lag(histogram.percentile(50)),
        p99: lag(histogram.percentile(99)),
        max: lag(histogram.max),
        busyPct: Math.round(elu.utilization * 100),
    };
    const ops = [...w.ops.entries()]
        .sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 12)
        .map(([name, s]) => `${name} n=${s.count} total=${fmt(s.totalMs)} avg=${fmt(s.totalMs / s.count)} max=${fmt(s.maxMs)}`);
    const times = w.http.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = times.length ? fmt(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]) : 0;
    const slow = w.http.filter((r) => r.ms >= SLOW_HTTP_MS).sort((a, b) => b.ms - a.ms).slice(0, 5)
        .map((r) => `${r.route} ${r.statusCode} ${fmt(r.ms)}ms`);
    const socketTotal = [...w.socket.values()].reduce((a, b) => a + b, 0);
    const socket = [...w.socket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`);
    return { loop, ops, http: { count: times.length, p95, slow }, socket: { total: socketTotal, top: socket } };
}

let started = false;
export function startPerfMonitor() {
    if (!perfEnabled || started) return;
    started = true;
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    let lastElu = performance.eventLoopUtilization();
    const timer = setInterval(() => {
        const elu = performance.eventLoopUtilization(lastElu);
        lastElu = performance.eventLoopUtilization();
        const s = summarize(histogram, elu);
        histogram.reset();
        const lines = [
            `[perf] loop p50=${s.loop.p50}ms p99=${s.loop.p99}ms max=${s.loop.max}ms busy=${s.loop.busyPct}%`
                + ` | http n=${s.http.count} p95=${s.http.p95}ms | socket events=${s.socket.total}`,
            ...s.ops.map((l) => `[perf]   ${l}`),
            ...(s.http.slow.length ? [`[perf]   slow http: ${s.http.slow.join(' ; ')}`] : []),
            ...(s.socket.top.length ? [`[perf]   socket: ${s.socket.top.join(' ')}`] : []),
        ];
        console.log(lines.join('\n'));
    }, INTERVAL_MS);
    timer.unref();
    console.log(`[perf] monitor on, ${INTERVAL_MS} ms windows`);
}
