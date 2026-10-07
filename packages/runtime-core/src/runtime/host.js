/** Embeddable, single-owner resource host. Importing this module starts no server. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';
import socketIO from 'fastify-socket.io';
import staticFiles from '@fastify/static';
import Jim from '../utils/jim/index.js';
import WorkspaceManager from '../core/workspace/index.js';
import ContextManager from '../core/context/index.js';
import Agents from '../core/agent/index.js';
import Roles from '../core/role/index.js';
import roleRoutes from '../transports/routes/roles/index.js';
import DeviceRegistry from '../core/device/Registry.js';
import Voice from '../services/voice/src/index.js';
import { mountWorkspacesApi, mountContextsApi } from '../transports/api-contract.js';
import agentRoutes from '../transports/routes/agents/index.js';
import voiceRoutes from '../transports/routes/voice/index.js';
import schemaRoutes from '../transports/routes/schemas.js';
import registerWorkspace from '../transports/websocket/channels/workspace.js';
import registerAgent from '../transports/websocket/channels/agent.js';
import registerContext from '../transports/websocket/channels/context.js';
import { enforceAgentBinding } from '../transports/middleware/agent-acl.js';
import { enforceWorkspaceTokenScope } from '../transports/middleware/workspace-acl.js';
import { resolveAclAccess } from '../core/workspace/lib/access.js';

const envelope = payload => ({ status: 'success', statusCode: 200, payload });
function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function equals(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function createLocalHost({ root, kind = 'workspace', name, model, ollamaUrl, voice = {}, webRoot, logger = false } = {}) {
  if (!root || !['workspace', 'agent'].includes(kind)) throw new Error('A root folder and valid runtime kind are required');
  root = fs.realpathSync(root);
  const state = path.join(root, '.workspace');
  const runtimeFile = path.join(state, 'runtime.json');
  let config = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) : null;
  const oldWorkspace = [path.join(root, 'workspace.json'), path.join(state, 'workspace.json')].find(f => fs.existsSync(f));
  const oldConfig = oldWorkspace ? JSON.parse(fs.readFileSync(oldWorkspace, 'utf8')) : null;
  if (oldConfig && oldConfig.layout !== 'home') throw new Error('Local runtimes require the workspace home layout; migrate the existing full layout first');
  if (!config) {
    config = { version: 1, instanceId: randomUUID(), userId: oldConfig?.owner || randomUUID(), kind,
      name: name || path.basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'local',
      token: `canvas-local-${randomBytes(32).toString('hex')}`, tunnelToken: randomBytes(32).toString('hex'),
      jwtSecret: randomBytes(32).toString('hex'), voice, model: model || 'qwen3:latest', ollamaUrl: ollamaUrl || 'http://127.0.0.1:11434/v1', remotes: [] };
    privateJson(runtimeFile, config);
  }
  if (kind === 'agent' && config.kind === 'workspace') { config.kind = 'agent'; privateJson(runtimeFile, config); }
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(config.name)) throw new Error('Runtime name must be 1–100 lowercase letters, digits, dots, underscores or hyphens, beginning with a letter or digit');
  if (model) config.model = model;
  if (ollamaUrl) config.ollamaUrl = ollamaUrl;
  config.voice ||= {};
  for (const [key, value] of Object.entries(voice)) if (value) config.voice[key] = value;
  privateJson(runtimeFile, config);
  const user = { id: config.userId, email: 'local@canvas.local', name: 'Local owner', status: 'active', userType: 'user', homePath: state };
  const jim = new Jim({ rootPath: path.join(state, 'host'), driver: 'conf', driverOptions: { accessPropertiesByDotNotation: false } });
  const userIndex = jim.createIndex('users'); userIndex.set(user.id, user);
  const users = {
    indexStore: userIndex,
    list: async () => [user], get: async id => id === user.id || id === user.email ? user : null,
    resolveId: async id => id === user.id || id === user.email ? user.id : null,
    getUserPaths: () => ({ home: state, workspaces: path.join(state, 'workspaces'), agents: path.join(state, 'agents'), roles: path.join(state, 'roles') }),
  };
  const workspaceManager = new WorkspaceManager({ defaultRootPath: state, defaultLayout: 'home', indexFactory: jim, users });
  await workspaceManager.initialize();
  let entry = oldConfig && workspaceManager.getWorkspaceIndexEntry(oldConfig.id, user.id);
  if (!entry) entry = oldConfig
    ? await workspaceManager.registerWorkspacePath(user.id, root, { adopt: false })
    : await workspaceManager.createWorkspace(config.name, user.id, { rootPath: root, layout: 'home' });
  const workspaceId = entry.id;
  const roles = new Roles({ indexStore: jim.createIndex('roles'), users, workspaceManager, serverConfig: { dataPath: state } });
  await roles.initialize(); workspaceManager.setRoles(roles);
  const contextManager = new ContextManager({ indexFactory: jim, workspaceManager });
  await contextManager.initialize();
  const agents = new Agents({ defaultRootPath: state, indexStore: jim.createIndex('agents'), users });
  agents.setWorkspaceManager(workspaceManager); agents.setContextManager(contextManager);
  agents.setApiBaseUrl('http://127.0.0.1:0/rest/v2');
  await agents.initialize();
  if (config.kind === 'agent' && !config.agentId) {
    const agent = await agents.create(user.id, config.name, { agentPath: path.join(root, '.agent'), workspace: false, workspaceInfo: { id: workspaceId, rootPath: root },
      llmProvider: 'ollama', model: config.model, deferProviderValidation: true,
      config: { baseUrl: config.ollamaUrl, workingDirectory: root } });
    config.agentId = agent.id;
    privateJson(runtimeFile, config);
    await agents.setAccess(user.id, agent.id, { binding: { type: 'workspace', workspace: workspaceId }, permissions: ['read', 'write'] });
  } else if (config.agentId && (model || ollamaUrl)) {
    await agents.update(user.id, config.agentId, { model: config.model, config: { baseUrl: config.ollamaUrl }, deferProviderValidation: true }, user.id);
  }
  workspaceManager.hookService?.setAgents(agents);
  const policyListeners = new Set();
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 * 1024, ignoreTrailingSlash: true });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(socketIO, { transports: ['websocket'], maxHttpBufferSize: 1024 * 1024 });
  for (const [key, value] of Object.entries({ users, workspaceManager, contextManager, agents, roles,
    dotfileManager: workspaceManager.dotfileService, voice: new Voice(config.voice),
    deviceRegistry: new DeviceRegistry({ userHomePath: state, usersIndex: userIndex }),
    authService: { verifyApiToken: async value => equals(value, config.token) ? { userId: user.id } : null },
  })) app.decorate(key, value);
  app.decorate('broadcastToUser', (_id, event, payload) => app.io.emit(event, payload));
  app.decorate('broadcastToWorkspace', (id, event, payload) => app.io.to(`workspace:${id}`).emit(event, payload));
  app.decorate('broadcastToContext', (id, event, payload) => app.io.to(`context:${id}`).emit(event, payload));
  const authenticate = async (request, reply) => {
    const value = request.headers.authorization?.replace(/^Bearer /, '');
    request.user = user;
    if (equals(value, config.token)) {
      if (request.headers['x-canvas-edge-context']) return reply.code(403).send({ message: 'Internal context is not accepted with local credentials' });
      return;
    }
    if (equals(value, config.tunnelToken)) {
      let context;
      try { context = JSON.parse(Buffer.from(request.headers['x-canvas-edge-context'] || '', 'base64url')); } catch { /* rejected below */ }
      if (!context || !['workspace', 'agent'].includes(context.resourceType) ||
        (context.resourceType === 'workspace' ? context.resourceId !== workspaceId : context.resourceId !== config.agentId)) return reply.code(403).send({ message: 'Invalid tunnel context' });
      if (context.resourceType === 'workspace' && context.binding) {
        request.resourceToken = context.binding;
        if (context.binding.type === 'workspace') {
          const workspace = await workspaceManager.getWorkspace(workspaceId, user.id);
          const grant = context.shareToken ? workspaceManager.resolveWorkspaceShareToken(context.shareToken) : resolveAclAccess(workspace.acl, context.principal);
          if (!grant?.permissions?.includes('read')) return reply.code(403).send({ message: 'Workspace access revoked locally' });
          request.resourceToken = { ...context.binding, permissions: grant.permissions };
        }
      }
      return;
    }
    const binding = await (value?.startsWith('canvas-agent-') ? agents.verifyAgentToken(value) : null);
    if (binding) { request.resourceToken = { ...binding, type: 'agent' }; return; }
    const share = workspaceManager.resolveWorkspaceShareToken(value);
    if (share) { request.resourceToken = { ...share, type: 'workspace' }; return; }
    return reply.code(401).send({ message: 'Valid local bearer token required' });
  };
  app.decorate('authenticate', authenticate); app.decorate('authenticateClient', authenticate);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/rest/v2/') && !['/rest/v2/ping', '/rest/v2/runtime/capabilities', '/rest/v2/auth/config'].includes(url)) {
      await authenticate(req, reply);
      if (!reply.sent) await enforceWorkspaceTokenScope(req, reply);
      if (reply.sent) return;
    }
    if (req.method === 'DELETE' && /^\/rest\/v2\/(workspaces|agents)\/[^/]+\/?$/.test(url)) return reply.code(409).send({ message: 'Stop this runtime with canvas runtime stop; its local resource cannot be deleted through the API' });
    if (req.method === 'POST' && /^\/rest\/v2\/(workspaces|agents)\/?$/.test(url)) return reply.code(409).send({ message: 'This runtime hosts one workspace and one optional agent; initialize another folder for another runtime' });
  });
  app.addHook('preHandler', enforceWorkspaceTokenScope);
  app.addHook('preHandler', enforceAgentBinding);
  app.addHook('onSend', async (req, reply) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && reply.statusCode < 400) {
      const workspace = await workspaceManager.getWorkspace(workspaceId, user.id);
      await Promise.allSettled([...policyListeners].map(listener => listener(workspace.acl)));
    }
    reply.header('X-Source-Code', 'https://github.com/canvas-ui/canvas-common; license=AGPL-3.0-or-later'); });
  app.get('/rest/v2/ping', async () => envelope({ name: 'Canvas local runtime', runtime: config.kind }));
  app.get('/rest/v2/runtime/capabilities', async () => envelope({ local: true, auth: 'token', workspace: true, agent: config.kind === 'agent', voice: { stt: !!config.voice?.stt?.baseUrl, tts: !!config.voice?.tts?.baseUrl } }));
  app.get('/rest/v2/auth/config', async () => envelope({ allowUserRegistrations: false, strategies: { local: { enabled: false }, imap: { enabled: false, domains: [] } } }));
  app.post('/rest/v2/auth/logout', async () => envelope({ loggedOut: true }));
  app.get('/rest/v2/auth/me', async () => envelope(user));
  app.get('/rest/v2/runtime/status', async () => envelope({ instanceId: config.instanceId, workspaceId, agentId: config.agentId, root, kind: config.kind }));
  mountWorkspacesApi(app); mountContextsApi(app);
  app.register(agentRoutes, { prefix: '/rest/v2/agents' });
  app.register(voiceRoutes, { prefix: '/rest/v2/voice' });
  app.register(roleRoutes, { prefix: '/rest/v2/roles' });
  app.register(schemaRoutes, { prefix: '/rest/v2/schemas' });
  app.io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!equals(token, config.token)) return next(new Error('Valid local bearer token required'));
    socket.user = user; socket.subscriptions = new Set(); next();
  });
  app.io.on('connection', socket => {
    registerWorkspace(app, socket); registerAgent(app, socket); registerContext(app, socket);
    socket.on('subscribe', async ({ channel } = {}) => {
      try {
        if (channel === `workspace:${workspaceId}` || channel === `workspace:${entry.name}`) {
          socket.subscriptions.add(channel); socket.join(channel); socket.emit('subscribed', { channel });
        } else if (channel?.startsWith('context:')) {
          await contextManager.getContext(user.id, channel.slice(8)); socket.subscriptions.add(channel); socket.join(channel); socket.emit('subscribed', { channel });
        } else socket.emit('error', { message: 'Unknown local resource' });
      } catch (error) { socket.emit('error', { message: error.message }); }
    });
    socket.on('unsubscribe', ({ channel } = {}) => { socket.subscriptions.delete(channel); socket.leave(channel); });
    socket.on('ping', () => socket.emit('pong', { time: Date.now() }));
    socket.emit('authenticated', { userId: user.id, email: user.email });
  });
  const require = createRequire(import.meta.url);
  if (webRoot !== false) {
    const dist = webRoot || path.join(path.dirname(require.resolve('@augmentd-labs/canvas-web/package.json')), 'dist');
    if (fs.existsSync(path.join(dist, 'index.html'))) {
      await app.register(staticFiles, { root: dist });
      app.setNotFoundHandler((request, reply) => request.url.startsWith('/rest/') ? reply.code(404).send({ message: 'Unknown API route' }) : reply.sendFile('index.html'));
    }
  }
  app.addHook('onClose', async () => {
    if (config.agentId) await agents.stop(user.id, config.agentId, user.id);
    await workspaceManager.stopWorkspace(workspaceId, user.id);
  });
  return { app, config, runtimeFile, workspaceId, user, indexFactory: jim, workspaceManager, contextManager, agents,
    subscribePolicy(listener) { policyListeners.add(listener); return () => policyListeners.delete(listener); },
    async start({ host = '127.0.0.1', port = 0 } = {}) {
      await app.listen({ host, port });
      const bind = app.server.address().address;
      const localHost = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '[::1]' : bind.includes(':') ? `[${bind}]` : bind;
      const address = `http://${localHost}:${app.server.address().port}`;
      agents.setApiBaseUrl(`${address}/rest/v2`);
      await workspaceManager.startWorkspace(workspaceId, user.id);
      return address;
    }, save() { privateJson(runtimeFile, config); }, close: () => app.close() };
}
