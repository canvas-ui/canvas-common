import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { keyId, signHubCredential } from '../packages/runtime-core/src/utils/hub-credential.js';
import { main } from '../runtimes/workspaced/src/main.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-git-workspace-'));
fs.writeFileSync(path.join(root, 'existing.txt'), 'Keep this file');
const host = await main({ argv: [root, '--foreground', '--no-web'],
    createHost: async options => (await import('../packages/runtime-core/src/runtimes/workspace/runtime/host.js')).createWorkspaceHost(options) });
try {
    const { url } = JSON.parse(fs.readFileSync(path.join(root, '.workspace/endpoint.json')));
    const headers = { Authorization: `Bearer ${host.config.token}` };
    const response = await fetch(`${url}/rest/v2/workspaces/${host.workspaceId}/trees`, { headers });
    assert.equal(response.status, 200, await response.text());
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'Keep this file');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ format: 'jwk' }).x;
    const kid = keyId(key);
    host.config.remotes = [{ hub: { iss: 'smoke-hub', keys: [{ iss: 'smoke-hub', kid, key }] } }];
    const credential = claims => signHubCredential({ aud: host.config.instanceId,
        res: { type: 'workspace', id: host.workspaceId }, ...claims }, { iss: 'smoke-hub', kid, privateKey });
    const backupUrl = `${url}/rest/v2/workspaces/${host.workspaceId}/db/backups`;
    assert.equal((await fetch(backupUrl, { headers: { Authorization: `Bearer ${credential()}` } })).status, 200);
    assert.equal((await fetch(backupUrl, { headers: { Authorization: `Bearer ${credential({ aud: 'wrong-runtime' })}` } })).status, 401);
    host.config.tunnelToken = 'retired-secret';
    const retired = { Authorization: 'Bearer retired-secret',
        'x-canvas-edge-context': Buffer.from(JSON.stringify({ resourceType: 'workspace', resourceId: host.workspaceId })).toString('base64url') };
    assert.equal((await fetch(backupUrl, { headers: retired })).status, 401);
    assert.equal((await fetch(backupUrl, { method: 'POST', headers: { ...retired, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'backup' }) })).status, 401);
    delete host.config.tunnelToken;
    console.log('Git workspace API, database, and hub credential checks passed');
} finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
}
