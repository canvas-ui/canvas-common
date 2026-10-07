'use strict';

import { createTlsTransport, resolveTls } from '@augmentd-labs/canvas-api-client/tls';
import { io } from 'socket.io-client';
import { PassThrough } from 'node:stream';

const CHUNK_SIZE = 256 * 1024;

/**
 * canvas-edge tunnel client.
 *
 * Dials out to a canvas-server instance, announces what this runtime hosts,
 * and replays proxied requests into the local fastify app (`app.inject()`),
 * so the tunnel and localhost serve identical APIs by construction.
 * Reconnection/backoff and heartbeat come from socket.io.
 *
 * See docs/canvas-edge-protocol.md for the frame protocol.
 */
export default class EdgeClient {
    #transport;
    #serverUrl;
    #token;
    #localApp;
    #announce;
    #socket = null;
    #announced = false;
    #forwarded = [];
    #requests = new Map();
    #localUrl;
    #localToken;
    #status = { connected: false, registered: false, error: null };
    get status() { return { ...this.#status }; }

    constructor({ serverUrl, token, localApp, localUrl, localToken, announce, tls }) {
        if (!serverUrl || !token || (!localApp?.inject && !localUrl) || !announce?.instanceId) {
            throw new Error('EdgeClient requires serverUrl, token, localApp (fastify) and announce.instanceId');
        }
        this.#transport = createTlsTransport(serverUrl, resolveTls(tls));
        this.#serverUrl = serverUrl.replace(/\/+$/, '');
        this.#token = token;
        this.#localApp = localApp;
        this.#localUrl = localUrl;
        this.#localToken = localToken;
        this.#announce = announce;
    }

    /**
   * One-time pairing: exchange a user API token for a device token via the
   * existing device registration endpoint. Persist the result locally and
   * never touch the user token again.
   */
    static async pair({ serverUrl, userToken, name, type = 'edge', tls, ...deviceInfo }) {
        const transport = createTlsTransport(serverUrl, resolveTls(tls));
        try {
            const res = await transport.fetch(`${serverUrl.replace(/\/+$/, '')}/rest/v2/auth/devices/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
                body: JSON.stringify({ name, type, ...deviceInfo }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.payload?.token) {
                throw new Error(`Edge pairing failed: ${json?.message || res.statusText}`);
            }
            return { token: json.payload.token, deviceId: json.payload.deviceId || json.payload.id };
        } finally { await transport.dispose(); }
    }

    get connected() {
        return this.#socket?.connected === true;
    }

    connect() {
        if (this.#socket) return this;
        this.#socket = io(this.#serverUrl, {
            ...this.#transport.socketOptions,
            auth: { token: this.#token },
            transports: this.#transport.socketOptions.transports || ['websocket'],
        });
        // Announce on every (re)connect — announce is idempotent full state.
        this.#socket.on('connect', () => { this.#status = { connected: true, registered: false, error: null }; this.#socket.emit('edge:announce', this.#announce); });
        this.#socket.on('edge:announced', () => { this.#announced = true; this.#status.registered = true; });
        this.#socket.on('disconnect', () => {
            this.#announced = false; this.#status.connected = false; this.#status.registered = false;
            for (const request of this.#requests.values()) request.controller.abort();
        });
        this.#socket.on('connect_error', err => { this.#status.error = err.message; });
        this.#socket.on('edge:err', err => { if (!err.id) this.#status.error = err.message; });
        this.#socket.on('edge:abort', ({ id } = {}) => this.#requests.get(id)?.controller.abort());
        this.#socket.on('edge:upload', ({ id, seq, data } = {}, ack = () => {}) => {
            const request = this.#requests.get(id);
            if (!request?.upload || seq !== request.seq++ || typeof data !== 'string' || data.length > 360_000) {
                ack({ error: 'Invalid upload' }); request?.controller.abort(); return;
            }
            request.upload.write(Buffer.from(data, 'base64'), () => ack({ ok: true }));
        });
        this.#socket.on('edge:upload:end', ({ id } = {}) => this.#requests.get(id)?.upload?.end());
        this.#socket.on('edge:req', (frame) => this.handleRequest(frame));
        return this;
    }

    /** Resolves once the server has acked the announce; rejects on timeout. */
    waitForAnnounce(timeoutMs = 10_000) {
        if (this.#announced) return Promise.resolve();
        if (!this.#socket) return Promise.reject(new Error('not connected — call connect() first'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#socket?.off('edge:announced', onAck);
                reject(new Error(`edge announce not acked within ${timeoutMs}ms`));
            }, timeoutMs);
            const onAck = () => { clearTimeout(timer); resolve(); };
            this.#socket.once('edge:announced', onAck);
        });
    }

    /**
   * Dispatch a proxied request into the local app and stream the answer back.
   * `socket` is injectable for tests.
   */
    async handleRequest(frame = {}, socket = this.#socket) {
        if (frame.protocol === 2 && this.#localUrl) return this.#handleStream(frame, socket);
        const { id, method, path, headers = {}, body, bodyEncoding } = frame;
        if (!id || !method || !path) return;
        try {
            const payload = body == null
                ? undefined
                : (bodyEncoding === 'base64' ? Buffer.from(body, 'base64') : body);
            const res = await this.#localApp.inject({ method, url: path, headers, payload });
            socket.emit('edge:res', { id, status: res.statusCode, headers: res.headers });
            const buf = res.rawPayload;
            for (let offset = 0, seq = 0; offset < buf.length; offset += CHUNK_SIZE, seq++) {
                socket.emit('edge:chunk', { id, seq, data: buf.subarray(offset, offset + CHUNK_SIZE).toString('base64') });
            }
            socket.emit('edge:end', { id });
        } catch (err) {
            socket.emit('edge:err', { id, code: 'EDGE_DISPATCH_FAILED', message: err.message });
        }
    }

    async #handleStream(frame, socket) {
        const { id, method, path, context } = frame;
        const controller = new AbortController();
        const upload = frame.upload ? new PassThrough({ highWaterMark: CHUNK_SIZE }) : null;
        upload?.on('error', () => {});
        this.#requests.set(id, { controller, upload, seq: 0 });
        const abortUpload = () => upload?.destroy(new Error('Cancelled'));
        controller.signal.addEventListener('abort', abortUpload, { once: true });
        try {
            const target = new URL(path, this.#localUrl);
            const base = new URL(this.#localUrl);
            if (target.origin !== base.origin || !path.startsWith('/rest/v2/')) throw new Error('Invalid tunnel target');
            // Context is delivered only by the authenticated tunnel. The private token is never sent to the hub.
            const exports = this.#announce.exports || [];
            const resource = exports.find(e => e.id === context?.resourceId && e.type === context?.resourceType);
            if (!resource) throw new Error('Resource is not exported by this runtime');
            const prefix = `/rest/v2/${resource.type === 'agent' ? 'agents' : 'workspaces'}/${resource.id}`;
            const allowed = target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
            if (!allowed && !(resource.type === 'workspace' && target.pathname.startsWith('/rest/v2/contexts'))) throw new Error('Resource path mismatch');
            const headers = Object.fromEntries(Object.entries(frame.headers || {}).filter(([key]) =>
                !['authorization', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'x-canvas-edge-context', 'x-canvas-device-id'].includes(key.toLowerCase())));
            headers.authorization = `Bearer ${this.#localToken}`;
            headers['x-canvas-edge-context'] = Buffer.from(JSON.stringify(context)).toString('base64url');
            const response = await fetch(target, { method, headers, body: upload || undefined,
                ...(upload ? { duplex: 'half' } : {}), signal: controller.signal, redirect: 'manual' });
            // fetch decodes compressed responses; forward the decoded representation.
            const responseHeaders = Object.fromEntries(response.headers);
            delete responseHeaders['content-encoding']; delete responseHeaders['content-length'];
            socket.emit('edge:res', { id, status: response.status, headers: responseHeaders });
            let seq = 0;
            for await (const chunk of response.body || []) {
                const bytes = Buffer.from(chunk);
                for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
                    if (controller.signal.aborted) throw new Error('Cancelled');
                    await new Promise((resolve, reject) => socket.timeout(120_000).emit('edge:chunk',
                        { id, seq: seq++, data: bytes.subarray(offset, offset + CHUNK_SIZE).toString('base64') },
                        (err, response) => err || response?.error ? reject(err || new Error(response.error)) : resolve()));
                }
            }
            socket.emit('edge:end', { id });
        } catch (err) { socket.emit('edge:err', { id, code: 'EDGE_DISPATCH_FAILED', message: err.message }); }
        finally {
            controller.abort();
            this.#requests.delete(id);
        }
    }

    /**
   * Relay all events from a local wildcard emitter (EventEmitter2) up the
   * tunnel; the server re-emits them through its WorkspaceManager.
   */
    forwardEvents(emitter) {
        const socket = () => this.#socket;
        const listener = function (payload) {
            socket()?.emit('edge:event', { name: this.event, payload });
        };
        emitter.on('**', listener);
        this.#forwarded.push([emitter, listener]);
        return this;
    }

    async publishPolicy(workspaceId, acl) {
        const resource = this.#announce.exports?.find(e => e.type === 'workspace' && e.id === workspaceId);
        if (!resource) return;
        resource.acl = acl;
        if (!this.#announced) return;
        await new Promise((resolve, reject) => this.#socket.timeout(5000).emit('edge:policy', { workspaceId, acl },
            (error, response) => error || !response?.ok ? reject(error || new Error('Policy update rejected')) : resolve()));
    }

    close() {
        for (const request of this.#requests.values()) request.controller.abort();
        void this.#transport.dispose().catch(() => {});
        for (const [emitter, listener] of this.#forwarded) emitter.off('**', listener);
        this.#forwarded = [];
        this.#socket?.disconnect();
        this.#socket = null;
    }
}
