import { workspaceErrorResponse } from '../../../core/workspace/lib/errors.js';
'use strict';

import lifecycleRoutes from './lifecycle.js';
import documentRoutes from './documents.js';
import treeRoutes from './tree.js';
import tokenRoutes from './tokens.js';
import shareRoutes from './shares.js';
import rulesRoutes from './rules.js';
import { resolveContextAddress } from '../../middleware/address-resolver.js';

/**
 * Context routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function contextRoutes(fastify, _options) {
  // Preserve the stopped contract before individual handlers translate errors.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.id || !request.params?.id) return;
    try { await fastify.contextManager.getContext(request.user.id, request.params.id); }
    catch (error) {
      if (error.code === 'WORKSPACE_STOPPED') return reply.code(423).send(workspaceErrorResponse(error));
      // The route owns not-found, permission, and auto-create semantics.
    }
  });
  fastify.register(lifecycleRoutes, { prefix: '/' });
  fastify.register(documentRoutes, {
    prefix: '/:id/documents',
    onRequest: [resolveContextAddress]
  });
  fastify.register(import('./blobs.js'), {
    prefix: '/:id/blobs',
    onRequest: [resolveContextAddress]
  });
  fastify.register(import('./dotfiles.js'), {
    prefix: '/:id/dotfiles',
    onRequest: [resolveContextAddress]
  });

  fastify.register(treeRoutes, {
    prefix: '/:id/tree',
    onRequest: [resolveContextAddress]
  });

  fastify.register(treeRoutes, {
    prefix: '/:id/trees/default',
    onRequest: [resolveContextAddress]
  });

  fastify.register(tokenRoutes, {
    prefix: '/',
    onRequest: [resolveContextAddress]
  });

  fastify.register(shareRoutes, {
    prefix: '/',
    onRequest: [resolveContextAddress]
  });

  fastify.register(rulesRoutes, {
    prefix: '/',
    onRequest: [resolveContextAddress]
  });
}
