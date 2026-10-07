import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../runtimes/workspaced/src/main.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-git-workspace-'));
fs.writeFileSync(path.join(root, 'existing.txt'), 'Keep this file');
const host = await main({ argv: [root, '--foreground', '--no-web'],
    createHost: async options => (await import('../packages/runtime-core/src/runtime/host.js')).createLocalHost(options) });
try {
    const { url } = JSON.parse(fs.readFileSync(path.join(root, '.workspace/endpoint.json')));
    const headers = { Authorization: `Bearer ${host.config.token}` };
    const response = await fetch(`${url}/rest/v2/workspaces/${host.workspaceId}/trees`, { headers });
    assert.equal(response.status, 200, await response.text());
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'Keep this file');
    console.log('Git workspace API and local database startup passed');
} finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
}
