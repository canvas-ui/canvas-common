'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// env.js resolves its paths at import time: point it at a scratch home first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-env-'));
process.env.CANVAS_EDGE_HOME = home;
process.env.CANVAS_EDGE_STATE_ROOT = path.join(home, 'state');
const env = await import('../src/env.js');

before(() => { for (const k of ['CANVAS_HUB_URL', 'CANVAS_HUB_TOKEN', 'CANVAS_WORKSPACE', 'CANVAS_DIRECTION', 'CANVAS_MIRROR_PATH', 'CANVAS_DEVICE_ID']) delete process.env[k]; });
after(() => { fs.rmSync(home, { recursive: true, force: true }); });

test('ensureEnvConfig is a no-op without the three required variables', () => {
    assert.equal(env.ensureEnvConfig({}), null);
    assert.equal(env.ensureEnvConfig({ CANVAS_HUB_URL: 'https://h', CANVAS_HUB_TOKEN: 't' }), null);
    assert.equal(fs.existsSync(env.EDGE_PATHS.mirrors), false);
});

test('ensureEnvConfig seeds one remote + one daemon mirror, idempotently, env fields winning', () => {
    const e = { CANVAS_HUB_URL: 'https://canvas.example.org/', CANVAS_HUB_TOKEN: 'canvas-abc', CANVAS_WORKSPACE: 'Augmentd', CANVAS_DIRECTION: 'pull', CANVAS_MIRROR_PATH: '/data', CANVAS_PINS: 'Accounting/**, Docs/**' };
    const m = env.ensureEnvConfig(e);
    assert.equal(m.id, 'hub/augmentd');
    assert.equal(m.workspaceName, 'augmentd');
    assert.equal(m.folderName, 'Augmentd');
    assert.equal(m.direction, 'pull');
    assert.equal(m.conflicts, 'rename');
    assert.equal(m.client, 'daemon');
    assert.equal(m.mountpoint, path.resolve('/data'));
    assert.deepEqual(m.pins, ['Accounting/**', 'Docs/**']);
    const remotes = JSON.parse(fs.readFileSync(env.EDGE_PATHS.remotes, 'utf8'));
    assert.equal(remotes.hub.url, 'https://canvas.example.org');
    assert.equal(remotes.hub.auth.token, 'canvas-abc');

    // A device token the hub minted later must survive a restart of the container.
    remotes.hub.device = { deviceId: 'dev-1', token: 'canvas-device' };
    fs.writeFileSync(env.EDGE_PATHS.remotes, JSON.stringify(remotes));
    const again = env.ensureEnvConfig({ ...e, CANVAS_DIRECTION: 'bi' });
    assert.equal(again.direction, 'bi', 'env direction wins on every start');
    assert.equal(again.createdAt, m.createdAt, 'same entry, not a second one');
    const cfg = JSON.parse(fs.readFileSync(env.EDGE_PATHS.mirrors, 'utf8'));
    assert.equal(cfg.mirrors.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.EDGE_PATHS.remotes, 'utf8')).hub.device, { deviceId: 'dev-1', token: 'canvas-device' });
    assert.equal(env.hubFor('hub').token, 'canvas-device', 'device token is used once present');
    assert.equal(env.ensureEnvConfig({ ...e, CANVAS_CONFLICTS: 'prompt' }).conflicts, 'prompt', 'explicit policy wins');
    assert.equal(env.ensureEnvConfig(e).conflicts, 'prompt', 'stored explicit policy survives restart');
});

test('daemonMirrors attaches the resolved state dir: explicit stateDir, else <root>/<id>', () => {
    const list = env.daemonMirrors();
    assert.equal(list.length, 1);
    assert.equal(list[0].stateDir, path.join(home, 'state', 'hub_augmentd'));
    assert.equal(env.resolveStateDir({ id: 'x/y', stateDir: '/var/lib/edge/y' }), path.resolve('/var/lib/edge/y'));
    assert.equal(env.resolveStateDir({ id: 'x/y' }, null), null);
});

test('deviceIdentity honours CANVAS_DEVICE_ID / CANVAS_DEVICE_NAME and a hub device id above it', () => {
    process.env.CANVAS_DEVICE_ID = 'nas synology!';
    process.env.CANVAS_DEVICE_NAME = 'Synology';
    assert.deepEqual(env.deviceIdentity(), { deviceId: 'nas-synology-', deviceName: 'Synology' });
    assert.equal(env.deviceIdentity({ deviceId: 'dev-1' }).deviceId, 'dev-1');
    delete process.env.CANVAS_DEVICE_ID; delete process.env.CANVAS_DEVICE_NAME;
});
