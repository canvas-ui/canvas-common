'use strict';

import { createTlsTransport } from '@augmentd-labs/canvas-api-client/tls';
import fs from 'fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShareSource } from 'canvas-stored';
import { DEFAULT_SYNC_EXCLUSIONS } from '@augmentd-labs/canvas-protocol';

const POLL_WAIT_MS = 25_000;
const NOTIFY_DEBOUNCE_MS = 500;
const FOLDER_RETRY_MS = 15_000;
const RESCAN_EVERY_MS = 6 * 60 * 60_000;
// Each read holds up to one window (4 MiB) of a file in memory until it is
// sent, so only this many run at once; the rest wait their turn as requests.
const MAX_READS = 4;
// The workspace gives up on a read after two minutes: one that waited nearly
// that long here is dropped instead of read for nobody.
const READ_TTL_MS = 100_000;
// More waiting reads than this are refused at once (`BUSY`) rather than kept.
const MAX_QUEUED_READS = 256;
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/*
 * What a share never lists, on top of DEFAULT_SYNC_EXCLUSIONS (dotfiles,
 * dependency and cache folders): operating-system and NAS bookkeeping,
 * recycle bins, half-written downloads, temp and log files. A share exists to
 * find documents, media and archives; anything that can be recreated by
 * installing or running something is noise in that catalog.
 */
export const SHARE_EXCLUSIONS = Object.freeze([
    '**/$RECYCLE.BIN/**', '**/RECYCLER/**', '**/System Volume Information/**', '**/lost+found/**',
    '**/#recycle/**', '**/#snapshot/**', '**/@eaDir/**', '**/@tmp/**', '**/@Recycle/**', '**/@Recently-Snapshot/**',
    '**/Thumbs.db', '**/ehthumbs.db', '**/desktop.ini', '**/pagefile.sys', '**/hiberfil.sys', '**/swapfile.sys',
    '**/~$*', '**/*~', '**/*.part', '**/*.partial', '**/*.crdownload', '**/*.download', '**/*.!qB',
    '**/*.log', '**/*.pid', '**/*.sock', '**/*.lock', '**/*.pyc', '**/*.class',
    '**/tmp/**', '**/temp/**', '**/Temp/**', '**/venv/**', '**/site-packages/**', '**/dist-packages/**',
    '**/DerivedData/**',
]);

/**
 * One shared folder served to one workspace (`unit: 'share'`): a ShareSource
 * that hashes and watches the folder into its own index, and a loop that
 * hands it the requests the workspace queued. The daemon only dials out:
 *
 *   POST /workspaces/<ws>/backends/share                   register (every start)
 *   POST /workspaces/<ws>/backends/share/<name>/poll       check in, collect requests
 *   POST /workspaces/<ws>/backends/share/<name>/requests/<id>   answer one
 *   DELETE /workspaces/<ws>/backends/share/<name>/poll     going away (on stop)
 *
 * The folder is only read. While it is missing or on another filesystem (the
 * drive is unplugged) the unit stops checking in, so the workspace shows the
 * share offline with its catalog intact, and resumes when the folder is back.
 */
export class ShareRuntime {
    #share;
    #hub;
    #identity;
    #logger;
    #transport;
    #refresh;
    #source = null;
    #stopped = false;
    #abort = new AbortController();
    #loop = null;
    #notifyTimer = null;
    #rescanTimer = null;
    #reads = [];
    #reading = 0;
    #state = { connected: false, registered: false, lastError: null, lastPollAt: null, served: 0, scanned: null, listing: null, lastListedAt: null };

    // `refresh()` re-reads `{ hub, identity }` from the device's config: the
    // credentials can be replaced while the unit runs.
    constructor({ share, hub, identity, logger, refresh = null }) {
        this.#refresh = refresh;
        this.#share = share;
        this.#hub = hub;
        this.#identity = identity;
        this.#logger = logger;
        this.#transport = createTlsTransport(hub.url, hub.tls);
    }

    get id() { return this.#share.id; }
    get unit() { return 'share'; }
    get folder() { return this.#share.path; }

    get #base() { return `${this.#hub.url}${this.#hub.apiBase}/workspaces/${encodeURIComponent(this.#share.workspaceName)}/backends/share`; }

    async start() {
        this.#source = new ShareSource({
            root: this.#share.path, stateDir: this.#share.stateDir, watch: this.#share.watch !== false,
            ignored: [...new Set([...DEFAULT_SYNC_EXCLUSIONS, ...SHARE_EXCLUSIONS, ...(this.#share.exclude || [])])],
        });
        this.#source.on('error', (err) => this.#logger.warn({ share: this.id, err: err?.message }, 'share index error'));
        this.#source.on('offline', (reason) => { if (this.#state.lastError !== reason) this.#logger.warn({ share: this.id, folder: this.folder, reason }, 'share folder is not available; its files stay listed in the workspace'); this.#state.lastError = reason; });
        this.#source.on('change', () => this.#notify());
        // What the pass over the folder is doing: a line when it starts, every 500 files and when it ends; every file at debug.
        this.#source.on('walk:start', () => { this.#state.scanned = 0; this.#logger.info({ share: this.id, folder: this.folder }, 'scanning the folder'); });
        this.#source.on('file', ({ key, size, scanned }) => { this.#state.scanned = scanned; this.#logger.debug({ share: this.id, key, size }, 'scanned'); });
        this.#source.on('progress', ({ scanned }) => this.#logger.info({ share: this.id, scanned }, 'scanning'));
        this.#source.on('walk:done', ({ count, complete, ms }) => { this.#state.scanned = null; this.#logger.info({ share: this.id, files: count, complete, seconds: Math.round(ms / 100) / 10 }, 'scan finished'); });
        await this.#source.start();
        this.#rescanTimer = setInterval(() => { void this.#source?.rescan(); }, RESCAN_EVERY_MS);
        this.#rescanTimer.unref?.();
        this.#loop = this.#run();
        this.#logger.info({ share: this.id, folder: this.folder, name: this.#share.name, watch: this.#share.watch !== false }, 'share started');
    }

    async stop() {
        this.#stopped = true;
        clearInterval(this.#rescanTimer);
        clearTimeout(this.#notifyTimer);
        this.#abort.abort();
        this.#reads = [];
        await this.#loop?.catch(() => {});
        // Tell the workspace now; otherwise it only learns from the silence, seconds later.
        if (this.#state.connected) {
            await this.#transport.fetch(`${this.#base}/${encodeURIComponent(this.#share.name)}/poll`, {
                method: 'DELETE', headers: { authorization: `Bearer ${this.#hub.token}` }, signal: AbortSignal.timeout(3000),
            }).catch(() => {});
        }
        await this.#source?.stop().catch(() => {});
        this.#source = null;
        await this.#transport.dispose();
    }

    status() {
        const described = this.#source?.describe() || null;
        return {
            id: this.id, unit: 'share', workspace: this.#share.workspaceName, hub: this.#hub.id,
            name: this.#share.name, label: this.#share.label || this.#share.name, folder: this.folder, stateDir: this.#share.stateDir,
            watch: this.#share.watch !== false,
            // `available`: the folder is there and is the filesystem that was indexed.
            available: !!described, connected: this.#state.connected, registered: this.#state.registered,
            scanning: this.#source?.scanning === true, scanned: this.#state.scanned, files: described?.files ?? null, head: described?.head ?? null,
            // The workspace reading this share's index: files handed over so far, null when it is not listing.
            listing: this.#state.listing, lastListedAt: this.#state.lastListedAt,
            served: this.#state.served, reading: this.#reading, queued: this.#reads.length, lastPollAt: this.#state.lastPollAt, lastError: this.#state.lastError,
            state: !described ? 'unavailable' : !this.#state.connected ? 'offline' : this.#source.scanning ? 'scanning' : 'serving',
        };
    }

    /** Walk and hash the folder again now. */
    async resync() { return this.#source?.rescan(); }
    nudge() { this.#notify(); }

    async #post(suffix, { json, bytes, signal } = {}) {
        const res = await this.#transport.fetch(`${this.#base}${suffix}`, {
            method: 'POST', signal,
            headers: { authorization: `Bearer ${this.#hub.token}`, 'content-type': bytes ? 'application/octet-stream' : 'application/json' },
            body: bytes ?? JSON.stringify(json ?? {}),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(payload?.message || `${res.status} ${res.statusText}`), { status: res.status, code: payload?.code || null });
        return payload?.payload ?? null;
    }

    async #register() {
        await this.#post('', { json: { name: this.#share.name, label: this.#share.label || this.#share.name, watch: this.#share.watch !== false, mode: this.#share.mode || 'ro' }, signal: this.#abort.signal });
        this.#state.registered = true;
    }

    #describe() {
        const described = this.#source?.describe();
        return described ? { ...described, device: { id: this.#identity.deviceId, name: this.#identity.deviceName }, version: `canvas-edge/${VERSION}` } : null;
    }

    async #run() {
        let backoff = 1000;
        while (!this.#stopped) {
            try {
                const source = this.#describe();
                if (!source) {
                    this.#state.connected = false;
                    await sleep(FOLDER_RETRY_MS, null, { signal: this.#abort.signal });
                    // Back again (the drive was plugged in): pick up what changed meanwhile.
                    if (this.#source?.liveness({ fresh: true }).ok) {
                        this.#logger.info({ share: this.id, folder: this.folder }, 'share folder is available again; rescanning');
                        this.#state.lastError = null;
                        void this.#source.rescan();
                    }
                    continue;
                }
                if (!this.#state.registered) await this.#register();
                // The first check-in of a connection returns at once: the unit is connected from then on, not a long poll later.
                const { requests = [] } = await this.#post(`/${encodeURIComponent(this.#share.name)}/poll`, { json: { source, wait: this.#state.connected ? POLL_WAIT_MS : 0 }, signal: this.#abort.signal }) || {};
                if (!this.#state.connected) this.#logger.info({ share: this.id }, 'share connected to the workspace');
                this.#state.connected = true;
                this.#state.lastError = null;
                this.#state.lastPollAt = new Date().toISOString();
                backoff = 1000;
                this.#accept(requests);
            } catch (err) {
                if (this.#stopped) break;
                this.#state.connected = false;
                if (err.status === 401) {
                    const fresh = this.#refresh?.();
                    if (fresh?.hub?.token && fresh.hub.token !== this.#hub.token) {
                        this.#hub = fresh.hub;
                        this.#identity = fresh.identity;
                        this.#state.registered = false;
                        this.#logger.info({ share: this.id }, 'hub credentials changed; checking in again');
                        continue;
                    }
                }
                this.#state.lastError = err.status === 401
                    ? `the hub rejected this device's token (${err.message}); \`canvas workspace ${this.#share.workspaceName} share add\` or \`canvas remote device register\` on this machine issues a new one`
                    : err.status === 404
                    ? `"${this.#share.name}" is not a share of workspace ${this.#share.workspaceName} any more; \`canvas workspace ${this.#share.workspaceName} share remove ${this.#share.name}\` stops serving it, restarting the daemon registers it again`
                    : err.message;
                // Refused for good until someone acts: do not hammer the hub.
                const settled = err.status === 404 || err.status === 409 || err.status === 400 || err.status === 403;
                this.#logger.warn({ share: this.id, err: this.#state.lastError }, 'share check-in failed');
                await sleep(settled ? 60_000 : backoff, null, { signal: this.#abort.signal }).catch(() => {});
                backoff = Math.min(backoff * 2, 30_000);
            }
        }
    }

    // Listings and other small answers go out at once; reads queue behind MAX_READS.
    #accept(requests) {
        const at = Date.now();
        for (const request of requests) {
            if (request.op !== 'read') void this.#answer(request);
            else if (this.#reads.length < MAX_QUEUED_READS) this.#reads.push({ request, at });
            else void this.#refuse(request);
        }
        this.#drain();
    }

    async #refuse(request) {
        await this.#post(`/${encodeURIComponent(this.#share.name)}/requests/${encodeURIComponent(request.id)}`, {
            json: { error: 'The share is busy reading; try again', code: 'BUSY' }, signal: this.#abort.signal,
        }).catch(() => {});
    }

    #drain() {
        while (this.#reading < MAX_READS && this.#reads.length) {
            const { request, at } = this.#reads.shift();
            if (Date.now() - at > READ_TTL_MS) continue;
            this.#reading += 1;
            void this.#answer(request).finally(() => { this.#reading -= 1; this.#drain(); });
        }
    }

    async #answer(request) {
        const suffix = `/${encodeURIComponent(this.#share.name)}/requests/${encodeURIComponent(request.id)}`;
        try {
            let answer;
            try {
                const result = await this.#source.handle(request);
                this.#report(request, result);
                if (result.stream) {
                    const chunks = [];
                    for await (const chunk of result.stream) chunks.push(chunk);
                    answer = { bytes: Buffer.concat(chunks) };
                } else answer = { json: { body: result.body } };
            } catch (err) {
                answer = { json: { error: err.message, code: err.code || 'SOURCE_ERROR' } };
            }
            await this.#post(suffix, { ...answer, signal: this.#abort.signal });
            this.#state.served += 1;
        } catch (err) {
            if (!this.#stopped) this.#logger.warn({ share: this.id, op: request.op, err: err.message }, 'share answer was not delivered');
        }
    }

    // What the workspace asked for: its listing of the index at info (start,
    // every 5000 files, end), every single request at debug.
    #report(request, result) {
        this.#logger.debug({ share: this.id, op: request.op, ...(request.key != null ? { key: request.key } : {}), ...(request.start != null ? { start: request.start, end: request.end } : {}), ...(request.since != null ? { since: request.since } : {}) }, 'request');
        if (request.op === 'changes' && result.body?.changes?.length) this.#logger.info({ share: this.id, changes: result.body.changes.length }, 'workspace took changes');
        if (request.op !== 'list') return;
        if (request.after == null) { this.#state.listing = 0; this.#logger.info({ share: this.id }, 'workspace is listing the share'); }
        const before = this.#state.listing ?? 0;
        this.#state.listing = before + (result.body?.objects?.length || 0);
        if (result.body?.cursor == null) {
            this.#logger.info({ share: this.id, files: this.#state.listing }, 'workspace listed the share; it now indexes what is new to it');
            this.#state.listing = null;
            this.#state.lastListedAt = new Date().toISOString();
        } else if (Math.floor(this.#state.listing / 5000) > Math.floor(before / 5000)) {
            this.#logger.info({ share: this.id, files: this.#state.listing }, 'workspace is listing the share');
        }
    }

    // The index moved on: tell the workspace now instead of at the next poll.
    // A zero-wait check-in does not disturb the long poll in flight.
    #notify() {
        if (this.#notifyTimer || this.#stopped || !this.#state.connected) return;
        this.#notifyTimer = setTimeout(async () => {
            this.#notifyTimer = null;
            const source = this.#describe();
            if (!source || this.#stopped) return;
            try {
                const { requests = [] } = await this.#post(`/${encodeURIComponent(this.#share.name)}/poll`, { json: { source, wait: 0 }, signal: this.#abort.signal }) || {};
                this.#accept(requests);
            } catch { /* the long poll reports failures */ }
        }, NOTIFY_DEBOUNCE_MS);
        this.#notifyTimer.unref?.();
    }
}
