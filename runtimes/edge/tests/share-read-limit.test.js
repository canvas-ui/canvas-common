import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShareRuntime } from '../src/share-runtime.js';

test('a burst of reads is answered a few at a time, so the unit never holds the whole burst in memory', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-share-reads-'));
    fs.mkdirSync(path.join(dir, 'folder'));
    fs.writeFileSync(path.join(dir, 'folder', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    const BURST = 40;
    let handed = false, open = 0, most = 0, answered = 0, bytes = 0;
    const server = http.createServer((req, res) => {
        const answer = req.url.includes('/requests/');
        if (answer) { open += 1; most = Math.max(most, open); }
        req.on('data', (chunk) => { if (answer) bytes += chunk.length; });
        req.on('end', async () => {
            res.setHeader('content-type', 'application/json');
            if (answer) { await sleep(20); open -= 1; answered += 1; res.end(JSON.stringify({ payload: { taken: true } })); return; }
            let requests = [];
            if (req.url.endsWith('/poll') && !handed && ready) {
                handed = true;
                requests = Array.from({ length: BURST }, (_, i) => ({ id: `r${i}`, op: 'read', key: 'big.bin', start: 0, end: 1024 * 1024 - 1 }));
            }
            res.end(JSON.stringify({ payload: req.url.endsWith('/poll') ? { requests } : {} }));
        });
    });
    let ready = false;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const unit = new ShareRuntime({
        share: { id: 'test/ws/s.home', workspaceName: 'ws', name: 's.home', path: path.join(dir, 'folder'), stateDir: path.join(dir, 'state'), watch: false },
        hub: { id: 'test', url: `http://127.0.0.1:${server.address().port}`, apiBase: '/rest/v2', token: 'x', deviceId: 'd1' },
        identity: { deviceId: 'd1', deviceName: 'test' }, logger,
    });
    t.after(async () => { await unit.stop(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await unit.start();
    for (const end = Date.now() + 10000; Date.now() < end && unit.status().files !== 1;) await sleep(50);
    ready = true;
    unit.nudge();
    for (const end = Date.now() + 20000; Date.now() < end && answered < BURST;) await sleep(50);
    assert.equal(answered, BURST);
    assert.equal(bytes, BURST * 1024 * 1024);
    assert.ok(most <= 4, `${most} reads were in flight at once`);
    assert.deepEqual([unit.status().reading, unit.status().queued], [0, 0]);
});
