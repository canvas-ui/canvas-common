import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHost, privateJson } from '../src/runtime/host.js';
import { main } from '../src/main.js';
import { startModelService } from './model-service.js';

function folder(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-agent-only-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'existing.txt'), 'User content');
    return root;
}
const auth = host => ({ Authorization: `Bearer ${host.config.token}` });

test('standalone agent has stable file-backed identity, local auth, and no workspace', async t => {
    const root = folder(t);
    const host = await createAgentHost({ root, webRoot: false });
    t.after(() => host.close());
    const url = await host.start();
    assert.equal(fs.existsSync(path.join(root, '.workspace')), false);
    assert.equal(fs.statSync(path.join(root, '.agent')).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'User content');
    const caps = await fetch(`${url}/rest/v2/runtime/capabilities`).then(r => r.json());
    assert.equal(caps.payload.workspace, false);
    assert.equal(caps.payload.agent, true);
    assert.equal((await fetch(`${url}/rest/v2/agents`)).status, 401);
    const headers = auth(host);
    const list = await fetch(`${url}/rest/v2/agents`, { headers }).then(r => r.json());
    assert.equal(list.payload.length, 1);
    assert.equal(list.payload[0].id, host.config.agentId);
    assert.ok(!list.payload[0].workspace);
    assert.equal(list.payload[0].config.workingDirectory, root);
    assert.equal((await fetch(`${url}/rest/v2/agents`, { method: 'POST', headers, body: '{}' })).status, 409);
    assert.equal((await fetch(`${url}/rest/v2/agents/${host.config.agentId}?confirm=yes`, { method: 'DELETE', headers })).status, 409);
    assert.equal((await fetch(`${url}/rest/v2/auth/me`, { headers: { ...headers, 'x-canvas-edge-context': 'forged' } })).status, 403);
    const tunnel = { Authorization: `Bearer ${host.config.tunnelToken}`, 'x-canvas-edge-context': Buffer.from(JSON.stringify({ resourceType: 'agent', resourceId: host.config.agentId })).toString('base64url') };
    assert.equal((await fetch(`${url}/rest/v2/agents/${host.config.agentId}`, { headers: tunnel })).status, 200);
    assert.equal((await fetch(`${url}/rest/v2/auth/me`, { headers: tunnel })).status, 403);
    assert.equal((await fetch(`${url}/rest/v2/agents/other`, { headers: tunnel })).status, 403);
    await host.close();
    const reopened = await createAgentHost({ root, webRoot: false });
    t.after(() => reopened.close());
    assert.equal(reopened.config.agentId, host.config.agentId);
    assert.equal(reopened.config.instanceId, host.config.instanceId);
    assert.equal(reopened.config.token, host.config.token);
    assert.equal(fs.statSync(reopened.runtimeFile).mode & 0o777, 0o600);
});

test('Pi prompting, sessions, streaming and voice work without a workspace service', async t => {
    const provider = await startModelService(); t.after(() => provider.close());
    const root = folder(t);
    const host = await createAgentHost({ root, model: 'test-model', ollamaUrl: `${provider.url}/v1`,
        voice: { stt: { baseUrl: provider.url }, tts: { baseUrl: provider.url } }, webRoot: false });
    t.after(() => host.close());
    const url = await host.start();
    const headers = auth(host);
    const base = `${url}/rest/v2/agents/${host.config.agentId}`;
    const prompt = await fetch(`${base}/prompt`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hello' }) });
    assert.equal(prompt.status, 200, await prompt.clone().text());
    assert.match(await prompt.text(), /Local inference works/);
    const stream = await fetch(`${base}/prompt/stream`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Again' }) });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /Local inference works/);
    const form = new FormData(); form.append('file', new Blob(['sample'], { type: 'audio/wav' }), 'sample.wav');
    const response = await fetch(`${base}/voice`, { method: 'POST', headers, body: form });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()).payload;
    assert.equal(result.transcript, 'Say hello');
    assert.equal(Buffer.from(result.audio, 'base64').toString(), 'test-audio');
    assert.deepEqual(provider.calls, { completions: 3, transcriptions: 1, syntheses: 1 });
    const agent = await host.agents.open(host.user.id, host.config.agentId);
    const tools = await host.agents.getToolDefinitions(host.user.id, host.config.agentId, host.user.id);
    assert.ok(JSON.stringify(tools).includes('read'));
    assert.ok(agent.getCurrentSessionSelection().path.startsWith(path.join(root, '.agent')));
    assert.equal(fs.existsSync(path.join(root, '.workspace')), false);
    await host.close();
    const reopened = await createAgentHost({ root, webRoot: false }); t.after(() => reopened.close());
    const sessions = await reopened.agents.listSessions(reopened.user.id, reopened.config.agentId, reopened.user.id);
    assert.ok(JSON.stringify(sessions).includes('Hello'));
});

test('daemon owns .agent lock and endpoint, exports one agent, and cleans up on stop', async t => {
    const root = folder(t);
    const host = await main({ argv: [root, '--foreground', '--no-web'] });
    t.after(() => host.close());
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.agent/endpoint.json'))).instanceId, host.config.instanceId);
    await assert.rejects(main({ argv: [root, '--foreground', '--no-web'] }), /lock/i);
    await host.close();
    assert.equal(fs.existsSync(path.join(root, '.agent/host.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.agent/endpoint.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.workspace')), false);
});

test('migration preserves identity and files, and requires old remote exports to be detached', async t => {
    const root = folder(t);
    const host = await createAgentHost({ root, webRoot: false });
    const old = { ...host.config, version: 1, remotes: [{ url: 'https://hub.example', token: 'private' }] };
    await host.close();
    privateJson(path.join(root, '.workspace/runtime.json'), old);
    fs.unlinkSync(host.runtimeFile);
    fs.rmSync(path.join(root, '.agent/host'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agent/runtime/session-marker'), 'keep');
    await assert.rejects(createAgentHost({ root, webRoot: false }), /Detach/);
    old.remotes = []; privateJson(path.join(root, '.workspace/runtime.json'), old);
    const migrated = await createAgentHost({ root, webRoot: false }); t.after(() => migrated.close());
    assert.equal(migrated.config.agentId, old.agentId);
    assert.equal(migrated.config.instanceId, old.instanceId);
    assert.equal(migrated.config.token, old.token);
    const agent = await migrated.agents.open(migrated.user.id, migrated.config.agentId);
    assert.equal(agent.workspace, null);
    assert.equal(agent.access, null);
    assert.equal(fs.readFileSync(path.join(root, '.agent/runtime/session-marker'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(path.join(root, '.workspace/runtime.json')));
});
