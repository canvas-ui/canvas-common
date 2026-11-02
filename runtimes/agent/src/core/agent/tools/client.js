'use strict';

/*
 * CanvasApiClient — minimal REST client for agent canvas tools.
 *
 * Deliberately speaks the public REST API with the agent's own token instead
 * of importing core services: the exact same ACL middleware + binding clamp
 * that guard external clients guard agent tool calls, and under canvas-edge
 * the code runs unmodified against a remote server (CANVAS_URL flips).
 */

export class CanvasApiClient {
    #baseUrl;
    #token;

    /**
     * @param {Object} env - agent runtime env (see runtime-env.js)
     * @param {string} env.CANVAS_URL   - REST base url, e.g. http://127.0.0.1:8001/rest/v2
     * @param {string} env.CANVAS_TOKEN - canvas-agent-* token
     */
    constructor(env = {}) {
        if (!env.CANVAS_URL || !env.CANVAS_TOKEN) {
            throw new Error('CanvasApiClient requires CANVAS_URL and CANVAS_TOKEN');
        }
        this.#baseUrl = String(env.CANVAS_URL).replace(/\/+$/, '');
        this.#token = env.CANVAS_TOKEN;
    }

    /**
     * @param {string} method
     * @param {string} pathname - path under the REST base, e.g. /workspaces/<id>/documents
     * @param {Object} [options]
     * @param {Object} [options.query] - query params; array values repeat the key
     * @param {Object} [options.body]
     * @param {'content'} [options.responseType] Return MIME plus bounded text/base64 bytes.
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<Object>} parsed ResponseObject envelope ({ status, statusCode, message, payload, count, totalCount })
     */
    async request(method, pathname, { query, body, signal, responseType } = {}) {
        const url = new URL(`${this.#baseUrl}${pathname}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value === undefined || value === null || value === '') continue;
            if (Array.isArray(value)) {
                for (const entry of value) url.searchParams.append(key, entry);
            } else {
                url.searchParams.set(key, value);
            }
        }

        const response = await fetch(url, {
            method,
            signal,
            headers: {
                Authorization: `Bearer ${this.#token}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });

        if (response.ok && responseType === 'content') {
            const type = response.headers.get('content-type') || 'application/octet-stream';
            const reader = response.body?.getReader();
            const chunks = [];
            let size = 0;
            if (reader) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.byteLength;
                        if (size > 1024 * 1024) throw new Error('Content exceeds the 1 MiB tool limit; retrieve it through the authenticated REST content endpoint.');
                        chunks.push(Buffer.from(value));
                    }
                } catch (error) { await reader.cancel(); throw error; }
                finally { reader.releaseLock(); }
            }
            const bytes = Buffer.concat(chunks);
            return { contentType: type, size: bytes.length,
                ...(type.startsWith('text/') || type.includes('json') ? { text: bytes.toString('utf8') } : { bodyBase64: bytes.toString('base64') }) };
        }
        let envelope = null;
        try {
            envelope = await response.json();
        } catch {
            // Non-JSON error body; fall through to the status check below.
        }

        if (!response.ok) {
            const message = envelope?.message || `HTTP ${response.status}`;
            const error = new Error(message);
            error.statusCode = response.status;
            error.payload = envelope?.payload;
            Object.assign(error, { code: envelope?.code, retryable: envelope?.retryable,
                reason: envelope?.reason, stoppedAt: envelope?.stoppedAt, hint: envelope?.hint });
            throw error;
        }

        return envelope || {};
    }

    get(pathname, options) { return this.request('GET', pathname, options); }
    post(pathname, options) { return this.request('POST', pathname, options); }
}
