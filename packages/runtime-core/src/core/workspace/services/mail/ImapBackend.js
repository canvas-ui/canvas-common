import Debug from 'debug';
import Imap from 'imap';
import StorageBackend from 'canvas-stored/src/backends/StorageBackend.js';

const debug = Debug('stored:backend:imap');

const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_POLL_INTERVAL = 60000;
const DEFAULT_INITIAL_SYNC_DAYS = 180;
// Raw messages of a fetch batch are held in memory until the batch ingest
// resolves — keep the batch small enough that attachment-heavy mail can't
// balloon the heap.
const FETCH_BATCH_SIZE = 50;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * IMAP storage backend — owns the IMAP protocol for one account/folder.
 *
 * Addresses messages by `<folder>;UID=<n>` (RFC 5092). Emits `object:add` per
 * fetched message (kind:'message') so the workspace indexer can build documents;
 * change-detection is `scan()` (incremental search by UID) driven by `watch()`
 * (poll loop). Read + delete (EXPUNGE) supported; append (write) is not.
 *
 * config: { host, port=993, tls=true, allowSelfSigned=false, user, password,
 *           folder='INBOX', account?, pollInterval?, initialSyncDays?, lastUid? }
 */
export default class ImapBackend extends StorageBackend {
    #pollTimer = null;
    #lastUid = 0;
    #syncing = false;
    #scanPromise = null;
    #connections = new Set();
    #stopped = false;
    // Poll backoff: consecutive scan failures push the next attempt out
    // exponentially (capped) instead of re-running a possibly full initial
    // sync every poll tick.
    #failures = 0;
    #nextAttemptAt = 0;

    // Awaited ingest handlers injected by the owning service. scan() only
    // advances the UID cursor after they resolve, so a failed ingest never
    // silently skips a message (at-least-once; the service dedups on
    // re-ingest). onBatch (whole fetch batch at once) is preferred; onMessage
    // is the per-message fallback.
    onMessage = null;
    onBatch = null;

    constructor(name, config = {}) {
        super(name, config);
        this.type = 'remote';
        this.#lastUid = Math.max(0, Number(config.lastUid || 0));
        debug(`ImapBackend "${name}" initialized (account=${config.account ?? config.user ?? '?'}, folder=${this.#folder})`);
    }

    get capabilities() { return { read: true, write: false, delete: true }; }

    // imap://<account>/<folder>;UID=<n> — matches the provenance grammar.
    nativeUrl(key) { return `imap://${this.#account}/${key}`; }
    get watching() { return !!this.#pollTimer; }
    get lastUid() { return this.#lastUid; }
    get syncing() { return this.#scanPromise !== null; }
    get #folder() { return this.config.folder || DEFAULT_FOLDER; }
    get #account() { return this.config.account || this.config.user; }

    // ── connection ────────────────────────────────────────────────────────────
    #options() {
        const c = this.config;
        return {
            user: c.user,
            password: c.password,
            host: c.host,
            port: c.port || 993,
            tls: c.tls !== false,
            tlsOptions: { rejectUnauthorized: c.allowSelfSigned === false },
            authTimeout: c.authTimeout || 15000,
            connTimeout: c.connTimeout || 15000,
        };
    }

    // Connect, run `fn(imap)`, always end the connection.
    #withConnection(fn) {
        if (this.#stopped) return Promise.reject(this.#stoppedError());
        return new Promise((resolve, reject) => {
            const imap = new Imap(this.#options());
            let settled = false;
            const cancel = () => done(this.#stoppedError(), undefined, true);
            const done = (err, val, abort = false) => {
                if (settled) return;
                settled = true;
                this.#connections.delete(cancel);
                try { if (abort) imap.destroy(); else imap.end(); } catch { /* already closed */ }
                err ? reject(err) : resolve(val);
            };
            this.#connections.add(cancel);
            imap.once('ready', () => {
                if (settled) return;
                Promise.resolve().then(() => { if (!settled) return fn(imap, done); })
                    .then((val) => done(null, val), (e) => done(e));
            });
            imap.once('error', (e) => done(e));
            imap.once('close', () => done(new Error('IMAP connection closed before the operation completed')));
            try { imap.connect(); } catch (error) { done(error); }
        });
    }

    #stoppedError() { return Object.assign(new Error('IMAP backend was stopped'), { code: 'IMAP_STOPPED' }); }
    #assertActive() { if (this.#stopped) throw this.#stoppedError(); }

    #openBox(imap, folder, readOnly) {
        return new Promise((resolve, reject) => {
            imap.openBox(folder, readOnly, (err, box) => {
                if (err) return reject(err);
                if (imap.delimiter !== undefined) this.config.folderDelimiter = imap.delimiter;
                resolve(box);
            });
        });
    }

    // ── key parsing ─────────────────────────────────────────────────────────
    #parseKey(key) {
        const m = String(key || '').match(/^(.*);UID=(\d+)$/i);
        if (!m) throw new Error(`imap key must be "<folder>;UID=<n>", got: ${key}`);
        const folder = m[1].split('/').map((s) => decodeURIComponent(s)).join('/');
        return { folder, uid: Number(m[2]) };
    }

    #encodeFolder(value) {
        return String(value || DEFAULT_FOLDER).split('/').map(encodeURIComponent).join('/') || DEFAULT_FOLDER;
    }

    // ── CRUD ──────────────────────────────────────────────────────────────────
    async get(key, options = {}) {
        const { folder, uid } = this.#parseKey(key);
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            this.#openBox(imap, folder, true).then(() => {
                const f = imap.fetch(uid, { bodies: '' }); // top-level fetch is UID-based
                let found = false;
                f.on('message', (msg) => {
                    const chunks = [];
                    msg.on('body', (stream) => stream.on('data', (c) => chunks.push(Buffer.from(c))));
                    msg.once('end', () => { found = true; resolve(Buffer.concat(chunks)); });
                });
                f.once('error', reject);
                f.once('end', () => { if (!found) resolve(null); });
            }).catch(reject);
            void options; // streaming not supported for IMAP; buffer returned
        }));
    }

    async appendSent(raw, folder) {
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            imap.append(raw, { mailbox: folder, flags: ['\\Seen'] }, (error, uid) => error ? reject(error) : resolve(uid || null));
        }));
    }

    async delete(key) {
        const { folder, uid } = this.#parseKey(key);
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            this.#openBox(imap, folder, false) // read-write
                .then(() => new Promise((res, rej) => imap.addFlags(uid, '\\Deleted', (e) => (e ? rej(e) : res()))))
                .then(() => new Promise((res, rej) => imap.expunge([uid], (e) => (e ? rej(e) : res()))))
                .then(() => { debug(`EXPUNGE ${folder};UID=${uid}`); resolve(true); })
                .catch(reject);
        }));
    }

    async stat(key) {
        const data = await this.get(key);
        return data ? { key, size: data.length, modified: null, created: null } : null;
    }

    // ── connectivity / discovery ────────────────────────────────────────────
    async verify() {
        return this.#withConnection((imap) => this.#openBox(imap, this.#folder, true)
            .then((box) => ({ folder: box?.name || this.#folder, messageCount: box?.messages?.total || 0 })));
    }

    async listFolders() {
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => (err ? reject(err) : resolve(this.#flattenBoxes(boxes))));
        }));
    }

    #flattenBoxes(boxes = {}, parentPath = '', parentDelimiter = '/') {
        const folders = [];
        for (const [name, box] of Object.entries(boxes || {})) {
            const delimiter = box?.delimiter || parentDelimiter || '/';
            const folderPath = parentPath ? `${parentPath}${delimiter}${name}` : name;
            const attribs = (box?.attribs || []).map((a) => String(a).toLowerCase());
            folders.push({
                name, path: folderPath, delimiter,
                selectable: !attribs.includes('\\noselect'),
                attributes: box?.attribs || [],
            });
            if (box?.children) folders.push(...this.#flattenBoxes(box.children, folderPath, delimiter));
        }
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    // ── search / fetch helpers ────────────────────────────────────────────────
    #formatSearchDate(date) {
        return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }

    #searchCriteria() {
        if (this.#lastUid > 0) return [['UID', `${this.#lastUid + 1}:*`]];
        const days = Number(this.config.initialSyncDays ?? DEFAULT_INITIAL_SYNC_DAYS);
        if (days > 0) {
            const since = new Date();
            since.setDate(since.getDate() - days);
            return [['SINCE', this.#formatSearchDate(since)]];
        }
        return ['ALL'];
    }

    #fetchBatches(uids = [], batchSize = FETCH_BATCH_SIZE) {
        const values = uids.map(Number).filter((v) => Number.isInteger(v) && v > 0).sort((a, b) => a - b);
        const batches = [];
        for (let i = 0; i < values.length; i += batchSize) {
            batches.push(this.#rangeOf(values.slice(i, i + batchSize)));
        }
        return batches.filter(Boolean);
    }

    #rangeOf(values = []) {
        if (!values.length) return '';
        const ranges = [];
        let start = values[0], end = values[0];
        for (let i = 1; i < values.length; i++) {
            if (values[i] === end + 1) { end = values[i]; continue; }
            ranges.push(start === end ? `${start}` : `${start}:${end}`);
            start = end = values[i];
        }
        ranges.push(start === end ? `${start}` : `${start}:${end}`);
        return ranges.join(',');
    }

    #fetchBatch(imap, source) {
        this.#assertActive();
        return new Promise((resolve, reject) => {
            const fetch = imap.fetch(source, { bodies: '' });
            const payloads = [];
            fetch.on('message', (msg, seqno) => {
                const chunks = [];
                let attrs = {};
                msg.on('body', (stream) => stream.on('data', (c) => chunks.push(Buffer.from(c))));
                msg.once('attributes', (a) => { attrs = a || {}; });
                msg.once('end', () => {
                    const uid = Number(attrs.uid) || 0;
                    const folderKey = this.#encodeFolder(this.#folder);
                    payloads.push({
                        backend: this.name,
                        kind: 'message',
                        key: `${folderKey};UID=${uid}`,
                        raw: Buffer.concat(chunks),
                        uid,
                        uidValidity: this.config.uidValidity,
                        seqno,
                        flags: attrs.flags || [],
                        folder: this.#folder,
                        account: this.#account,
                    });
                });
            });
            fetch.once('error', reject);
            // Ingest is all-or-nothing per fetch batch: the cursor advances only
            // after the whole batch ingested, so a failure leaves #lastUid
            // untouched and the batch is refetched next pass (no skip; the
            // service dedups re-ingests).
            fetch.once('end', () => {
                (async () => {
                    this.#assertActive();
                    if (this.onBatch) {
                        await this.onBatch(payloads);
                    } else {
                        for (const payload of payloads) {
                            await (this.onMessage ? this.onMessage(payload) : this.emit('object:add', payload));
                        }
                    }
                    this.#assertActive();
                    const maxUid = payloads.reduce((max, p) => Math.max(max, p.uid || 0), this.#lastUid);
                    this.#lastUid = maxUid;
                })().then(resolve, reject);
            });
        });
    }

    /**
     * Incremental sync: search since last UID (or initialSyncDays / ALL), fetch
     * in batches, emit `object:add` per message. Returns { inserted, lastUid }.
     */
    scan(options = {}) {
        if (this.#scanPromise) return this.#scanPromise;
        this.#scanPromise = this.#scan(options).finally(() => { this.#scanPromise = null; });
        return this.#scanPromise;
    }

    async #scan(options = {}) {
        if (typeof options.lastUid === 'number') this.#lastUid = Math.max(this.#lastUid, options.lastUid);
        const checkpoint = { lastUid: this.#lastUid, uidValidity: this.config.uidValidity };
        try {
            const result = await this.#withConnection(async imap => {
                const box = await this.#openBox(imap, this.#folder, true);
                this.#assertActive();
                const uidValidity = String(box.uidvalidity || '');
                const previousValidity = this.config.uidValidity;
                const reset = Boolean(previousValidity && uidValidity && String(previousValidity) !== uidValidity);
                if (reset) this.#lastUid = 0;
                this.config.uidValidity = uidValidity;
                await this.onFolder?.({ account: this.#account, folder: this.#folder, delimiter: this.config.folderDelimiter });
                const search = criteria => {
                    this.#assertActive();
                    return new Promise((resolve, reject) => imap.search(criteria, (err, uids) => err ? reject(err) : resolve(uids || [])));
                };
                // ALL is a UID inventory only; raw messages are still fetched
                // incrementally. Failed searches/fetches never reconcile absence.
                const found = await search(this.#searchCriteria());
                const results = found.filter(uid => Number(uid) > this.#lastUid);
                for (const range of this.#fetchBatches(results)) await this.#fetchBatch(imap, range);
                const present = await search(['ALL']);
                this.#assertActive();
                await this.onInventory?.({ backend: this.name, account: this.#account, folder: this.#folder,
                    uids: present, uidValidity, reset, previousValidity, delimiter: this.config.folderDelimiter });
                this.#assertActive();
                const state = { backend: this.name, lastUid: this.#lastUid, uidValidity };
                if (this.onState) await this.onState(state);
                else this.emit('backend:state', state);
                return { inserted: results.length, lastUid: this.#lastUid, uidValidity };
            });
            this.#failures = 0;
            this.#nextAttemptAt = 0;
            return result;
        } catch (error) {
            // Retry the epoch transition after an incomplete inventory. Otherwise
            // legacy locations without an epoch could match reused UIDs next time.
            this.#lastUid = checkpoint.lastUid;
            this.config.uidValidity = checkpoint.uidValidity;
            this.#failures += 1;
            const interval = Number(this.config.pollInterval || DEFAULT_POLL_INTERVAL);
            const backoff = Math.min(interval * 2 ** this.#failures, MAX_BACKOFF_MS);
            this.#nextAttemptAt = Date.now() + backoff;
            debug(`scan failed for ${this.name} (attempt ${this.#failures}), backing off ${backoff}ms`);
            throw error;
        }
    }

    /**
     * Start polling (watchd-style change detection). Each tick runs an
     * incremental scan; messages surface as `object:add` events.
     */
    async watch() {
        if (this.#stopped) return false;
        if (this.#pollTimer) return true;
        const interval = Number(this.config.pollInterval || DEFAULT_POLL_INTERVAL);
        const tick = async () => {
            if (this.#syncing) return;
            // Failed scans (e.g. a failing initial sync) back off exponentially
            // instead of re-running a full sync attempt on every poll tick.
            if (Date.now() < this.#nextAttemptAt) return;
            this.#syncing = true;
            try { await this.scan(); }
            catch (e) { this.emit('error', e); }
            finally { this.#syncing = false; }
        };
        this.#pollTimer = setInterval(tick, interval);
        debug(`Polling ${this.name} every ${interval}ms`);
        return true;
    }

    async stop() {
        this.#stopped = true;
        if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null; debug(`Stopped polling ${this.name}`); }
        // Settings changes replace this instance. Retire its connections too,
        // so the old credentials cannot keep authenticating in the background.
        for (const cancel of this.#connections) cancel();
        await this.#scanPromise?.catch(() => {});
    }
}
