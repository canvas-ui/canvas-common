import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShareRuntime } from '../src/share-runtime.js';

test('a share whose token the hub rejects takes the replaced credentials and connects', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-share-cred-'));
    fs.mkdirSync(path.join(dir, 'folder'));
    fs.writeFileSync(path.join(dir, 'folder', 'a.txt'), 'a');
    const seen = [];
    const server = http.createServer((req, res) => {
        req.resume();
        const token = String(req.headers.authorization || '').replace('Bearer ', '');
        seen.push(token);
        res.setHeader('content-type', 'application/json');
        if (token !== 'new') { res.statusCode = 401; res.end(JSON.stringify({ message: 'Invalid API token' })); return; }
        res.end(JSON.stringify({ payload: req.url.endsWith('/poll') ? { requests: [] } : {} }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const hub = (token) => ({ id: 'test', url, apiBase: '/rest/v2', token, deviceId: 'd1' });
    const identity = { deviceId: 'd1', deviceName: 'test' };
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    let current = 'old';
    const unit = new ShareRuntime({
        share: { id: 'test/ws/s.home', workspaceName: 'ws', name: 's.home', path: path.join(dir, 'folder'), stateDir: path.join(dir, 'state'), watch: false },
        hub: hub('old'), identity, logger, refresh: () => ({ hub: hub(current), identity }),
    });
    t.after(async () => { await unit.stop(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await unit.start();

    for (const end = Date.now() + 5000; Date.now() < end && !unit.status().lastError;) await sleep(50);
    assert.match(unit.status().lastError, /rejected this device's token/);
    assert.equal(unit.status().connected, false);

    current = 'new';
    for (const end = Date.now() + 10000; Date.now() < end && !unit.status().connected;) await sleep(50);
    assert.equal(unit.status().connected, true);
    assert.equal(unit.status().lastError, null);
    assert.ok(seen.includes('old') && seen.includes('new'));
});
