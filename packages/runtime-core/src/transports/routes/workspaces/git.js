'use strict';

import GitRepositories from '../../../core/workspace/services/git/GitRepositories.js';
import WorkspaceGitRepo from '../../../core/workspace/services/git/WorkspaceGitRepo.js';
import { parseBasicAuth } from '../../lib/basic-auth.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Git HTTP backend for named repositories (Git/<repo>/.git on disk).
 * Mounted at /workspaces/:id/git/:repo/*.
 */

async function convertBasicAuthToBearer(request, reply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      // `return reply` — a bare return here lets the chain continue to
      // fastify.authenticate, which replies a second time and throws
      // ERR_HTTP_HEADERS_SENT as an unhandled rejection.
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="Canvas Git"').send({
        status: 'error',
        statusCode: 401,
        message: 'Authentication required',
        payload: null,
        count: null,
      });
    }
    // git sends its credential over Basic; every strategy downstream speaks
    // Bearer. The password is promoted whatever it looks like: this route has
    // no password-login path, so a value that is not a token simply fails
    // authentication one step later, exactly as it did before. Requiring a
    // `canvas-` prefix here rejected the JWT that `remote login` stores, which
    // made `canvas dot add/clone/push/pull` fail with "Authentication failed"
    // unless the user happened to have swapped in an API token.
    const basic = parseBasicAuth(authHeader);
    if (basic?.password) {
      request.headers.authorization = `Bearer ${basic.password}`;
    }
  } catch (error) {
    console.error('Error in convertBasicAuthToBearer middleware:', error);
  }
}

export default async function workspaceGitRoutes(fastify) {
  fastify.addContentTypeParser('application/x-git-receive-pack-request', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  fastify.addContentTypeParser('application/x-git-upload-pack-request', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const handle = async (request, reply, service) => {
    try {
      const repositories = new GitRepositories(request.workspace.gitPath);
      const repoPath = await repositories.checkedPath(request.params.repo);
      const repo = new WorkspaceGitRepo({ repoPath });
      if (service === 'git-receive-pack' || request.query?.service === 'git-receive-pack') {
        const descriptor = (await repositories.list()).find(r => r.name === request.params.repo);
        if (descriptor?.type === 'remote') return reply.code(403).send('Push remote repositories to their upstream remote');
      }
      return await repo.serveHttp(service, request, reply);
    } catch (error) {
      if (error?.code === 'ENOENT') return reply.code(404).send('Repository not found');
      if (error?.statusCode) return reply.code(error.statusCode).send(error.message);
      if (error?.code === 'EGITNOREPO') {
        // git reads stderr from the transport, so say what to do about it.
        return reply.code(404).send(
          'No git repository in this workspace yet — initialize it first (canvas dot init).',
        );
      }
      fastify.log.error(error);
      if (reply.sent) return reply;
      return reply.code(500).send('Internal server error');
    }
  };

  // Named repositories.
  fastify.get('/', { onRequest: [fastify.authenticate, requireWorkspaceRead()] }, async (request) => {
    return { status: 'success', payload: await new GitRepositories(request.workspace.gitPath).list() };
  });
  fastify.post('/', { onRequest: [fastify.authenticate, requireWorkspaceWrite()] }, async (request, reply) => {
    try {
      const result = await request.workspace.addBackend('git', request.body || {});
      return reply.code(201).send({ status: 'success', payload: result });
    } catch (error) { return reply.code(error.statusCode || 400).send({ message: error.message }); }
  });
  fastify.get('/:repo/branches', { onRequest: [fastify.authenticate, requireWorkspaceRead()] }, async (request) => ({
    status: 'success', payload: await new GitRepositories(request.workspace.gitPath).branches(request.params.repo),
  }));
  for (const service of ['info/refs', 'git-upload-pack', 'git-receive-pack']) {
    fastify.route({
      method: service === 'info/refs' ? 'GET' : 'POST',
      url: `/:repo/${service}`,
      onRequest: [convertBasicAuthToBearer, fastify.authenticate, service === 'git-receive-pack' ? requireWorkspaceWrite() : requireWorkspaceRead()],
      bodyLimit: 67108864,
      handler: (request, reply) => handle(request, reply, service),
    });
  }
}
