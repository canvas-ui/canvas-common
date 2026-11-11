'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Trash: the "Recently deleted" list over trashed documents and every file
 * backend's Trash (`items`), and the source-removal review queue
 * (`operations`). See docs/backend-removals.md.
 */
export default async function workspaceTrashRoutes(fastify) {
  async function getWorkspaceInstance(request, reply) {
    const workspace = request.workspace;
    if (!workspace?.isActive) {
      const r = new ResponseObject().workspaceNotActive();
      reply.code(r.statusCode).send(r.getResponse()); return null;
    }
    return workspace;
  }

  fastify.get('/operations', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: { querystring: { type: 'object', properties: {
      view: { type: 'string', enum: ['pending', 'trashed', 'activity'] }, backend: { type: 'string' }, search: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 },
    } } },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply); if (!workspace) return reply;
      const result = await workspace.trashOperations.list(request.query || {});
      return reply.send(new ResponseObject().success(result, 'Trash operations retrieved').getResponse());
    } catch (error) { return reply.code(error.statusCode || 500).send({ error: error.message }); }
  });
  fastify.post('/operations/:action', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: { body: { type: 'object', required: ['ids'], additionalProperties: false, properties: {
      ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string' } },
      targets: { type: 'array', maxItems: 200, items: { type: 'string' } }, membership: { type: 'boolean' },
    } } },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply); if (!workspace) return reply;
      const result = await workspace.trashOperations.act(request.body.ids, request.params.action, request.body);
      return reply.send(new ResponseObject().success(result, 'Trash operations updated').getResponse());
    } catch (error) { return reply.code(error.statusCode || 500).send({ error: error.message }); }
  });

  // Recently deleted: one list over the document Trash and every file
  // backend's Trash, with one expiry.
  const itemIdsBody = { type: 'object', required: ['ids'], additionalProperties: false, properties: {
    ids: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: { type: 'string', maxLength: 512 } },
  } };
  fastify.get('/items', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: { querystring: { type: 'object', properties: {
      search: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 }, offset: { type: 'integer', minimum: 0 },
    } } },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply); if (!workspace) return reply;
      const result = await workspace.listDeleted(request.query || {});
      return reply.send(new ResponseObject().success(result, 'Deleted items retrieved').getResponse());
    } catch (error) { return reply.code(error.statusCode || 500).send({ error: error.message }); }
  });
  for (const [action, method] of [['restore', 'restoreDeleted'], ['discard', 'discardDeleted']]) {
    fastify.post(`/items/${action}`, {
      onRequest: [fastify.authenticate, requireWorkspaceWrite()],
      schema: { body: itemIdsBody },
    }, async (request, reply) => {
      try {
        const workspace = await getWorkspaceInstance(request, reply); if (!workspace) return reply;
        const result = await workspace[method](request.body.ids);
        return reply.send(new ResponseObject().success(result, 'Deleted items updated').getResponse());
      } catch (error) { return reply.code(error.statusCode || 500).send({ error: error.message }); }
    });
  }
}
