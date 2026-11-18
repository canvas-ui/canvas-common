'use strict';

import { API_BASE, DEFAULT_TIMEOUT_MS, HEADER_APP_NAME, STATUS_ERROR, isEnvelope, routes } from '@augmentd-labs/canvas-protocol';
import { CanvasError } from './errors.js';
import { unwrap } from './unwrap.js';
import { toFetchBody } from './body.js';
import { makeAuthApi } from './api/auth.js';
import { makeWorkspacesApi } from './api/workspaces.js';
import { makeContextsApi } from './api/contexts.js';
import { makeAgentsApi } from './api/agents.js';
import { makeRolesApi } from './api/roles.js';

/**
 * Axios-parity query serialization: skip null/undefined, repeat keys for
 * arrays, String() everything else (booleans included — `recursive=false`
 * must reach the wire).
 */
function toSearchParams(params) {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const v of value) {
                if (v === undefined || v === null) continue;
                sp.append(key, String(v));
            }
        } else {
            sp.append(key, String(value));
        }
    }
    return sp;
}

/** Innermost cause that carries a string `code` — what callers match on. */
function pickCause(err) {
    let best = null;
    let cur = err;
    for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
        if (typeof cur.code === 'string') best = cur;
        if (Array.isArray(cur.errors) && cur.errors.length) {
            const coded = cur.errors.find((e) => e && typeof e.code === 'string');
            if (coded) best = coded;
        }
        cur = cur.cause;
    }
    return best;
}

export class CanvasApiClient {
    /**
     * @param {Object} options
     * @param {string} options.baseUrl e.g. 'https://canvas.example.com:8001'
     * @param {string} [options.apiBase] defaults to '/rest/v2'
     * @param {() => (string|null)} [options.getToken] called per request
     * @param {string} [options.token] static alternative to getToken
     * @param {number} [options.timeout] whole-request ms, 0 disables
     * @param {string} [options.userAgent] sent only when provided (browsers forbid it)
     * @param {string} [options.appName] sent as X-App-Name when provided
     * @param {Object} [options.headers] extra default headers
     * @param {boolean} [options.unwrap] default true. When false, SUCCESS
     *   envelopes are returned whole ({status, payload, count, ...}) instead
     *   of unwrapped to their payload — for consumers mid-migration whose
     *   call sites still dig `.payload` out themselves. Error envelopes
     *   throw either way.
     * @param {typeof fetch} [options.fetch] injectable for tests
     */
    constructor({
        baseUrl,
        apiBase = API_BASE,
        getToken,
        token,
        timeout = DEFAULT_TIMEOUT_MS,
        userAgent,
        appName,
        headers = {},
        unwrap: unwrapEnvelopes = true,
        fetch: fetchImpl
    } = {}) {
        if (!baseUrl) throw new CanvasError('baseUrl is required');
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.apiBase = apiBase;
        this.getToken = getToken || (() => token || null);
        this.timeout = timeout;
        this.userAgent = userAgent;
        this.appName = appName;
        this.defaultHeaders = headers;
        this.unwrapEnvelopes = unwrapEnvelopes;
        this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));

        this.auth = makeAuthApi(this);
        this.workspaces = makeWorkspacesApi(this);
        this.contexts = makeContextsApi(this);
        this.agents = makeAgentsApi(this);
        this.roles = makeRolesApi(this);
    }

    /**
     * @param {string} method
     * @param {string} path route relative to apiBase (see @augmentd-labs/canvas-protocol routes)
     * @param {Object} [options]
     * @param {Object} [options.params] query parameters
     * @param {*} [options.data] request body (object → JSON; Buffer/Blob/stream pass through)
     * @param {Object} [options.headers]
     * @param {number} [options.timeout] overrides the client default; 0 disables
     * @param {AbortSignal} [options.signal]
     * @param {boolean} [options.envelope] return the whole success envelope for this
     *   request: a list's `count` and `totalCount` live next to its `payload`
     * @returns {Promise<*>} unwrapped envelope payload (or raw body for non-envelope responses)
     * @throws {CanvasError}
     */
    async request(method, path, { params, data, headers, timeout, signal, envelope = false } = {}) {
        const url = new URL(this.baseUrl + this.apiBase + path);
        const search = toSearchParams(params);
        for (const [k, v] of search) url.searchParams.append(k, v);

        const { body, duplex, isJson } = toFetchBody(data);

        const reqHeaders = { ...this.defaultHeaders, ...(headers || {}) };
        const hasHeader = (name) => Object.keys(reqHeaders).some((h) => h.toLowerCase() === name);
        if (isJson && !hasHeader('content-type')) reqHeaders['Content-Type'] = 'application/json';
        if (this.userAgent && !hasHeader('user-agent')) reqHeaders['User-Agent'] = this.userAgent;
        if (this.appName && !hasHeader(HEADER_APP_NAME.toLowerCase())) reqHeaders[HEADER_APP_NAME] = this.appName;
        const token = this.getToken();
        if (token && !hasHeader('authorization')) reqHeaders.Authorization = `Bearer ${token}`;

        const timeoutMs = timeout ?? this.timeout;
        const signals = [];
        if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
        if (signal) signals.push(signal);
        const finalSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

        let res;
        try {
            res = await this._fetch(url, {
                method,
                headers: reqHeaders,
                ...(body !== undefined ? { body } : {}),
                ...(duplex ? { duplex } : {}),
                ...(finalSignal ? { signal: finalSignal } : {})
            });
        } catch (err) {
            if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') {
                throw new CanvasError(`Request timed out after ${timeoutMs}ms`, { code: 'TIMEOUT', cause: err });
            }
            if (err?.name === 'AbortError') {
                throw new CanvasError('Request aborted', { code: 'ABORTED', cause: err });
            }
            // undici wraps connection failures as TypeError('fetch failed',
            // {cause}); Bun throws coded errors directly. Surface the innermost
            // coded cause so callers can keep matching err.cause.code.
            const cause = pickCause(err) || err.cause || err;
            throw new CanvasError(cause?.message || err.message || 'Request failed', { cause });
        }

        const parsed = await this._parseBody(res);
        // Envelopes are authoritative regardless of HTTP status — error
        // envelopes carry the real code/message even on HTTP 200, and
        // unwrap() throws for those. Success envelopes come back whole when
        // the client was built with unwrap: false.
        if (isEnvelope(parsed)) {
            if (parsed.status === STATUS_ERROR) return unwrap(parsed);
            return this.unwrapEnvelopes && !envelope ? unwrap(parsed) : parsed;
        }
        if (res.ok) return parsed;
        const message =
            (parsed && typeof parsed === 'object' && parsed.message) ||
            (typeof parsed === 'string' && parsed.trim() ? parsed.trim().slice(0, 200) : '') ||
            `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        throw new CanvasError(message, { statusCode: res.status, status: res.status });
    }

    async _parseBody(res) {
        if (res.status === 204) return null;
        const contentType = res.headers.get('content-type') || '';
        const text = await res.text();
        if (!text) return null;
        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(text);
            } catch (err) {
                throw new CanvasError('Invalid JSON in response', {
                    statusCode: res.status,
                    status: res.status,
                    cause: err
                });
            }
        }
        return text;
    }

    get(path, opts) {
        return this.request('GET', path, opts);
    }
    post(path, data, opts) {
        return this.request('POST', path, { ...opts, data: data ?? {} });
    }
    put(path, data, opts) {
        return this.request('PUT', path, { ...opts, data: data ?? {} });
    }
    patch(path, data, opts) {
        return this.request('PATCH', path, { ...opts, data: data ?? {} });
    }
    delete(path, opts) {
        return this.request('DELETE', path, opts);
    }

    ping() {
        return this.get(routes.ping());
    }
}
