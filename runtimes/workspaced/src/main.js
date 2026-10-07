import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import EdgeClient from '@augmentd-labs/canvas-edge/client';

export async function main({ kind = 'workspace', argv = process.argv.slice(2) } = {}) {
  const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    foreground: { type: 'boolean' }, 'init-only': { type: 'boolean' }, name: { type: 'string' }, model: { type: 'string' },
    'ollama-url': { type: 'string' }, 'server-url': { type: 'string' }, 'token-file': { type: 'string' },
    'stt-url': { type: 'string' }, 'tts-url': { type: 'string' }, 'stt-model': { type: 'string' }, voice: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, 'no-web': { type: 'boolean' },
  } });
  if (positionals.length > 1) throw new Error('Specify one runtime folder');
  if (flags.port !== undefined && (!/^\d+$/.test(flags.port) || Number(flags.port) > 65535)) throw new Error('Port must be an integer from 0 to 65535');
  const root = path.resolve(positionals[0] || process.cwd());
  fs.mkdirSync(root, { recursive: true });
  const state = path.join(root, '.workspace'); fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const unlock = await lockfile.lock(state, { realpath: true, lockfilePath: path.join(state, 'host.lock'), stale: 30_000, update: 10_000 });
  let released = false;
  const release = async () => { if (!released) { released = true; await unlock(); } };
  // Set isolated paths before loading shared services. A server installation's environment must never be adopted.
  process.env.CANVAS_SERVER_HOME = path.join(state, 'host');
  process.env.CANVAS_USER_HOME = path.join(state, 'host', 'users');
  process.env.CANVAS_SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
  let host;
  let clients = [];
  try {
    const { createLocalHost } = await import('@augmentd-labs/canvas-runtime-core/host');
    host = await createLocalHost({ root, kind, name: flags.name, model: flags.model, ollamaUrl: flags['ollama-url'],
      webRoot: flags['no-web'] ? false : process.env.CANVAS_WEB_ROOT,
      voice: { stt: flags['stt-url'] ? { baseUrl: flags['stt-url'], model: flags['stt-model'] || 'whisper-1' } : null,
        tts: flags['tts-url'] ? { baseUrl: flags['tts-url'], model: 'kokoro', voice: flags.voice || 'af_heart' } : null } });
    if (flags.host) host.config.host = flags.host;
    if (flags.port !== undefined) host.config.port = Number(flags.port);
    host.save();
    if (flags['server-url']) {
      const serverUrl = new URL(flags['server-url']);
      if (!['https:', 'http:'].includes(serverUrl.protocol) || serverUrl.username || serverUrl.password) throw new Error('Use an HTTP(S) server URL without embedded credentials');
      const userToken = flags['token-file'] ? fs.readFileSync(flags['token-file'], 'utf8').trim() : process.env.CANVAS_PAIRING_TOKEN;
      if (!userToken) throw new Error('Pairing requires --token-file or CANVAS_PAIRING_TOKEN');
      const pair = await EdgeClient.pair({ serverUrl: serverUrl.href, userToken, name: host.config.name, type: 'edge', deviceId: host.config.instanceId });
      host.config.remotes = [{ url: serverUrl.href.replace(/\/$/, ''), token: pair.token, deviceId: pair.deviceId }];
      host.save();
    }
    delete process.env.CANVAS_PAIRING_TOKEN;
    if (flags['init-only']) { await host.close(); await release(); return { root, instanceId: host.config.instanceId }; }
    if (!flags.foreground) {
      // A daemon entrypoint has the same background default as `canvas init`.
      await host.close(); await release();
      const script = fileURLToPath(new URL(`../bin/canvas-${kind === 'agent' ? 'agent' : 'workspace'}.js`, import.meta.url));
      const args = [script, root, '--foreground'];
      if (flags.host) args.push('--host', flags.host);
      if (flags.port) args.push('--port', flags.port);
      if (flags['no-web']) args.push('--no-web');
      const pm2 = process.env.CANVAS_PM2_BIN || 'pm2';
      const child = spawn(pm2, ['start', process.execPath, '--name', `canvas-${host.config.instanceId}`, '--interpreter', 'none', '--', ...args], { stdio: 'inherit' });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`PM2 exited ${code}; use --foreground or install PM2`))); });
      return;
    }
    const address = await host.start({ host: flags.host || host.config.host || '127.0.0.1', port: Number(flags.port ?? host.config.port ?? 0) });
    host.config.host = flags.host || host.config.host || '127.0.0.1';
    host.config.port = Number(new URL(address).port); host.save();
    const workspace = await host.workspaceManager.getWorkspace(host.workspaceId, host.user.id);
    const exports = [{ type: 'workspace', id: host.workspaceId, name: host.config.name, acl: workspace.acl }];
    if (host.config.agentId) exports.push({ type: 'agent', id: host.config.agentId, name: host.config.name, workspaceId: host.workspaceId });
    const remotes = host.config.remotes.filter(r => r.enabled !== false);
    clients = remotes.map(remote => {
      const client = new EdgeClient({ serverUrl: remote.url, token: remote.token, tls: remote.tls,
        localUrl: address, localToken: host.config.tunnelToken,
        announce: { protocol: 2, instanceId: host.config.instanceId, runtime: host.config.kind, version: '0.1.1', caps: ['proxy','stream-v2'], exports } });
      client.forwardEvents(host.workspaceManager); client.forwardEvents(host.agents); return client.connect();
    });
    host.subscribePolicy(acl => Promise.all(clients.map(client => client.publishPolicy(host.workspaceId, acl))));
    // Status metadata is private, credentials remain in runtime.json.
    fs.writeFileSync(path.join(state, 'endpoint.json'), JSON.stringify({ url: address, pid: process.pid, instanceId: host.config.instanceId }), { mode: 0o600 });
    console.log(`Canvas ${host.config.kind}: ${address}\nLocal token file: ${host.runtimeFile}\nWorkspace: ${host.workspaceId}${host.config.agentId ? `\nAgent: ${host.config.agentId}` : ''}`);
    const interval = setInterval(() => {
      fs.writeFileSync(path.join(state, 'connections.json'), JSON.stringify(clients.map((client, i) => ({ url: remotes[i].url, ...client.status }))), { mode: 0o600 });
    }, 3000);
    let stopping = false;
    const reloadRegistration = () => {
      const saved = JSON.parse(fs.readFileSync(host.runtimeFile, 'utf8'));
      if (!saved.remotes.length) {
        clients.forEach(c => c.close()); clients = []; host.config.remotes = [];
      }
    };
    process.on('SIGHUP', reloadRegistration);
    const stop = async () => {
      if (stopping) return; stopping = true;
      clearInterval(interval); process.off('SIGHUP', reloadRegistration); clients.forEach(c => c.close());
      try { await host.close(); } finally { await release(); fs.rmSync(path.join(state, 'endpoint.json'), { force: true }); }
    };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    return { ...host, clients, close: stop };
  } catch (error) {
    clients.forEach(c => c.close()); await host?.close().catch(() => {}); await release(); throw error;
  }
}
