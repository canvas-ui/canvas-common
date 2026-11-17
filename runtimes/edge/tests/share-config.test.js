'use strict';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// env.js resolves its paths at import time: point it at a scratch home first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-share-'));
process.env.CANVAS_EDGE_HOME = home;
delete process.env.CANVAS_EDGE_STATE_ROOT;
const env = await import('../src/env.js');

after(() => { fs.rmSync(home, { recursive: true, force: true }); });

const hub = { CANVAS_HUB_URL: 'https://canvas.example.org/', CANVAS_HUB_TOKEN: 'canvas-abc', CANVAS_WORKSPACE: 'Augmentd' };

test('ensureEnvShare seeds one remote and one share, and such a container mirrors nothing', () => {
    assert.equal(env.ensureEnvShare({}), null);
    assert.throws(() => env.ensureEnvShare({ CANVAS_SHARE_NAME: 'nas-accounting.home' }), /CANVAS_HUB_URL/);

    const share = env.ensureEnvShare({ ...hub, CANVAS_SHARE_NAME: 'NAS-Accounting.home', CANVAS_SHARE_LABEL: 'NAS Accounting', CANVAS_SHARE_EXCLUDE: 'Drafts/**, *.bak' });
    assert.deepEqual([share.id, share.remote, share.workspaceName, share.name, share.label, share.path, share.watch],
        ['hub/augmentd/nas-accounting.home', 'hub', 'augmentd', 'nas-accounting.home', 'NAS Accounting', path.resolve('/data'), true]);
    assert.deepEqual(share.exclude, ['Drafts/**', '*.bak']);
    assert.equal(JSON.parse(fs.readFileSync(env.EDGE_PATHS.remotes, 'utf8')).hub.auth.token, 'canvas-abc');

    assert.equal(env.ensureEnvConfig({ ...hub, CANVAS_SHARE_NAME: 'nas-accounting.home' }), null);
    assert.equal(fs.existsSync(env.EDGE_PATHS.mirrors), false);

    // A restart with other settings updates the entry in place and keeps what the file carries.
    const again = env.ensureEnvShare({ ...hub, CANVAS_SHARE_NAME: 'nas-accounting.home', CANVAS_SHARE_PATH: '/volume1/augmentd/accounting', CANVAS_SHARE_WATCH: 'false' });
    assert.deepEqual([again.path, again.watch, again.label, again.createdAt], ['/volume1/augmentd/accounting', false, 'NAS Accounting', share.createdAt]);
    assert.equal(JSON.parse(fs.readFileSync(env.EDGE_PATHS.shares, 'utf8')).shares.length, 1);
});

test('edgeShares lists complete, unpaused entries with their state outside the folder', () => {
    const cfg = JSON.parse(fs.readFileSync(env.EDGE_PATHS.shares, 'utf8'));
    cfg.shares.push(
        { id: 'hub/universe/wd1t.home', remote: 'hub', workspaceName: 'universe', name: 'wd1t.home', path: '/mnt/mywd', stateDir: '/var/lib/canvas/wd1t' },
        { id: 'hub/universe/red-usb.home', remote: 'hub', workspaceName: 'universe', name: 'red-usb.home', path: '/mnt/usb', paused: true },
        { id: 'hub/universe/broken.home', remote: 'hub', workspaceName: 'universe', name: 'broken.home' },
    );
    fs.writeFileSync(env.EDGE_PATHS.shares, JSON.stringify(cfg));
    const shares = env.edgeShares();
    assert.deepEqual(shares.map((s) => s.name), ['nas-accounting.home', 'wd1t.home']);
    assert.equal(shares[0].stateDir, path.join(home, 'var', 'shares', 'hub_augmentd_nas-accounting.home'));
    assert.equal(shares[1].stateDir, path.resolve('/var/lib/canvas/wd1t'));
    assert.equal(env.shareId('hub', 'universe', 'wd1t.home'), 'hub/universe/wd1t.home');
});
