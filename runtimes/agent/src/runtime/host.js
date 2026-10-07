import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import Conf from 'conf';
import lockfile from 'proper-lockfile';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import socketIO from 'fastify-socket.io';
import staticFiles from '@fastify/static';
import Agents from '../core/agent/index.js';
import Voice from '../services/voice/src/index.js';
import agentRoutes from '../transports/routes/agents/index.js';
import voiceRoutes from '../transports/routes/voice/index.js';
import registerAgent from '../transports/websocket/channels/agent.js';

const envelope = payload => ({ status: 'success', statusCode: 200, payload });
export function privateJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(`${file}.tmp`, 0o600);
    fs.renameSync(`${file}.tmp`, file);
}
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
function equals(a, b) {
    if (!a || !b) return false;
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

/** One owner, one agent, filesystem-backed sessions. No workspace/database initialization. */
export async function createAgentHost({ root, name, model, ollamaUrl, voice = {}, webRoot, logger = false } = {}) {
    if (!root) throw new Error('A root folder is required');
    root = fs.realpathSync(root);
    const state = path.join(root, '.agent');
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const runtimeFile = path.join(state, 'runtime.json');
    let config = readJson(runtimeFile);
    if (!config) {
        const legacy = readJson(path.join(root, '.workspace/runtime.json'));
        if (legacy?.kind === 'agent') {
            if (await lockfile.check(path.join(root, '.workspace'), { lockfilePath: path.join(root, '.workspace/host.lock'), stale: 30_000 })) {
                throw new Error('Stop the existing workspace-backed runtime with canvas runtime stop before migrating the agent');
            }
            if (legacy.remotes?.some(remote => remote.enabled !== false)) {
                throw new Error('Detach the existing workspace-backed runtime with canvas runtime detach before initializing the standalone agent');
            }
            // Keep agent identity, model settings and sessions; retain all old workspace data.
            config = { ...legacy, version: 2, kind: 'agent', remotes: [] };
        } else {
            config = { version: 2, instanceId: randomUUID(), userId: randomUUID(), kind: 'agent',
                name: name || path.basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'local',
                token: `canvas-local-${randomBytes(32).toString('hex')}`, tunnelToken: randomBytes(32).toString('hex'),
                voice, model: model || 'qwen3:latest', ollamaUrl: ollamaUrl || 'http://127.0.0.1:11434/v1', remotes: [] };
        }
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(config.name)) throw new Error('Runtime name must be 1–100 lowercase letters, digits, dots, underscores or hyphens, beginning with a letter or digit');
    if (model) config.model = model;
    if (ollamaUrl) config.ollamaUrl = ollamaUrl;
    config.voice ||= {};
    for (const [key, value] of Object.entries(voice)) if (value) config.voice[key] = value;
    const user = { id: config.userId, email: 'local@canvas.local', name: 'Local owner', status: 'active', userType: 'user', homePath: state };
    const users = { get: async id => [user.id, user.email].includes(id) ? user : null,
        resolveId: async id => [user.id, user.email].includes(id) ? user.id : null,
        getUserPaths: () => ({ home: state, agents: state }) };
    const index = new Conf({ cwd: path.join(state, 'host'), configName: 'agents', accessPropertiesByDotNotation: false });
    const agentConfigPath = path.join(state, 'config/agent.json');
    const existing = readJson(agentConfigPath);
    if (existing && !index.has(`${user.id}/${existing.id}`)) {
        if (existing.owner !== user.id || (config.agentId && existing.id !== config.agentId)) throw new Error('Existing agent identity does not match runtime configuration');
        const adopted = { ...existing, rootPath: state, configPath: agentConfigPath, workspace: null, access: null,
            config: { ...existing.config, workingDirectory: root } };
        privateJson(agentConfigPath, adopted);
        index.set(`${user.id}/${existing.id}`, adopted);
        config.agentId = existing.id;
    }
    const agents = new Agents({ defaultRootPath: state, indexStore: index, users });
    await agents.initialize();
    if (!config.agentId) {
        const agent = await agents.create(user.id, config.name, { agentPath: state, workspace: false,
            llmProvider: 'ollama', model: config.model, deferProviderValidation: true,
            config: { baseUrl: config.ollamaUrl, workingDirectory: root } });
        config.agentId = agent.id;
    } else if (model || ollamaUrl) {
        await agents.update(user.id, config.agentId, { model: config.model,
            config: { baseUrl: config.ollamaUrl, workingDirectory: root }, deferProviderValidation: true }, user.id);
    }
    privateJson(runtimeFile, config);
    const app = Fastify({ logger, bodyLimit: 1024 * 1024 * 1024, ignoreTrailingSlash: true });
    await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
    await app.register(socketIO, { transports: ['websocket'], maxHttpBufferSize: 1024 * 1024 });
    for (const [key, value] of Object.entries({ users, agents, voice: new Voice(config.voice) })) app.decorate(key, value);
    const authenticate = async (request, reply) => {
        const value = request.headers.authorization?.replace(/^Bearer /, '');
        if (equals(value, config.token)) {
            if (request.headers['x-canvas-edge-context']) return reply.code(403).send({ message: 'Internal context is not accepted with local credentials' });
        } else if (equals(value, config.tunnelToken)) {
            let context;
            try { context = JSON.parse(Buffer.from(request.headers['x-canvas-edge-context'] || '', 'base64url')); } catch { /* rejected below */ }
            const route = request.url.split('?')[0];
            const prefix = `/rest/v2/agents/${config.agentId}`;
            if (context?.resourceType !== 'agent' || context.resourceId !== config.agentId || context.binding ||
                !(route === prefix || route.startsWith(`${prefix}/`))) return reply.code(403).send({ message: 'Invalid tunnel context' });
        } else return reply.code(401).send({ message: 'Valid local bearer token required' });
        request.user = user;
    };
    app.decorate('authenticate', authenticate);
    app.decorate('authenticateClient', authenticate);
    app.addHook('onRequest', async (req, reply) => {
        const url = req.url.split('?')[0];
        if (url.startsWith('/rest/v2/') && !['/rest/v2/ping', '/rest/v2/runtime/capabilities', '/rest/v2/auth/config'].includes(url)) {
            await authenticate(req, reply);
            if (reply.sent) return;
        }
        if ((req.method === 'DELETE' && /^\/rest\/v2\/agents\/[^/]+\/?$/.test(url)) ||
            (req.method === 'POST' && /^\/rest\/v2\/agents\/?$/.test(url))) {
            return reply.code(409).send({ message: 'This runtime hosts one local agent; use canvas init agent or canvas runtime stop' });
        }
        if (/^\/rest\/v2\/agents\/[^/]+\/access(?:\/|$)/.test(url) && !['GET', 'HEAD'].includes(req.method)) {
            return reply.code(409).send({ message: 'This standalone agent has no local workspace binding' });
        }
    });
    app.get('/rest/v2/ping', async () => envelope({ name: 'Canvas agent runtime', runtime: 'agent' }));
    app.get('/rest/v2/runtime/capabilities', async () => envelope({ local: true, auth: 'token', workspace: false, agent: true,
        voice: { stt: !!config.voice?.stt?.baseUrl, tts: !!config.voice?.tts?.baseUrl } }));
    app.get('/rest/v2/auth/config', async () => envelope({ allowUserRegistrations: false, strategies: { local: { enabled: false }, imap: { enabled: false, domains: [] } } }));
    app.get('/rest/v2/auth/me', async () => envelope(user));
    app.post('/rest/v2/auth/logout', async () => envelope({ loggedOut: true }));
    app.get('/rest/v2/runtime/status', async () => envelope({ instanceId: config.instanceId, agentId: config.agentId, root, kind: 'agent' }));
    // Empty discovery lists keep the shared UI usable without a workspace service.
    for (const resource of ['workspaces', 'contexts', 'roles']) app.get(`/rest/v2/${resource}`, async () => envelope([]));
    app.register(agentRoutes, { prefix: '/rest/v2/agents' });
    app.register(voiceRoutes, { prefix: '/rest/v2/voice' });
    app.io.use((socket, next) => {
        if (!equals(socket.handshake.auth?.token, config.token)) return next(new Error('Valid local bearer token required'));
        socket.user = user; socket.subscriptions = new Set(); next();
    });
    app.io.on('connection', socket => {
        registerAgent(app, socket);
        socket.on('ping', () => socket.emit('pong', { time: Date.now() }));
        socket.emit('authenticated', { userId: user.id, email: user.email });
    });
    if (webRoot !== false) {
        const require = createRequire(import.meta.url);
        const dist = webRoot || path.join(path.dirname(require.resolve('@augmentd-labs/canvas-web/package.json')), 'dist');
        if (fs.existsSync(path.join(dist, 'index.html'))) {
            await app.register(staticFiles, { root: dist });
            app.setNotFoundHandler((request, reply) => request.url.startsWith('/rest/') ? reply.code(404).send({ message: 'Unknown API route' }) : reply.sendFile('index.html'));
        }
    }
    app.addHook('onClose', async () => { await agents.stop(user.id, config.agentId, user.id); });
    return { app, config, runtimeFile, user, agents,
        async start({ host = '127.0.0.1', port = 0 } = {}) {
            await app.listen({ host, port });
            const bind = app.server.address().address;
            const local = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '[::1]' : bind.includes(':') ? `[${bind}]` : bind;
            return `http://${local}:${app.server.address().port}`;
        }, save() { privateJson(runtimeFile, config); }, close: () => app.close() };
}
