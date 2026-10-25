'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { env } from '../../../env.js';

// Resumable uploads (runtimes/workspace/storage/WorkspaceUploads.js):
//
//   POST   /uploads        { size, sha256?, fingerprint?, target? }  → session (201; 200 when resuming)
//   GET    /uploads/:uid   → session: { offset, state, result?, error? }
//   PATCH  /uploads/:uid   Upload-Offset: <n>, raw bytes → session
//   DELETE /uploads/:uid   → cancel
//
// target: { type: 'blob' } (default) or { type: 'object', driver, address,
// key, ifMatch?, ifNoneMatch?, mtime?, mimeType? }. `fingerprint` (e.g.
// name:size:mtime) lets a client resume without hashing first; the server
// hashes what it receives. After a dropped PATCH,
// GET the session and continue from its offset. When offset reaches size the
// target is written in the background; poll GET until state is `complete`
// (result) or `failed` (error; `retryable` ones resume with an empty PATCH).

const params = { type: 'object', required: ['id', 'uid'], properties: { id: { type: 'string' }, uid: { type: 'string' } } };

function send(reply, response) {
  return reply.code(response.statusCode).send(response.getResponse());
}

function fail(request, reply, error) {
  const statusCode = Number(error?.statusCode) || 500;
  if (statusCode >= 500) request.log.error(error);
  const payload = error?.offset !== undefined ? { offset: error.offset } : (error?.session ?? (error?.limit ? { limit: error.limit } : null));
  const response = new ResponseObject().error(error?.message || 'Upload failed', payload, statusCode);
  if (error?.code) response.code = error.code;
  return send(reply, response);
}

function activeWorkspace(request, reply) {
  if (request.workspace?.isActive) return request.workspace;
  send(reply, new ResponseObject().workspaceNotActive());
  return null;
}

export default async function uploadRoutes(fastify) {
  fastify.addContentTypeParser('application/offset+octet-stream', { bodyLimit: env.uploads.maxBytes }, (_req, payload, done) => done(null, payload));
  fastify.addContentTypeParser('application/octet-stream', { bodyLimit: env.uploads.maxBytes }, (_req, payload, done) => done(null, payload));

  fastify.post('/', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['size'],
        properties: {
          size: { type: 'integer', minimum: 0 },
          sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          fingerprint: { type: 'string', maxLength: 512 },
          target: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const workspace = activeWorkspace(request, reply);
    if (!workspace) return reply;
    try {
      const session = await workspace.uploads.create(request.body);
      const resumed = session.offset > 0 || session.state !== 'open';
      return send(reply, resumed ? new ResponseObject().found(session, 'Upload resumed') : new ResponseObject().created(session, 'Upload created'));
    } catch (error) { return fail(request, reply, error); }
  });

  fastify.get('/:uid', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: { params },
  }, async (request, reply) => {
    const workspace = activeWorkspace(request, reply);
    if (!workspace) return reply;
    try {
      return send(reply, new ResponseObject().found(await workspace.uploads.get(request.params.uid), 'Upload status'));
    } catch (error) { return fail(request, reply, error); }
  });

  fastify.patch('/:uid', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    bodyLimit: env.uploads.maxBytes,
    schema: { params },
  }, async (request, reply) => {
    const workspace = activeWorkspace(request, reply);
    if (!workspace) return reply;
    const offset = Number(request.headers['upload-offset']);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return send(reply, new ResponseObject().badRequest('Upload-Offset header is required'));
    }
    try {
      const body = request.body ?? request.raw;
      return send(reply, new ResponseObject().success(await workspace.uploads.append(request.params.uid, offset, body), 'Upload appended'));
    } catch (error) { return fail(request, reply, error); }
  });

  fastify.delete('/:uid', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: { params },
  }, async (request, reply) => {
    const workspace = activeWorkspace(request, reply);
    if (!workspace) return reply;
    try {
      await workspace.uploads.cancel(request.params.uid);
      return send(reply, new ResponseObject().success(true, 'Upload cancelled'));
    } catch (error) { return fail(request, reply, error); }
  });
}
