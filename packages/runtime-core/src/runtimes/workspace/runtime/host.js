/**
 * Workspace runtime host: one workspace behind its own token-authenticated
 * REST/ws API. It orchestrates nothing (no agents, roles or voice): a hub or
 * the user runs those and connects them with a token. Importing this module
 * starts no server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import socketIO from 'fastify-socket.io';
import staticFiles from '@fastify/static';
import Jim from '../../../utils/jim/index.js';
import SingleWorkspaceManager from './SingleWorkspaceManager.js';
import ContextManager from '../contexts/index.js';
import { mountWorkspacesApi, mountContextsApi, API_VERSION } from '../../../transports/api-contract.js';
import { installMcp } from '../../../transports/mcp/index.js';
import schemaRoutes from '../../../transports/routes/schemas.js';
import webdavRoutes from '../../../transports/routes/webdav.js';
import registerWorkspace from '../../../transports/websocket/channels/workspace.js';
import registerContext from '../../../transports/websocket/channels/context.js';
import { enforceWorkspaceTokenScope } from '../../../transports/middleware/workspace-acl.js';
import { resolveAclAccess, shareKeyGrant } from '../security/access.js';
import { isHubCredential, verifyHubCredential } from '../../../utils/hub-credential.js';
import { writePrivateJsonSync } from '../../../utils/private-file.js';

const PUBLIC_ROUTES = ['/rest/v2/ping', '/rest/v2/runtime/capabilities', '/rest/v2/auth/config'];

const envelope = payload => ({ status: 'success', statusCode: 200, payload });

/**
 * runtime.json `tls: { cert, key }` (PEM file paths) as Fastify https options,
 * or null. Optional: a reverse proxy usually terminates TLS in front.
 */
function httpsOptions(tls) {
  if (!tls) return null;
  if (!tls.cert || !tls.key) throw new Error('runtime.json tls needs both cert and key (PEM file paths)');
  return { cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) };
}

function equals(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {Object} options
 * @param {string} options.root - workspace folder (either layout)
 * @param {string} [options.name] - runtime name on first initialization
 * @param {string} [options.ownerId] - user id to host the workspace as; a hub
 *   passes the workspace owner so ids and ACL principals match on both sides
 * @param {Object} [options.inferd] - started InferdClient for embeddings
 * @param {Object} [options.runtimeDefaults] - extra fields for a new runtime.json
 * @param {boolean} [options.autoStart=true] - start the workspace when the host listens; false leaves it
 *   to the caller (a protected workspace needs its PIN/password)
 * @param {boolean} [options.requestLogging=true] - log every request; false when a hub in front logs them
 * @param {(token: string) => Promise<Object|null>} [options.verifyToken] - extra bearer tokens; a
 *   resolved resource binding becomes `request.resourceToken`
 * @param {() => Array<Object>} [options.hubKeys] - public keys of the hub supervising this process;
 *   keys of the hubs in runtime.json `remotes[].hub` are trusted as well
 * @param {(res: { type: string, id: string }) => boolean} [options.acceptsResource] - extra resources
 *   (other than this workspace) a hub credential may name
 * @param {() => Object} [options.describe] - extra fields for /runtime/capabilities and /runtime/status
 */
export async function createWorkspaceHost({ root, name, ownerId = null, inferd = null, runtimeDefaults = {},
  webRoot, logger = false, autoStart = true, requestLogging = true, verifyToken = null, hubKeys = () => [], acceptsResource = () => false, describe = () => ({}) } = {}) {
  if (!root) throw new Error('A workspace root folder is required');
  root = fs.realpathSync(root);
  const state = path.join(root, '.workspace');
  const runtimeFile = path.join(state, 'runtime.json');
  let config = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) : null;
  if (config && ownerId && config.userId !== ownerId) throw new Error(`${runtimeFile} belongs to another owner`);
  if (!config) {
    config = { version: 1, instanceId: randomUUID(), userId: ownerId || randomUUID(), kind: 'workspace',
      name: name || path.basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'local',
      token: `canvas-local-${randomBytes(32).toString('hex')}`,
      jwtSecret: randomBytes(32).toString('hex'), remotes: [], ...runtimeDefaults };
    writePrivateJsonSync(runtimeFile, config);
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(config.name)) throw new Error('Runtime name must be 1–100 lowercase letters, digits, dots, underscores or hyphens, beginning with a letter or digit');

  const user = { id: config.userId, email: 'local@canvas.local', name: 'Local owner', status: 'active', userType: 'user', homePath: state };
  const jim = new Jim({ rootPath: path.join(state, 'host'), driver: 'conf', driverOptions: { accessPropertiesByDotNotation: false } });
  const userIndex = jim.createIndex('users'); userIndex.set(user.id, user);
  const users = {
    indexStore: userIndex,
    list: async () => [user], get: async id => id === user.id || id === user.email ? user : null,
    resolveId: async id => id === user.id || id === user.email ? user.id : null,
    getUserPaths: () => ({ home: state, workspaces: path.join(state, 'workspaces'), agents: path.join(state, 'agents') }),
  };
  const workspaceManager = await new SingleWorkspaceManager({ rootPath: root, owner: user.id, users, name: config.name, inferd }).initialize();
  const workspaceId = workspaceManager.workspaceId;
  const entry = workspaceManager.getWorkspaceIndexEntry(workspaceId);
  const contextManager = new ContextManager({ indexFactory: jim, workspaceManager });
  await contextManager.initialize();

  const policyListeners = new Set();
  const https = httpsOptions(config.tls);
  const app = Fastify({ logger, disableRequestLogging: !requestLogging, bodyLimit: 1024 * 1024 * 1024, ignoreTrailingSlash: true, ...(https ? { https } : {}) });
  const mcp = installMcp(app);
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(socketIO, { transports: ['websocket'], maxHttpBufferSize: 1024 * 1024 });
  mcp.attachSocketIo(app.io);
  for (const [key, value] of Object.entries({ users, workspaceManager, contextManager,
    authService: { verifyApiToken: async value => equals(value, config.token) ? { userId: user.id } : null },
  })) app.decorate(key, value);
  app.decorate('broadcastToUser', (_id, event, payload) => app.io.emit(event, payload));
  app.decorate('broadcastToWorkspace', (id, event, payload) => app.io.to(`workspace:${id}`).emit(event, payload));
  app.decorate('broadcastToContext', (id, event, payload) => app.io.to(`context:${id}`).emit(event, payload));

  // Hubs whose credentials this runtime accepts: the one supervising it and
  // every hub it is attached to.
  const trustedKeys = () => [...hubKeys(), ...(config.remotes || []).flatMap(remote => remote.hub?.keys || [])];
  const authenticate = async (request, reply) => {
    const value = request.headers.authorization?.replace(/^Bearer /, '');
    request.user = user;
    if (equals(value, config.token)) return;
    if (isHubCredential(value)) {
      const claims = verifyHubCredential(value, { audience: config.instanceId, keys: trustedKeys() });
      const ours = claims?.res.type === 'workspace' && claims.res.id === workspaceId;
      if (!claims || !(ours || acceptsResource(claims.res))) return reply.code(401).send({ message: 'Invalid hub credential' });
      if (claims.device?.deviceId) {
        const { deviceId, name, platform, type } = claims.device;
        request.client = { deviceId, deviceName: name, deviceOs: platform, deviceType: type, registeredDevice: true };
      }
      if (ours && claims.binding) {
        request.resourceToken = claims.binding;
        if (claims.binding.type === 'workspace') {
          // The hub said who; this workspace's own ACL says what.
          const workspace = await workspaceManager.getWorkspace(workspaceId, user.id);
          const grant = claims.share ? shareKeyGrant(workspace.acl, claims.share) : resolveAclAccess(workspace.acl, claims.principal);
          if (!grant?.permissions?.includes('read')) return reply.code(403).send({ message: 'Workspace access revoked locally' });
          request.resourceToken = { ...claims.binding, permissions: grant.permissions };
        }
      }
      return;
    }
    const extra = verifyToken ? await verifyToken(value) : null;
    if (extra) { request.resourceToken = extra; return; }
    const share = workspaceManager.resolveWorkspaceShareToken(value);
    if (share) { request.resourceToken = { ...share, type: 'workspace' }; return; }
    return reply.code(401).send({ message: 'Valid local bearer token required' });
  };
  app.decorate('authenticate', authenticate); app.decorate('authenticateClient', authenticate);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    // Only the content route accepts media tickets; its onRequest validates
    // the cookie before the shared scope checks and document ACL checks run.
    const mediaContent = ['GET', 'HEAD'].includes(req.method)
      && /^\/rest\/v2\/workspaces\/[^/]+\/documents\/\d+\/content$/.test(url);
    if (url.startsWith('/rest/v2/') && !PUBLIC_ROUTES.includes(url) && !mediaContent) {
      await authenticate(req, reply);
      if (!reply.sent) await enforceWorkspaceTokenScope(req, reply);
      if (reply.sent) return;
    }
    if (req.method === 'DELETE' && /^\/rest\/v2\/(workspaces|agents)\/[^/]+\/?$/.test(url)) return reply.code(409).send({ message: 'Stop this runtime with canvas runtime stop; its local resource cannot be deleted through the API' });
    if (req.method === 'POST' && /^\/rest\/v2\/(workspaces|agents)\/?$/.test(url)) return reply.code(409).send({ message: 'This runtime hosts one workspace; initialize another folder for another runtime' });
  });
  app.addHook('preHandler', enforceWorkspaceTokenScope);
  app.addHook('onSend', async (req, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && reply.statusCode < 400) {
      const workspace = await workspaceManager.getWorkspace(workspaceId, user.id);
      await Promise.allSettled([...policyListeners].map(listener => listener(workspace.acl)));
    }
    reply.header('X-Source-Code', 'https://github.com/canvas-ui/canvas-common; license=AGPL-3.0-or-later');
  });
  app.get('/rest/v2/ping', async () => envelope({ name: 'Canvas local runtime', runtime: config.kind, api: API_VERSION }));
  app.get('/rest/v2/runtime/capabilities', async () => envelope({ local: true, auth: 'token', workspace: true, agent: false, api: API_VERSION, ...describe().capabilities }));
  app.get('/rest/v2/runtime/status', async () => envelope({ instanceId: config.instanceId, workspaceId, root, kind: config.kind, ...describe().status }));
  // Replace the local owner token; the old one and every socket opened with it stop working at once.
  app.post('/rest/v2/runtime/token', async (request, reply) => {
    if (!equals(request.headers.authorization?.replace(/^Bearer /, ''), config.token)) return reply.code(403).send({ message: 'The local owner token is required to rotate it' });
    config.token = `canvas-local-${randomBytes(32).toString('hex')}`;
    writePrivateJsonSync(runtimeFile, config);
    app.io.disconnectSockets(true);
    return envelope({ token: config.token });
  });
  app.get('/rest/v2/auth/config', async () => envelope({ allowUserRegistrations: false, strategies: { local: { enabled: false }, imap: { enabled: false, domains: [] } } }));
  app.post('/rest/v2/auth/logout', async () => envelope({ loggedOut: true }));
  app.get('/rest/v2/auth/me', async () => envelope(user));
  mountWorkspacesApi(app); mountContextsApi(app);
  app.register(schemaRoutes, { prefix: '/rest/v2/schemas' });
  app.register(webdavRoutes, { identify: authenticate, trustPrefixHeader: true });

  // Channels a socket may join: this workspace, and its contexts.
  const channels = [async (channel) => channel === `workspace:${workspaceId}` || channel === `workspace:${entry.name}`,
    async (channel) => channel?.startsWith('context:') && Boolean(await contextManager.getContext(user.id, channel.slice(8)))];
  app.io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!equals(token, config.token)) return next(new Error('Valid local bearer token required'));
    socket.user = user; socket.subscriptions = new Set(); next();
  });
  app.io.on('connection', socket => {
    registerWorkspace(app, socket); registerContext(app, socket);
    socket.on('subscribe', async ({ channel } = {}) => {
      try {
        for (const allows of channels) {
          if (!await allows(channel)) continue;
          socket.subscriptions.add(channel); socket.join(channel); socket.emit('subscribed', { channel });
          return;
        }
        socket.emit('error', { message: 'Unknown local resource' });
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
  let closeReason;
  app.addHook('onClose', async () => {
    await workspaceManager.stopWorkspace(workspaceId, user.id, { reason: closeReason });
    if (inferd?.stop) await inferd.stop();
  });
  const listening = new Set();
  return { app, config, runtimeFile, workspaceId, user, indexFactory: jim, workspaceManager, contextManager,
    /** Register an extra socket channel check (`async (channel) => boolean`). */
    allowChannel(allows) { channels.push(allows); },
    /** Called with the API base URL (and `{ socketPath }`) once the host listens. */
    onListening(listener) { listening.add(listener); },
    subscribePolicy(listener) { policyListeners.add(listener); return () => policyListeners.delete(listener); },
    /** Listen on TCP, or on a unix socket / named pipe when `path` is given (the caller prepares its directory). */
    async start({ host = '127.0.0.1', port = 0, path: socketPath = null } = {}) {
      let address = 'http://localhost';
      if (socketPath) {
        await app.listen({ path: socketPath });
        if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
      } else {
        await app.listen({ host, port });
        const bind = app.server.address().address;
        const localHost = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '[::1]' : bind.includes(':') ? `[${bind}]` : bind;
        address = `${https ? 'https' : 'http'}://${localHost}:${app.server.address().port}`;
      }
      for (const listener of listening) listener(address, { socketPath });
      if (autoStart) await workspaceManager.startWorkspace(workspaceId, user.id);
      return address;
    },
    save() { writePrivateJsonSync(runtimeFile, config); },
    /** `reason` is recorded as the workspace's lastStopReason ('server-restart' makes a hub start it again). */
    close: ({ reason } = {}) => { closeReason = reason; return app.close(); } };
}
