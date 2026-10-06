/** Native-only TLS transport. Never import this entry point into a browser bundle. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { Agent } from 'undici';
import { Agent as HttpsAgent } from 'node:https';
import { NodeWebSocket } from 'engine.io-client';

export class ClientTlsError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'ClientTlsError';
        this.code = 'CLIENT_TLS_CONFIG';
    }
}

export function normalizeTls(tls) {
    if (tls == null) return undefined;
    if (typeof tls.certFile !== 'string' || !tls.certFile || typeof tls.keyFile !== 'string' || !tls.keyFile) {
        throw new ClientTlsError('Provide both --tls-cert and --tls-key (unencrypted PEM files)');
    }
    return { certFile: resolve(tls.certFile), keyFile: resolve(tls.keyFile) };
}

export function resolveTls(tls, env = process.env) {
    if (env.CANVAS_TLS_CERT || env.CANVAS_TLS_KEY) {
        return normalizeTls({ certFile: env.CANVAS_TLS_CERT, keyFile: env.CANVAS_TLS_KEY });
    }
    return normalizeTls(tls);
}

export function loadTls(baseUrl, config) {
    const tls = normalizeTls(config);
    if (!tls) return undefined;
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new ClientTlsError('Client certificates require an HTTPS remote without URL credentials');
    }
    try {
        const cert = readFileSync(tls.certFile, 'utf8');
        const sourceKey = readFileSync(tls.keyFile, 'utf8');
        if (/ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(sourceKey)) {
            throw new Error('Encrypted private keys are unsupported; use a protected unencrypted PEM key');
        }
        const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (!blocks?.length) throw new Error('Certificate file must contain a PEM certificate chain');
        const chain = blocks.map(pem => new X509Certificate(pem));
        const key = createPrivateKey(sourceKey);
        if (!chain[0].checkPrivateKey(key)) throw new Error('Certificate and private key do not match');
        const now = Date.now();
        for (let i = 0; i < chain.length; i++) {
            if (now < Date.parse(chain[i].validFrom) || now >= Date.parse(chain[i].validTo)) {
                throw new Error('Certificate chain contains an expired or not-yet-valid certificate');
            }
            if (i + 1 < chain.length && !chain[i].verify(chain[i + 1].publicKey)) {
                throw new Error('Certificate chain must be ordered leaf first, then issuing intermediates');
            }
        }
        return { ...tls, origin: url.origin, cert: blocks.join('\n'),
            key: key.export({ type: 'pkcs8', format: 'pem' }), fingerprint: chain[0].fingerprint256 };
    } catch (cause) {
        throw new ClientTlsError(`Cannot load client identity: ${cause.message}`, cause);
    }
}

export function createTlsTransport(baseUrl, config, { fetch: fetchImpl = globalThis.fetch } = {}) {
    const identity = loadTls(baseUrl, config);
    if (!identity) return { fetch: (...args) => fetchImpl(...args), socketOptions: {}, dispose: async () => {} };
    const options = { cert: identity.cert, key: identity.key, rejectUnauthorized: true };
    const agent = !globalThis.Bun ? new Agent({ connect: options }) : null;
    const socketAgent = new HttpsAgent(options);
    let disposed = false;
    return {
        socketOptions: { ...options, agent: socketAgent, transports: [NodeWebSocket] },
        async fetch(input, init) {
            if (disposed) throw new ClientTlsError('TLS transport closed; reconnect to the remote');
            let request = new Request(input, init);
            const redirect = request.redirect;
            for (let redirects = 0; redirects <= 20; redirects++) {
                if (new URL(request.url).origin !== identity.origin) {
                    throw new ClientTlsError('Refusing to send client identity or credentials to a different origin');
                }
                const response = await fetchImpl(request, {
                    redirect: 'manual', ...(agent ? { dispatcher: agent } : { tls: options }),
                });
                if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) return response;
                if (redirect === 'manual') return response;
                await response.body?.cancel();
                if (redirect === 'error') throw new ClientTlsError('Remote returned a redirect');
                const next = new URL(response.headers.get('location'), request.url);
                if (next.origin !== identity.origin || next.username || next.password) {
                    throw new ClientTlsError('Refusing a cross-origin or credential-bearing remote redirect');
                }
                const toGet = (response.status === 303 && request.method !== 'HEAD') ||
                    ([301, 302].includes(response.status) && request.method === 'POST');
                // Replaying a consumed streaming upload silently truncates data. Fail explicitly.
                if (request.body && !toGet) throw new ClientTlsError('Cannot replay an upload after a redirect; configure the final HTTPS URL');
                const headers = new Headers(request.headers);
                if (toGet) for (const name of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
                request = new Request(next, { method: toGet ? 'GET' : request.method, headers,
                    signal: request.signal, redirect, credentials: request.credentials });
            }
            throw new ClientTlsError('Too many remote redirects');
        },
        async dispose() { disposed = true; socketAgent.destroy(); await agent?.close(); },
    };
}
