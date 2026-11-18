'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasApiClient, CanvasError, isNetworkError } from '@augmentd-labs/canvas-api-client';
import { startServer, sendEnvelope } from './_helpers.js';

const mk = (baseUrl, extra = {}) =>
    new CanvasApiClient({ baseUrl, getToken: () => 'tok-123', userAgent: 'canvas-cli', ...extra });

test('headers: bearer from getToken, user-agent, x-app-name, json content-type', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: { ok: 1 } }));
    try {
        const api = mk(srv.baseUrl, { appName: 'test-app' });
        const payload = await api.post('/auth/login', { user: 'u' });
        assert.deepEqual(payload, { ok: 1 });
        const r = srv.requests[0];
        assert.equal(r.headers.authorization, 'Bearer tok-123');
        assert.equal(r.headers['user-agent'], 'canvas-cli');
        assert.equal(r.headers['x-app-name'], 'test-app');
        assert.equal(r.headers['content-type'], 'application/json');
        assert.equal(r.url, '/rest/v2/auth/login');
    } finally {
        await srv.close();
    }
});

test('no token → no Authorization header; GET carries no content-type', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: [] }));
    try {
        const api = new CanvasApiClient({ baseUrl: srv.baseUrl, getToken: () => null });
        await api.get('/workspaces');
        const r = srv.requests[0];
        assert.equal(r.headers.authorization, undefined);
        assert.equal(r.headers['content-type'], undefined);
    } finally {
        await srv.close();
    }
});

test('query serialization: booleans kept, null/undefined skipped, arrays repeat', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: null }));
    try {
        const api = mk(srv.baseUrl);
        await api.get('/workspaces/w1/documents', {
            params: { recursive: false, purge: undefined, tag: ['a', 'b'], limit: 10, cursor: null }
        });
        const url = new URL(srv.baseUrl + srv.requests[0].url);
        assert.equal(url.searchParams.get('recursive'), 'false');
        assert.equal(url.searchParams.has('purge'), false);
        assert.equal(url.searchParams.has('cursor'), false);
        assert.deepEqual(url.searchParams.getAll('tag'), ['a', 'b']);
        assert.equal(url.searchParams.get('limit'), '10');
    } finally {
        await srv.close();
    }
});

test('removeTreePath end-to-end: encoded treeName, raw path, recursive=false on the wire', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: true }));
    try {
        const api = mk(srv.baseUrl);
        await api.workspaces.removeTreePath('w1', 'my tree', '/a/b', {});
        const r = srv.requests[0];
        assert.equal(r.method, 'DELETE');
        assert.ok(r.url.startsWith('/rest/v2/workspaces/w1/trees/my%20tree/path/a/b?'), r.url);
        assert.ok(r.url.includes('recursive=false'), r.url);
        assert.ok(!r.url.includes('purge'), r.url);
    } finally {
        await srv.close();
    }
});

test('envelope:true on one request returns its whole envelope: a list total next to the payload', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: [1], count: 1, totalCount: 7163 }));
    try {
        const api = new CanvasApiClient({ baseUrl: srv.baseUrl, token: 't' });
        assert.deepEqual(await api.get('/workspaces'), [1]);
        const whole = await api.get('/workspaces', { envelope: true });
        assert.deepEqual([whole.payload, whole.totalCount], [[1], 7163]);
    } finally {
        await srv.close();
    }
});

test('unwrap:false returns whole success envelopes, still throws on error envelopes', async () => {
    let n = 0;
    const srv = await startServer((req, res) => {
        if (n++ === 0) {
            sendEnvelope(res, { payload: [1, 2], count: 2, message: 'listed' });
        } else {
            sendEnvelope(res, { status: 'error', statusCode: 409, message: 'nope', code: 'WORKSPACE_NOT_ACTIVE' });
        }
    });
    try {
        const api = new CanvasApiClient({ baseUrl: srv.baseUrl, token: 't', unwrap: false });
        const envelope = await api.get('/workspaces');
        assert.equal(envelope.status, 'success');
        assert.deepEqual(envelope.payload, [1, 2]);
        assert.equal(envelope.count, 2);
        assert.equal(envelope.message, 'listed');
        const err = await api.get('/workspaces/w1').then(
            () => assert.fail('should throw'),
            (e) => e
        );
        assert.equal(err.code, 'WORKSPACE_NOT_ACTIVE');
        assert.equal(err.statusCode, 409);
    } finally {
        await srv.close();
    }
});

test('contexts.setUrl posts {url} to /contexts/:id/url', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: { url: 'ctx://x' } }));
    try {
        const api = mk(srv.baseUrl);
        await api.contexts.setUrl('c1', 'ctx://foo/bar');
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/rest/v2/contexts/c1/url');
        assert.deepEqual(JSON.parse(r.body.toString()), { url: 'ctx://foo/bar' });
    } finally {
        await srv.close();
    }
});

test('auth.login merges strategy:auto', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: { token: 't' } }));
    try {
        const api = mk(srv.baseUrl);
        await api.auth.login({ email: 'e', password: 'p' });
        assert.deepEqual(JSON.parse(srv.requests[0].body.toString()), {
            strategy: 'auto',
            email: 'e',
            password: 'p'
        });
    } finally {
        await srv.close();
    }
});

test('DELETE with body (dotfiles.delete parity)', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: 1 }));
    try {
        const api = mk(srv.baseUrl);
        await api.workspaces.dotfiles.delete('w1', ['id1', 'id2']);
        const r = srv.requests[0];
        assert.equal(r.method, 'DELETE');
        assert.equal(r.url, '/rest/v2/workspaces/w1/dotfiles');
        assert.deepEqual(JSON.parse(r.body.toString()), ['id1', 'id2']);
        assert.equal(r.headers['content-type'], 'application/json');
    } finally {
        await srv.close();
    }
});

test('POST with no data sends {} (rest.js parity)', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: null }));
    try {
        const api = mk(srv.baseUrl);
        await api.workspaces.start('w1');
        assert.equal(srv.requests[0].body.toString(), '{}');
    } finally {
        await srv.close();
    }
});

test('error envelope on HTTP 200 throws (envelope is authoritative)', async () => {
    const srv = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', statusCode: 409, message: 'Workspace is not active. Start the workspace first.', payload: null, code: 'WORKSPACE_NOT_ACTIVE' }));
    });
    try {
        const api = mk(srv.baseUrl);
        const err = await api.get('/workspaces/w1').then(
            () => assert.fail('should throw'),
            (e) => e
        );
        assert.ok(err instanceof CanvasError);
        assert.equal(err.code, 'WORKSPACE_NOT_ACTIVE');
        assert.equal(err.statusCode, 409);
    } finally {
        await srv.close();
    }
});

test('error envelope on HTTP 4xx throws identically', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { status: 'error', statusCode: 404, message: 'Resource not found' }));
    try {
        const api = mk(srv.baseUrl);
        const err = await api.get('/workspaces/missing').then(
            () => assert.fail('should throw'),
            (e) => e
        );
        assert.equal(err.message, 'Resource not found');
        assert.equal(err.statusCode, 404);
    } finally {
        await srv.close();
    }
});

test('non-envelope non-ok throws with statusCode', async () => {
    const srv = await startServer((req, res) => {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end('<html>Bad Gateway</html>');
    });
    try {
        const api = mk(srv.baseUrl);
        const err = await api.get('/ping').then(
            () => assert.fail('should throw'),
            (e) => e
        );
        assert.ok(err instanceof CanvasError);
        assert.equal(err.statusCode, 502);
    } finally {
        await srv.close();
    }
});

test('204 resolves to null; non-envelope JSON passes through', async () => {
    let n = 0;
    const srv = await startServer((req, res) => {
        if (n++ === 0) {
            res.writeHead(204);
            res.end();
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ raw: true }));
        }
    });
    try {
        const api = mk(srv.baseUrl);
        assert.equal(await api.get('/a'), null);
        assert.deepEqual(await api.get('/b'), { raw: true });
    } finally {
        await srv.close();
    }
});

test('timeout fires with code TIMEOUT', async () => {
    const srv = await startServer(() => {
        /* hang — never respond */
    });
    try {
        const api = mk(srv.baseUrl);
        const err = await api.get('/slow', { timeout: 60 }).then(
            () => assert.fail('should throw'),
            (e) => e
        );
        assert.ok(err instanceof CanvasError);
        assert.equal(err.code, 'TIMEOUT');
    } finally {
        await srv.close();
    }
});

test('connection refused → isNetworkError true, err.cause.code preserved', async () => {
    // Grab a port that is closed: start a server, note the port, close it.
    const srv = await startServer((req, res) => res.end());
    const deadBase = srv.baseUrl;
    await srv.close();

    const api = mk(deadBase);
    const err = await api.ping().then(
        () => assert.fail('should throw'),
        (e) => e
    );
    assert.ok(err instanceof CanvasError);
    assert.equal(isNetworkError(err), true);
    assert.equal(err.cause?.code, 'ECONNREFUSED');
});

test('per-request headers override defaults; instance extra headers sent', async () => {
    const srv = await startServer((req, res) => sendEnvelope(res, { payload: null }));
    try {
        const api = new CanvasApiClient({
            baseUrl: srv.baseUrl,
            token: 'static-tok',
            headers: { 'X-Custom': 'yes' }
        });
        await api.post('/x', { a: 1 }, { headers: { 'Content-Type': 'text/plain' } });
        const r = srv.requests[0];
        assert.equal(r.headers['x-custom'], 'yes');
        assert.equal(r.headers['content-type'], 'text/plain');
        assert.equal(r.headers.authorization, 'Bearer static-tok');
    } finally {
        await srv.close();
    }
});
