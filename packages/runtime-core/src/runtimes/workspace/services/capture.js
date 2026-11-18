import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaults = { enabled: false, url: '', timeoutMs: 120000, maxBytes: 32 * 1024 ** 2 };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function getCaptureConfig(workspace) {
    const config = workspace.services.captured || {};
    return Object.fromEntries([...Object.entries(defaults).map(([key, value]) => [key, config[key] ?? value]), ['tokenSet', Boolean(config.token)]]);
}

export async function saveCaptureConfig(workspace, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Capture configuration must be an object');
    for (const key of Object.keys(input)) {
        if (![...Object.keys(defaults), 'token'].includes(key)) throw fail(`Unknown argument ${key}; allowed arguments: enabled, url, token, timeoutMs, maxBytes`);
    }
    const previous = workspace.services.captured || {};
    const config = { ...defaults, ...previous, ...input };
    if (typeof config.enabled !== 'boolean') throw fail('enabled must be a boolean');
    if (typeof config.url !== 'string') throw fail('url must be an HTTP or HTTPS service origin');
    config.url = config.url.trim();
    if (config.url) {
        let url;
        try { url = new URL(config.url); } catch { throw fail('url must be an HTTP or HTTPS service origin'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw fail('url must be an HTTP or HTTPS service origin without credentials, path, query or fragment');
        }
        config.url = url.origin;
    }
    if (Object.hasOwn(input, 'token')) {
        if (typeof input.token !== 'string' || (input.token && !/^[A-Za-z0-9_-]{32,256}$/.test(input.token))) {
            throw fail('token must be a 32–256 character base64url service token, or empty to remove it');
        }
    } else if (config.url !== (previous.url || '') && previous.token) {
        throw fail('Enter the service token again when changing the capture URL');
    }
    for (const [key, min, max] of [['timeoutMs', 1000, 300000], ['maxBytes', 1024, 128 * 1024 ** 2]]) {
        if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
    }
    if (config.enabled && (!config.url || !config.token)) throw fail('Enabling website capture requires url and token');
    await workspace.setServiceConfig('captured', config);
    return getCaptureConfig(workspace);
}

async function credentials(workspace) {
    const config = getCaptureConfig(workspace);
    if (!config.enabled || !config.url || !config.tokenSet) throw fail('Configure Website capture in Workspace settings → Connected services first');
    return { ...config, token: (await workspace.resolveIntegrationConfig(workspace.services.captured)).token };
}

async function request(config, route, options) {
    try {
        return await fetch(`${config.url}${route}`, {
            ...options, redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        });
    } catch {
        if (options.signal?.aborted) throw fail('Website capture timed out or was cancelled', 504);
        throw fail('Cannot reach the capture service. Check the workspace URL and network access from the workspace runtime.', 502);
    }
}

async function readBody(response, maxBytes) {
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw fail('Capture response exceeds the configured size limit', 502);
            chunks.push(value);
        }
        return Buffer.concat(chunks, size);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function serviceError(status, error) {
    // Format structured fields locally; never copy arbitrary upstream content into rule logs.
    if (status === 502 && error?.code === 'target_http_error') {
        const targetStatus = error.targetStatus;
        const detail = Number.isInteger(targetStatus) && targetStatus >= 100 && targetStatus <= 599 ? ` (HTTP ${targetStatus})` : '';
        const hint = targetStatus === 401 || targetStatus === 403
            ? ' The site may require login or reject automated browsers.'
            : targetStatus === 429 ? ' The site is rate-limiting requests; retry later.' : '';
        return fail(`Target website did not return a successful page${detail}; capture error: target_http_error.${hint}`, 502);
    }
    const captureMessages = {
        invalid_capture_metadata: 'The capture browser did not report a valid target HTTP status.',
        invalid_capture: 'The capture service did not produce a valid HTML document.',
        dns_failed: 'The capture service could not resolve the target host.',
        blocked_target: 'The capture service blocked the target; only public HTTP(S) websites are allowed.',
        capture_failed: 'The capture browser failed; check service readiness and target availability.',
    };
    if (Object.hasOwn(captureMessages, error?.code || '')) return fail(captureMessages[error.code], 502);
    const messages = {
        400: 'Capture service rejected the URL or limits. Check that workspace limits do not exceed the service limits.',
        401: 'Capture service rejected the token. Update it in this workspace’s Connected services settings.',
        413: 'Captured page exceeds the size limit.',
        429: 'Capture service is busy. Retry later.',
        504: 'Capture service timed out.',
    };
    return fail(messages[status] || `Capture service failed (HTTP ${status})`, status === 429 ? 429 : 502);
}

async function responseError(response) {
    let error;
    try {
        if (response.headers.get('content-type')?.split(';')[0].trim() === 'application/json') {
            error = JSON.parse(await readBody(response, 16384)).error;
        } else await response.body?.cancel();
    } catch { /* Malformed or oversized error bodies use the HTTP status message. */ }
    return serviceError(response.status, error);
}

export async function checkCaptureService(workspace) {
    const config = await credentials(workspace);
    const signal = AbortSignal.timeout(10000);
    const health = await request(config, '/healthz', { signal });
    if (!health.ok) throw await responseError(health);
    let data;
    try { data = JSON.parse(await readBody(health, 16384)); } catch { throw fail('Capture service returned an invalid health response', 502); }
    if (data.status !== 'ok' || data.api?.major !== 1) throw fail('Capture service does not support capture API v1', 502);
    // An empty request verifies auth without launching Chromium or fetching a website.
    const probe = await request(config, '/v1/captures', { method: 'POST', body: '{}', signal });
    const body = await readBody(probe, 16384);
    let code;
    try { code = JSON.parse(body).error?.code; } catch { /* Reject unexpected responses below. */ }
    if (!((probe.status === 400 && code === 'invalid_url') || (probe.status === 429 && code === 'busy'))) throw serviceError(probe.status);
    return { message: 'Capture service reachable; token accepted.' };
}

export async function capturePage(workspace, url, { workDir, fallbackBase = 'page', timeoutMs, maxBytes, signal, metadata } = {}) {
    const config = await credentials(workspace);
    const limit = Math.min(maxBytes ?? config.maxBytes, config.maxBytes);
    const timeout = Math.min(timeoutMs ?? config.timeoutMs, config.timeoutMs);
    const deadline = AbortSignal.timeout(timeout + 5000);
    const response = await request(config, '/v1/captures', {
        method: 'POST', body: JSON.stringify({ url, timeoutMs: timeout, maxBytes: limit }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) throw await responseError(response);
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'text/html') {
        await response.body?.cancel(); throw fail('Capture service did not return HTML', 502);
    }
    const html = await readBody(response, limit);
    const sha256 = createHash('sha256').update(html).digest('hex');
    if (!html.length || response.headers.get('x-capture-sha256') !== sha256) throw fail('Capture HTML failed its checksum check', 502);
    const file = path.join(workDir, `${path.basename(fallbackBase)}.html`);
    await writeFile(file, html, { flag: 'wx', mode: 0o600 });
    if (metadata) metadata.capture = {
        finalUrl: response.headers.get('x-capture-final-url'), capturedAt: response.headers.get('x-capture-time'),
        engine: response.headers.get('x-capture-engine'), sha256,
    };
    return file;
}
