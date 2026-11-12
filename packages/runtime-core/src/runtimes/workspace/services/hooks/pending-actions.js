'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Per-workspace pending-action (approval) store.
 *
 * Automation that needs human sign-off proposes its side effect instead of
 * executing it: the proposal lands here, the review UI / CLI lists it, a
 * decision (approve / decline, optionally amended) resolves it. Approval
 * executes the stored actions through the ordinary rule-action pipeline with
 * the original provenance chain, so cascade guards and the run log behave as
 * if the handler had executed directly.
 *
 * Storage: `{WORKSPACE_ROOT}/var/hooks/pending.jsonl` (+ `.1` rotation) —
 * same append-only JSONL discipline as run-log.js. Records are immutable;
 * a status transition appends a superseding FULL record with the same
 * `actionId`, and reads resolve last-write-wins per actionId. This keeps the
 * file crash-safe. Rotation drops the older file's decided records only: a
 * proposal still waiting there is copied into the new live file first.
 *
 * Record shape (one line):
 *   { actionId, ts, status: 'pending'|'approved'|'declined'|'failed'|'expired',
 *     handlerType: 'rule'|'hook', handler,        // rule id | hook file rel. hooks/
 *     when, pathMatch,                          // original conditions and resolved filing destination
 *     event, envelope,                            // replay envelope (doc → {id, schema})
 *     provenance: { origin, causedBy, depth },    // of the TRIGGERING event
 *     title, summary,
 *     actions: [ { action, ... } ],               // rule-action objects, executed on approve
 *     editable: ['actions.0.draft.body', ...],    // JSON paths the reviewer may amend
 *     expiresAt?,                                 // ISO ts; pending past this = expired
 *     decidedAt?, decidedBy?, amended?,           // set by the deciding append
 *     result? }                                   // per-action outcomes after execution
 */

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const STATUSES = Object.freeze(['pending', 'approved', 'declined', 'failed', 'expired']);

// A pending record whose expiresAt has passed reads as expired (no eager
// sweep needed — expiry is a read-time view, persisted lazily on decision).
function effectiveStatus(record, now = Date.now()) {
    if (record.status === 'pending' && record.expiresAt && Date.parse(record.expiresAt) < now) {
        return 'expired';
    }
    return record.status;
}

// Two proposals are the same when one handler holds the same actions for the
// same document. Proposals without a document are never the same.
function proposalKey(record) {
    const documentId = record.envelope?.payload?.document?.id ?? record.envelope?.payload?.id;
    if (documentId == null) { return null; }
    return `${record.handlerType}|${record.handler}|${documentId}|${JSON.stringify(record.actions)}`;
}

class PendingActionStore {
    #file;
    #dir;
    #maxBytes;
    #size = null;
    #carried = 0;
    // Open proposals by proposalKey, loaded from the log on first use.
    #open = null;

    // Takes the ALREADY-RESOLVED dir (workspace.varHooksPath), not the
    // workspace root: joining the `full` layout's constant onto the root put
    // this log in the user's own drive for a `home`-layout workspace, where
    // the root IS that drive and the internals belong under `.workspace/`.
    constructor(varHooksPath, { maxBytes = MAX_BYTES_DEFAULT } = {}) {
        this.#dir = varHooksPath;
        this.#file = path.join(this.#dir, 'pending.jsonl');
        this.#maxBytes = maxBytes;
    }

    get filePath() { return this.#file; }

    static get statuses() { return STATUSES; }

    /**
     * Append a new proposal. Never throws.
     * @param {Object} record - partial record; actionId/ts/status filled in
     * @returns {Object|null} the full record, or null when the write failed
     */
    propose(record) {
        const full = {
            actionId: record.actionId || `pa_${crypto.randomUUID()}`,
            ts: record.ts || new Date().toISOString(),
            status: 'pending',
            ...record,
        };
        return this.#append(full) ? full : null;
    }

    /**
     * Append a new proposal unless the same one is already waiting for
     * review. A rule can match several events for one document (insert, then
     * every update of a mail sync); the reviewer decides once.
     * @returns {Promise<{record: Object|null, existing: boolean}>}
     */
    async proposeOnce(record) {
        const open = await this.#openProposals();
        const key = proposalKey(record);
        const known = key ? open.get(key) : null;
        if (known && !(known.expiresAt && Date.parse(known.expiresAt) < Date.now())) {
            return { record: await this.get(known.actionId), existing: true };
        }
        const full = this.propose(record);
        if (full && key) { open.set(key, { actionId: full.actionId, expiresAt: full.expiresAt }); }
        return { record: full, existing: false };
    }

    async #openProposals() {
        if (!this.#open) {
            const open = new Map();
            for (const record of (await this.#latest()).values()) {
                const key = record.status === 'pending' ? proposalKey(record) : null;
                if (key && !open.has(key)) { open.set(key, { actionId: record.actionId, expiresAt: record.expiresAt }); }
            }
            this.#open ??= open;
        }
        return this.#open;
    }

    /**
     * Append a superseding record for a status transition. The caller passes
     * the CURRENT record (from get()) plus the fields that change.
     * @returns {Object|null} the superseding record, or null on write failure
     */
    supersede(record, changes) {
        const full = { ...record, ...changes, ts: new Date().toISOString() };
        if (!this.#append(full)) { return null; }
        if (this.#open && full.status !== 'pending') {
            for (const [key, known] of this.#open) {
                if (known.actionId === full.actionId) { this.#open.delete(key); }
            }
        }
        return full;
    }

    #append(full) {
        try {
            fs.mkdirSync(this.#dir, { recursive: true });
            const line = `${JSON.stringify(full)}\n`;
            this.#rotateIfNeeded(line.length);
            fs.appendFileSync(this.#file, line, 'utf8');
            this.#size = (this.#size ?? 0) + line.length;
            return true;
        } catch {
            this.#size = null;
            return false;
        }
    }

    #rotateIfNeeded(incomingBytes) {
        if (this.#size === null) {
            try { this.#size = fs.statSync(this.#file).size; }
            catch { this.#size = 0; }
        }
        // Carried proposals do not count: a queue larger than the limit must
        // not rotate on every append.
        if (this.#size - this.#carried + incomingBytes <= this.#maxBytes) { return; }
        const waiting = this.#waitingInOlderFile();
        try { fs.renameSync(this.#file, `${this.#file}.1`); } catch { /* live file may be absent */ }
        fs.writeFileSync(this.#file, waiting, 'utf8');
        this.#size = this.#carried = waiting.length;
    }

    // Lines of the older file whose proposal is still undecided and unexpired.
    // The older file is about to be replaced, and they exist nowhere else.
    #waitingInOlderFile() {
        const read = (file) => {
            try { return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()); }
            catch { return []; }
        };
        const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
        const inLive = new Set(read(this.#file).map((line) => parse(line)?.actionId));
        const seen = new Set();
        const waiting = [];
        for (const line of read(`${this.#file}.1`).reverse()) {
            const record = parse(line);
            if (!record?.actionId || seen.has(record.actionId)) { continue; }
            seen.add(record.actionId);
            if (!inLive.has(record.actionId) && effectiveStatus(record) === 'pending') { waiting.push(line); }
        }
        return waiting.reverse().map((line) => `${line}\n`).join('');
    }

    /**
     * Read pending-action records, newest proposal first, last-write-wins per
     * actionId (a decided action reports its decided state, not the original
     * pending record).
     * @param {Object} opts
     * @param {string} opts.status - filter by effective status
     * @param {string} opts.handler - filter: handler equals or contains
     * @param {number} opts.limit - max records (default 100, cap 500)
     * @returns {Promise<Object[]>}
     */
    async query(opts = {}) {
        return (await this.page(opts)).actions;
    }

    /**
     * One page of query() plus how many records match the filter in all.
     * @returns {Promise<{actions: Object[], total: number}>}
     */
    async page({ status, handler, limit = 100 } = {}) {
        const max = Math.min(Math.max(1, Number(limit) || 100), 500);
        const matches = await this.matching({ status, handler });
        return { actions: matches.slice(0, max), total: matches.length };
    }

    /** Every record that matches the filter, newest proposal first. */
    async matching({ status, handler } = {}) {
        const now = Date.now();
        const matches = [];
        for (const record of (await this.#latest()).values()) {
            const effective = effectiveStatus(record, now);
            if (status && effective !== status) { continue; }
            if (handler && !(record.handler === handler || String(record.handler || '').includes(handler))) { continue; }
            matches.push({ ...record, status: effective });
        }
        return matches;
    }

    // actionId -> newest record, newest proposal first.
    async #latest() {
        const byId = new Map();
        for (const file of [this.#file, `${this.#file}.1`]) {
            let content;
            try { content = await fs.promises.readFile(file, 'utf8'); }
            catch { continue; }

            const lines = content.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) { continue; }
                let record;
                try { record = JSON.parse(line); } catch { continue; }
                if (!record.actionId || byId.has(record.actionId)) { continue; }
                byId.set(record.actionId, record);
            }
        }
        return byId;
    }

    /** Current state of one action (last-write-wins), or null. */
    async get(actionId) {
        if (!actionId) { return null; }
        for (const file of [this.#file, `${this.#file}.1`]) {
            let content;
            try { content = await fs.promises.readFile(file, 'utf8'); }
            catch { continue; }
            const lines = content.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line || !line.includes(actionId)) { continue; }
                try {
                    const record = JSON.parse(line);
                    if (record.actionId === actionId) {
                        return { ...record, status: effectiveStatus(record) };
                    }
                } catch { continue; }
            }
        }
        return null;
    }
}

/**
 * Apply reviewer amendments to a record's actions, restricted to the
 * `editable` JSON-path allowlist. Paths are dot-notation into the record
 * (e.g. 'actions.0.draft.body'). Throws on any path outside the allowlist.
 * @param {Object} record
 * @param {Object} amend - { '<json-path>': value }
 * @returns {Object} new record with amended actions (original untouched)
 */
export function applyAmendments(record, amend) {
    if (!amend || typeof amend !== 'object' || !Object.keys(amend).length) { return record; }
    const allowed = new Set(Array.isArray(record.editable) ? record.editable : []);
    const next = structuredClone({ actions: record.actions });

    for (const [keyPath, value] of Object.entries(amend)) {
        if (!allowed.has(keyPath)) {
            throw new Error(`Field "${keyPath}" is not amendable for this action`);
        }
        const keys = keyPath.split('.');
        let target = next;
        for (let i = 0; i < keys.length - 1; i++) {
            target = target?.[keys[i]];
            if (target == null || typeof target !== 'object') {
                throw new Error(`Amend path "${keyPath}" does not resolve`);
            }
        }
        target[keys[keys.length - 1]] = value;
    }
    return { ...record, actions: next.actions, amended: true };
}

export default PendingActionStore;
