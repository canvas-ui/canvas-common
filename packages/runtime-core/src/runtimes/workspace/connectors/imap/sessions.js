import crypto from 'node:crypto';
import Debug from 'debug';
import Imap from 'imap';

const debug = Debug('stored:backend:imap:sessions');

// Per account: at most this many authenticated connections, shared by every
// mailbox folder and one-off operation in the process. Two lets a long initial
// sync run without blocking polls, reads and moves on the same account.
const MAX_CONNECTIONS = 2;
// An unused connection logs out after this long. Longer than the poll
// interval, so a polled account keeps one connection open (node-imap IDLEs
// or NOOPs it) instead of logging in on every tick.
const IDLE_CLOSE_MS = 5 * 60 * 1000;

const accounts = new Map(); // key -> Account

class Account {
    #key;
    #options;
    #connections = new Set(); // Connection
    #waiting = []; // { start, reject }

    constructor(key, options) {
        this.#key = key;
        this.#options = options;
    }

    // Run `fn(imap)` on a free connection of this account. Returns the result
    // promise and a cancel() that rejects with `cancelError` and drops the
    // connection the operation was using (its protocol state is unknown).
    run(fn, cancelError) {
        let cancel;
        const promise = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err, val) => {
                if (settled) return;
                settled = true;
                err ? reject(err) : resolve(val);
            };
            const start = (connection) => {
                if (settled) return this.#release(connection);
                connection.exec(fn).then((val) => finish(null, val), (err) => finish(err))
                    .finally(() => { waiter.connection = null; this.#release(connection); });
            };
            // `connection` is set while the waiter holds one, logging in or running.
            const waiter = { start, reject: (err) => finish(err), connection: null };
            cancel = () => {
                if (settled) return;
                const index = this.#waiting.indexOf(waiter);
                if (index !== -1) this.#waiting.splice(index, 1);
                waiter.connection?.destroy();
                finish(cancelError());
            };
            this.#acquire(waiter);
        });
        return { promise, cancel };
    }

    #acquire(waiter) {
        const free = [...this.#connections].find((c) => !c.busy);
        if (free) return free.claim(waiter);
        if (this.#connections.size >= MAX_CONNECTIONS) return this.#waiting.push(waiter);
        const connection = new Connection(this.#options, () => this.#forget(connection));
        this.#connections.add(connection);
        connection.claim(waiter, true);
    }

    #release(connection) {
        if (!this.#connections.has(connection)) return;
        connection.busy = false;
        const next = this.#waiting.shift();
        if (next) connection.claim(next);
        else connection.idle(IDLE_CLOSE_MS);
    }

    #forget(connection) {
        this.#connections.delete(connection);
        // Waiters queued behind a dead connection get a fresh one.
        while (this.#waiting.length && this.#connections.size < MAX_CONNECTIONS) this.#acquire(this.#waiting.shift());
        if (!this.#connections.size && !this.#waiting.length) accounts.delete(this.#key);
    }

    close() { for (const connection of this.#connections) connection.end(); }
}

class Connection {
    #imap;
    #ready;
    #idleTimer = null;
    #fail = null; // rejects the running operation when the socket goes away
    #onGone;
    #gone = false;
    busy = false;

    constructor(options, onGone) {
        this.#onGone = onGone;
        this.#imap = new Imap(options);
        this.#ready = new Promise((resolve, reject) => {
            this.#imap.once('ready', resolve);
            this.#imap.once('error', reject);
        });
        this.#ready.catch(() => {});
        // Persistent listeners: an idle connection can still error or drop.
        this.#imap.on('error', (err) => this.#lost(err));
        this.#imap.on('close', () => this.#lost(new Error('IMAP connection closed before the operation completed')));
        this.#imap.on('end', () => this.#lost(new Error('IMAP connection ended before the operation completed')));
        try { this.#imap.connect(); } catch (err) { this.#lost(err); }
        debug(`connect ${options.user}@${options.host}`);
    }

    // Mark busy and hand the connection to the waiter once it is
    // authenticated. A failed login rejects the waiter that opened it.
    claim(waiter, opened = false) {
        this.busy = true;
        waiter.connection = this;
        clearTimeout(this.#idleTimer);
        this.#ready.then(() => waiter.start(this), (err) => {
            if (opened) waiter.reject(err);
            else waiter.start(this); // exec() rejects with the connection error
        });
    }

    exec(fn) {
        if (this.#gone) return Promise.reject(new Error('IMAP connection is closed'));
        return new Promise((resolve, reject) => {
            this.#fail = reject;
            Promise.resolve().then(() => fn(this.#imap)).then(resolve, reject);
        }).finally(() => { this.#fail = null; });
    }

    idle(ms) {
        clearTimeout(this.#idleTimer);
        this.#idleTimer = setTimeout(() => this.end(), ms);
        this.#idleTimer.unref?.();
    }

    end() {
        if (this.#gone) return;
        this.#lost(new Error('IMAP connection closed'));
        try { this.#imap.end(); } catch { this.#imap.destroy(); }
    }

    destroy() {
        try { this.#imap.destroy(); } catch { /* already closed */ }
        this.#lost(new Error('IMAP connection closed'));
    }

    #lost(err) {
        this.#fail?.(err);
        if (this.#gone) return;
        this.#gone = true;
        clearTimeout(this.#idleTimer);
        debug(`disconnected: ${err?.message}`);
        this.#onGone();
    }
}

// Connections are keyed by the full credentials, so changed settings never
// reuse a connection authenticated with the old ones.
function accountKey(options) {
    const { host, port, tls, user, password, tlsOptions } = options;
    return crypto.createHash('sha256')
        .update(JSON.stringify([host, port, tls, user, password, tlsOptions?.rejectUnauthorized])).digest('hex');
}

export function runImapOperation(options, fn, cancelError) {
    const key = accountKey(options);
    let account = accounts.get(key);
    if (!account) accounts.set(key, account = new Account(key, options));
    return account.run(fn, cancelError);
}

export function closeImapSessions() {
    for (const account of accounts.values()) account.close();
}
