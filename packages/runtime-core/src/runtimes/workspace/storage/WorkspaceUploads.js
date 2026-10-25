'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f-]{36}$/;

const uploadError = (statusCode, code, message, extra = {}) => Object.assign(new Error(message), { statusCode, code, ...extra });

/**
 * Resumable uploads. A session is a part file plus a JSON record under
 * `<var>/uploads/`; the client appends bytes at the offset the server holds
 * and, after a dropped connection, asks for that offset and continues. Sessions
 * outlive the connection, the workspace process and the server.
 *
 * A complete part is written to its target the way a single request would:
 * `{ type: 'blob' }` → the managed blob store (persistBlob), or
 * `{ type: 'object', driver, address, key, ... }` → a backend object
 * (writeBackendObject, with the same preconditions as PUT …/objects/*).
 *
 * Opening a session with the same size, target and sha256 or client
 * fingerprint as an unfinished one (for a backend object, size and target
 * alone) returns that session, so a client that lost its state (a reloaded
 * page) resumes from what the server already has. The server hashes the bytes
 * as they arrive, so clients need not hash large files first.
 */
export default class WorkspaceUploads {
    #workspace;
    #dir;
    #maxBytes;
    #ttlMs;
    #appending = new Set();
    #finalizing = new Set();
    // id → { hash, bytes }: sha256 of the part so far, kept while this process
    // receives it, so the finished file is neither re-read nor copied. A
    // restart loses it; the part is then hashed once when it is written.
    #digests = new Map();

    constructor(workspace, { dir, maxBytes, ttlMs }) {
        this.#workspace = workspace;
        this.#dir = dir;
        this.#maxBytes = maxBytes;
        this.#ttlMs = ttlMs;
    }

    get maxBytes() { return this.#maxBytes; }

    async create({ size, sha256 = null, fingerprint = null, target = { type: 'blob' } } = {}) {
        if (!Number.isSafeInteger(size) || size < 0) throw uploadError(400, 'INVALID_SIZE', 'size must be a non-negative integer');
        if (size > this.#maxBytes) throw uploadError(413, 'UPLOAD_TOO_LARGE', `File exceeds the upload limit of ${this.#maxBytes} bytes`, { limit: this.#maxBytes });
        const checksum = sha256 == null ? null : String(sha256).toLowerCase();
        if (checksum !== null && !SHA256.test(checksum)) throw uploadError(400, 'INVALID_SHA256', 'sha256 must be 64 hex characters');
        const mark = fingerprint == null || fingerprint === '' ? null : String(fingerprint).slice(0, 512);
        const normalized = WorkspaceUploads.#target(target);
        await this.#checkPreconditions(normalized);
        await fs.mkdir(this.#dir, { recursive: true });

        // Same file, same destination: its checksum, the client's fingerprint
        // of it (name, size, mtime: no hashing before the upload), or for a
        // backend object the key it is going to identifies it.
        if (checksum || mark || normalized.type === 'object') {
            const same = JSON.stringify(normalized);
            for (const session of await this.#sessions()) {
                if (session.sha256 === checksum && (session.fingerprint ?? null) === mark && session.size === size && JSON.stringify(session.target) === same
                    && (session.state === 'open' || session.state === 'finalizing' || session.error?.retryable)) return this.#describe(session);
            }
        }

        const now = new Date().toISOString();
        const session = { id: crypto.randomUUID(), size, sha256: checksum, fingerprint: mark, target: normalized, state: 'open', createdAt: now, updatedAt: now };
        await fs.writeFile(this.#part(session.id), '');
        await this.#save(session);
        return this.#describe(session);
    }

    async get(id) {
        return this.#describe(await this.#load(id));
    }

    /**
     * Append `stream` at `offset`. Whatever arrives before the connection drops
     * is kept; the answer (or a later get) says where to continue. Reaching the
     * size starts writing the target in the background: poll get() until the
     * state is `complete` (with `result`) or `failed` (with `error`). An empty
     * append at the full size retries a failed write; the bytes are kept.
     */
    async append(id, offset, stream) {
        const session = await this.#load(id);
        if (session.state === 'failed' && session.error?.retryable && offset === session.size) {
            stream.resume();
            Object.assign(session, { state: 'finalizing', error: undefined, updatedAt: new Date().toISOString() });
            await this.#save(session);
            this.#finalize(session);
            return this.#describe(session);
        }
        if (session.state !== 'open') throw uploadError(409, 'UPLOAD_NOT_OPEN', `Upload is ${session.state}`, { session: await this.#describe(session) });
        if (this.#appending.has(id)) throw uploadError(409, 'UPLOAD_BUSY', 'Another request is appending to this upload');
        this.#appending.add(id);
        try {
            const current = await this.#offset(id);
            if (offset !== current) throw uploadError(409, 'OFFSET_MISMATCH', `Upload is at offset ${current}`, { offset: current });
            // Chunk by chunk with awaited writes: everything that arrived before
            // a dropped connection is on disk, and the socket is paced by the disk.
            const file = await fs.open(this.#part(id), 'a');
            let written = current;
            let digest = this.#digests.get(id);
            if (digest?.bytes !== current) digest = current === 0 ? { hash: crypto.createHash('sha256'), bytes: 0 } : null;
            this.#digests.delete(id);
            try {
                for await (const chunk of stream) {
                    if (written + chunk.length > session.size) {
                        await file.truncate(current);
                        throw uploadError(413, 'UPLOAD_OVERFLOW', 'More bytes than the declared size');
                    }
                    await file.write(chunk);
                    written += chunk.length;
                    if (digest) { digest.hash.update(chunk); digest.bytes = written; }
                }
            } catch (error) {
                if (error.code === 'UPLOAD_OVERFLOW') throw error;
                // A dropped connection keeps what arrived; the client resumes from it.
            } finally {
                await file.close();
                if (digest?.bytes === written) this.#digests.set(id, digest);
            }
            session.updatedAt = new Date().toISOString();
            if (written === session.size) session.state = 'finalizing';
            await this.#save(session);
        } finally {
            this.#appending.delete(id);
        }
        if (session.state === 'finalizing') this.#finalize(session);
        return this.#describe(session);
    }

    async cancel(id) {
        const session = await this.#load(id);
        if (session.state === 'finalizing') throw uploadError(409, 'UPLOAD_FINALIZING', 'Upload is being written to its target');
        await this.#remove(id);
        return true;
    }

    /**
     * Drop sessions untouched for longer than the TTL (finished ones too, once
     * a client had time to read the result) and finish writes a stopped
     * process interrupted.
     */
    async sweep() {
        const cutoff = Date.now() - this.#ttlMs;
        for (const session of await this.#sessions()) {
            if (session.state === 'finalizing') this.#finalize(session);
            else if (Date.parse(session.updatedAt) < cutoff) await this.#remove(session.id);
        }
    }

    async #finalize(session) {
        if (this.#finalizing.has(session.id)) return;
        this.#finalizing.add(session.id);
        const part = this.#part(session.id);
        let keepPart = false;
        try {
            // The part is handed over (moved into place, never copied); a
            // digest from receiving it spares re-reading it to hash.
            const received = this.#digests.get(session.id);
            this.#digests.delete(session.id);
            const sha256 = received?.bytes === session.size ? received.hash.digest('hex') : null;
            if (sha256 && session.sha256 && sha256 !== session.sha256) {
                throw uploadError(422, 'CHECKSUM_MISMATCH', 'The uploaded bytes do not match the declared sha256');
            }
            const checksums = sha256 ? { sha256 } : undefined;
            const result = session.target.type === 'blob'
                ? await this.#workspace.persistBlob(part, { adopt: true, checksums })
                : await this.#writeObject(session, part, checksums);
            if (session.target.type === 'blob' && session.sha256 && result.checksum !== session.sha256) {
                throw uploadError(422, 'CHECKSUM_MISMATCH', 'The uploaded bytes do not match the declared sha256');
            }
            Object.assign(session, { state: 'complete', result });
        } catch (error) {
            // Wrong bytes are worthless; anything else (a backend offline, a
            // precondition the client can resolve) keeps them for a retry.
            keepPart = error.code !== 'CHECKSUM_MISMATCH';
            Object.assign(session, { state: 'failed', error: { code: error.code || 'UPLOAD_FAILED', message: error.message, statusCode: error.statusCode || 500, retryable: keepPart } });
        } finally {
            session.updatedAt = new Date().toISOString();
            if (!keepPart) await fs.rm(part, { force: true });
            await this.#save(session).catch(() => {});
            this.#finalizing.delete(session.id);
        }
    }

    async #writeObject(session, part, checksums) {
        const { driver, address, key, ifMatch, ifNoneMatch, mtime, mimeType } = session.target;
        const result = await this.#workspace.writeBackendObject(driver, address, key, part, {
            ifMatch, ifNoneMatch, mtime, mimeType, sha256: session.sha256 || undefined, adopt: true, checksums,
        });
        if (!result?.ok) throw uploadError(result?.reason === 'precondition-failed' ? 412 : 422, result?.code || String(result?.reason || 'OBJECT_WRITE_FAILED').toUpperCase().replace(/-/g, '_'), `Object write failed: ${result?.reason || 'unknown'}`);
        return {
            key: result.key, sha256: result.sha256, size: result.size, mtime: result.mtime ?? null,
            docId: result.docId ?? null, version: result.version ?? null, unchanged: result.unchanged === true,
        };
    }

    // An object target that cannot be written fails before any byte is sent.
    async #checkPreconditions(target) {
        if (target.type !== 'object' || (!target.ifMatch && target.ifNoneMatch !== '*')) return;
        const current = await this.#workspace.statBackendObject(target.driver, target.address, target.key);
        const etag = target.ifMatch?.replace(/^"|"$/g, '');
        if ((target.ifNoneMatch === '*' && current) || (etag && current?.sha256 !== etag)) {
            throw uploadError(412, 'PRECONDITION_FAILED', target.ifNoneMatch === '*' ? 'An object with this key already exists' : 'The object changed since this edit started');
        }
    }

    static #target(target = {}) {
        if (target.type === 'blob') return { type: 'blob' };
        if (target.type !== 'object') throw uploadError(400, 'INVALID_TARGET', "target.type must be 'blob' or 'object'");
        const text = (value, max = 4096) => (value == null || value === '' ? undefined : String(value).slice(0, max));
        const out = {
            type: 'object', driver: text(target.driver, 64) === 'fs' ? 'file' : text(target.driver, 64), address: text(target.address, 256), key: text(target.key),
            ifMatch: text(target.ifMatch, 128), ifNoneMatch: text(target.ifNoneMatch, 8), mimeType: text(target.mimeType, 128),
            mtime: Number.isFinite(target.mtime) ? target.mtime : undefined,
        };
        if (!out.driver || !out.address || !out.key) throw uploadError(400, 'INVALID_TARGET', 'An object target needs driver, address and key');
        return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
    }

    async #describe(session) {
        const offset = session.state === 'open' || session.state === 'failed' ? await this.#offset(session.id) : session.size;
        const { id, size, sha256, target, state, createdAt, updatedAt, result, error } = session;
        return { id, size, offset, sha256, target, state, createdAt, updatedAt, expiresAt: new Date(Date.parse(updatedAt) + this.#ttlMs).toISOString(),
            ...(result ? { result } : {}), ...(error ? { error } : {}) };
    }

    async #offset(id) {
        try { return (await fs.stat(this.#part(id))).size; } catch { return 0; }
    }

    async #sessions() {
        let names;
        try { names = await fs.readdir(this.#dir); } catch { return []; }
        const out = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            try { out.push(JSON.parse(await fs.readFile(path.join(this.#dir, name), 'utf8'))); } catch { /* half-written record: ignored, swept with its part */ }
        }
        return out;
    }

    async #load(id) {
        if (!ID.test(String(id))) throw uploadError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
        try { return JSON.parse(await fs.readFile(this.#record(id), 'utf8')); } catch { throw uploadError(404, 'UPLOAD_NOT_FOUND', 'Upload not found'); }
    }

    async #save(session) {
        const temp = `${this.#record(session.id)}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temp, JSON.stringify(session), { mode: 0o600 });
        await fs.rename(temp, this.#record(session.id));
    }

    async #remove(id) {
        this.#digests.delete(id);
        await Promise.all([fs.rm(this.#part(id), { force: true }), fs.rm(this.#record(id), { force: true })]);
    }

    #part(id) { return path.join(this.#dir, `${id}.part`); }
    #record(id) { return path.join(this.#dir, `${id}.json`); }
}
