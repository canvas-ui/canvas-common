// Run against an installed distribution, never a workspace dependency link.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const installed = path.resolve(process.argv[2] || 'node_modules/@augmentd-labs/canvas-agent-runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-distribution-'));
const { main } = await import(pathToFileURL(path.join(installed, 'src/main.js')));
fs.writeFileSync(path.join(root, 'existing.txt'), 'Existing file');
const runtime = await main({ argv: [root, '--foreground', '--no-web'] });
try {
    const { url } = JSON.parse(fs.readFileSync(path.join(root, '.agent/endpoint.json')));
    assert.equal((await fetch(`${url}/rest/v2/workspaces`)).status, 401);
    const headers = { Authorization: `Bearer ${runtime.config.token}` };
    const agents = await fetch(`${url}/rest/v2/agents`, { headers }).then(r => r.json());
    assert.equal(agents.payload.length, 1);
    assert.ok(!agents.payload[0].workspace);
    assert.equal(fs.existsSync(path.join(root, '.workspace')), false);
    assert.equal((await fetch(`${url}/rest/v2/runtime/capabilities`).then(r => r.json())).payload.workspace, false);
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'Existing file');
    console.log('Installed standalone agent API and offline initialization passed; no workspace database created');
} finally {
    await runtime.close();
}
