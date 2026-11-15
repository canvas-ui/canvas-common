'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { resolveContextAddress } from '../../middleware/address-resolver.js';

const contextArg = { ':id': { name: 'context', description: 'Context id, from context_list.' } };

export default async function lifecycleRoutes(fastify, _options) {
  // Add a pre-handler hook to ensure user is authenticated and valid for all context document routes
  fastify.addHook('preHandler', async (request, reply) => {
    try {
      // The `authenticate` hook should have already run and populated `request.user`
      // We just need to validate it has the required fields for our operations.
      validateUser(request.user, ['id']); // For context operations, we primarily need the user's ID.
    } catch (err) {
      // If validateUser throws, it means the user object is invalid.
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Lifecycle routes will be added here

  // List all contexts
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    config: { mcp: {
      name: 'context_list',
      description: 'List the user\'s contexts. A context is a named, movable pointer to one tree path of one workspace (its url, e.g. universe://work/projects); apps, devices and mounts bound to a context follow it when the url changes. Contexts are not tree paths: to browse or edit paths use path_list and the path tools.',
    } },
  }, async (request, reply) => {

    try {
      const contexts = await fastify.contextManager.listUserContexts(request.user.id);

      // Return consistent ResponseObject format
      const response = new ResponseObject();
      return reply.code(200).send(response.found(contexts, 'Contexts retrieved successfully', 200, contexts.length).getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to list contexts');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create new context
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    config: { mcp: {
      name: 'context_create',
      description: 'Create a context: a named pointer to a tree path of a workspace that clients can bind to and follow.',
      args: { id: { description: 'Id for the new context, e.g. work. It is normalized (lowercased, spaces removed); use the id returned in the answer afterwards.' }, workspaceId: { name: 'workspace', description: 'Workspace name or id the context points into. Not needed when url names it.' } },
      only: ['id', 'name', 'url', 'description', 'workspaceId'],
    } },
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: "User-defined ID for the new context. This will be sanitized." },
          name: { type: 'string', description: "Human-readable display name for the context." },
          url: { type: 'string', description: "The URL for the new context (e.g., universe://my-context-name). Defaults to '/' if not provided." },
          baseUrl: { type: 'string' },
          description: { type: 'string' },
          workspaceId: { type: 'string' },
          treeType: { type: 'string', enum: ['context', 'directory'] },
          treeId: { type: 'string' },
          metadata: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.createContext(
        request.user.id,
        request.body.url || '/',
        {
          id: request.body.id,
          name: request.body.name || null,
          userId: request.user.id,
          workspaceId: request.body.workspaceId,
          description: request.body.description || '',
          metadata: request.body.metadata,
          baseUrl: request.body.baseUrl,
          treeType: request.body.treeType,
          treeId: request.body.treeId,
        }
      );

      const response = new ResponseObject().created({ context }, 'Context created successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = error.code === 'WORKSPACE_STOPPED' ? ResponseObject.fromError(error) : new ResponseObject().error('Failed to create context', error.message);
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context by ID
  // Note: The prefix for this group is '/', so this becomes GET /:id
  fastify.get('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    config: { mcp: {
      name: 'context_get',
      description: 'Get one context: the workspace and tree path it currently points at (url), its saved filters and settings.',
      args: contextArg,
    } },
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);

      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID '${request.params.id}' not found or not accessible.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responsePayload = context.toJSON({ includeLive: true });

      // Include resource address if it was resolved from user/resource format
      if (request.originalAddress) {
        responsePayload.resourceAddress = request.originalAddress;
      } else {
        // Try to construct resource address from context data
        try {
          const resourceAddress = await fastify.contextManager.constructResourceAddress(context);
          if (resourceAddress) {
            responsePayload.resourceAddress = resourceAddress;
          }
        } catch  {
          // Ignore errors in address construction
        }
      }

      const response = new ResponseObject().success(responsePayload, 'Context retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      // Malformed shared-context identifier is an input error (400), distinct
      // from the coded access/not-found/not-ready errors fromError handles.
      if (error.message.includes('Invalid shared context identifier format') || error.message.includes('Expected ')) {
        const response = new ResponseObject().badRequest(
          `Invalid context ID format for this endpoint. If you need to disambiguate a shared context, use ?ownerId=<ownerUserId>.`
        );
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = ResponseObject.fromError(error, 'Failed to get context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context URL
  // Note: The prefix for this group is '/', so this becomes GET /:id/url
  fastify.get('/:id/url', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ url: context.url }, 'Context URL retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context URL');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Set context URL
  // Note: The prefix for this group is '/', so this becomes POST /:id/url
  fastify.post('/:id/url', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    config: { mcp: {
      name: 'context_set_url',
      description: 'Point a context at another tree path or workspace. Everything bound to the context (apps, browser tabs, mounts) switches to the new location. A path that does not exist yet is created.',
      args: { ...contextArg, url: { description: 'New location: workspace://path, e.g. universe://work/projects, or a bare path such as /work/projects to stay in the same workspace.' }, treeName: { name: 'tree', description: 'Tree the path is in. Omit for the default context tree.' } },
    } },
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          treeName: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await context.setUrl(request.body.url, { treeName: request.body.treeName });
      const response = new ResponseObject().success({ url: context.url, treeId: context.treeId }, 'Context URL updated successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error(`Failed to set context URL: ${error.message}`);
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context path
  // Note: The prefix for this group is '/', so this becomes GET /:id/path
  fastify.get('/:id/path', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ path: context.path }, 'Context path retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context path array
  // Note: The prefix for this group is '/', so this becomes GET /:id/path-array
  fastify.get('/:id/path-array', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ pathArray: context.pathArray }, 'Context path array retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context path array');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update context
  // Note: The prefix for this group is '/', so this becomes PUT /:id
  fastify.put('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          order: { type: 'number' },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          restApi: { type: 'object' },
          // Stored query binding (server-enforced filters bound clients inherit).
          features: { type: 'object' },
          filters: { type: 'array', items: { type: 'string' } },
          queryOptions: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.updateContext(
        request.user.id,
        request.params.id,
        request.body
      );

      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().updated({ context }, 'Context updated successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to update context');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete context
  // Note: The prefix for this group is '/', so this becomes DELETE /:id
  fastify.delete('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
    config: { mcp: {
      name: 'context_delete',
      description: 'Delete a context. Only the pointer is removed; the workspace, its tree paths and documents are untouched.',
      args: contextArg,
    } },
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const success = await fastify.contextManager.removeContext(request.user.id, request.params.id);
      if (!success) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().deleted(null, 'Context deleted successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to delete context');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
