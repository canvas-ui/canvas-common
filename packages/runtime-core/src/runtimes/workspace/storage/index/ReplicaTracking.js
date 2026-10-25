export default class ReplicaTracking {
    #runtime;
    constructor(_index, runtime) { this.#runtime = runtime; }


    // ── Replicas: what each device reports it holds ───────────────────────
    //
    // `replicas` sub-db in the stored index env: `<deviceId>/<docId>` → version
    // the device has verified + fsynced (docs/durable-workspaces.md). A
    // document is *protected* when every required replica holds its current
    // row version. Written from the mirror status report (`applied` delta or a
    // `full` snapshot), read by the Sync tab. Never an input to sync itself.

    get #replicaDb() {
        if (!this.#runtime.state.replicas) this.#runtime.state.replicas = this.#runtime.state.stored.index.openDB('replicas');
        return this.#runtime.state.replicas;
    }

    recordReplicaApplied(deviceId, pairs = [], { full = false } = {}) {
        const dev = String(deviceId || '').trim();
        if (!dev) throw new Error('deviceId is required');
        const db = this.#replicaDb;
        const head = `${dev}/`;
        let written = 0;
        db.transactionSync(() => {
            if (full) {
                for (const { key } of db.getRange({ start: head, end: `${head}\uffff` })) {
                    if (typeof key === 'string' && key.startsWith(head)) db.removeSync(key);
                }
            }
            for (const pair of Array.isArray(pairs) ? pairs : []) {
                const docId = Number(pair?.[0]);
                const version = Number(pair?.[1]);
                if (!Number.isInteger(docId) || docId <= 0 || !Number.isInteger(version) || version <= 0) continue;
                const k = `${head}${docId}`;
                if (!full && (db.get(k) ?? 0) >= version) continue;
                db.putSync(k, version);
                written += 1;
            }
            db.putSync(`meta/${dev}`, { updatedAt: Date.now(), full: full || undefined });
        });
        return { deviceId: dev, written, full };
    }

    replicaVersion(deviceId, docId) {
        const v = this.#replicaDb.get(`${deviceId}/${docId}`);
        return Number.isInteger(v) ? v : null;
    }

    forgetReplica(deviceId) {
        const dev = String(deviceId || '').trim();
        if (!dev) return 0;
        const db = this.#replicaDb;
        const head = `${dev}/`;
        let removed = 0;
        db.transactionSync(() => {
            for (const { key } of db.getRange({ start: head, end: `${head}\uffff` })) {
                if (typeof key === 'string' && key.startsWith(head)) { db.removeSync(key); removed += 1; }
            }
            db.removeSync(`meta/${dev}`);
        });
        return removed;
    }

    /**
     * Walk one backend's listing and compare every document's current row
     * version with what each device holds.
     *   `required` — devices that must hold the version for "protected";
     *   `devices`  — every device to report `behind` for (superset of required).
     * Bounded by `limit` objects (`partial: true` when hit); `sample` oldest
     * unprotected documents (by mtime) are returned for the UI.
     */
    async replicaProtection(backendName, { required = [], devices = [], limit = 200000, sample = 20 } = {}) {
        this.#runtime.objects.objectsBackend(backendName);
        const req = [...new Set(required.map(String))];
        const all = [...new Set([...req, ...devices.map(String)])];
        const db = this.#replicaDb;
        const behind = Object.fromEntries(all.map((d) => [d, 0]));
        const held = Object.fromEntries(all.map((d) => [d, 0]));
        let total = 0;
        let unversioned = 0;
        let protectedCount = 0;
        const oldest = [];
        let after = null;
        let partial = false;
        do {
            const page = this.#runtime.state.stored.listObjects(backendName, { after, limit: 5000 });
            for (const o of page.objects || []) {
                if (total >= limit) { partial = true; break; }
                total += 1;
                const docId = await this.#runtime.objects.docIdForStoredId(o.id);
                const version = await this.#runtime.objects.docVersion(docId);
                if (!docId || !version) { unversioned += 1; continue; }
                let ok = req.length > 0;
                for (const d of all) {
                    const have = db.get(`${d}/${docId}`);
                    const current = Number.isInteger(have) && have >= version;
                    if (current) held[d] += 1; else behind[d] += 1;
                    if (!current && req.includes(d)) ok = false;
                }
                if (ok) { protectedCount += 1; continue; }
                if (req.length === 0) continue;
                const entry = { key: o.key, docId, version, mtime: o.mtime ?? null, size: o.size ?? null };
                if (oldest.length < sample) oldest.push(entry);
                else {
                    const worst = oldest.reduce((m, e, i) => ((e.mtime ?? 0) > (oldest[m].mtime ?? 0) ? i : m), 0);
                    if ((entry.mtime ?? 0) < (oldest[worst].mtime ?? 0)) oldest[worst] = entry;
                }
            }
            after = partial ? null : page.cursor;
        } while (after);
        oldest.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
        const meta = Object.fromEntries(all.map((d) => [d, db.get(`meta/${d}`) || null]));
        return {
            backend: backendName,
            required: req,
            total,
            unversioned,
            protected: req.length ? protectedCount : null,
            unprotected: req.length ? total - unversioned - protectedCount : null,
            partial,
            replicas: Object.fromEntries(all.map((d) => [d, { behind: behind[d], held: held[d], required: req.includes(d), reportedAt: meta[d]?.updatedAt ?? null }])),
            oldestUnprotected: oldest,
        };
    }
}
