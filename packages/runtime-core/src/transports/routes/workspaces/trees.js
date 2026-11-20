'use strict';

import ResponseObject from '../../ResponseObject.js';
import * as arg from '../../mcp/args.js';
import { treeScopeBase } from '../../middleware/tree-scope.js';

export default async function workspaceTreesRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    if (treeScopeBase(request) && request.method !== 'GET') {
      return reply.code(403).send({ statusCode: 403, message: 'Tree management requires a workspace-wide binding' });
    }
  });

  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    return workspace;
  }

  fastify.get('/', {
    onRequest: [fastify.authenticate],
    config: { mcp: { name: 'tree_list', args: { ...arg.workspace } } },
    schema: { description: 'List the trees of a workspace with their name, id and type. There are three kinds. A context tree (type "context") is made of shared layers: /foo/bar/baz selects documents that are in foo AND bar AND baz, and filing under a path ticks every layer on it. A directory tree (type "directory") has filesystem-like folders with exact membership; a recursive listing adds the descendant folders. Both are virtual trees: the user, you or automation rules decide what is filed where. The backends tree (name "backends", type "directory") is different: it mirrors what each backend holds (a local folder, an S3 bucket, a mail account, a GitHub or Slack connection, ...) under /<driver>/<address>/..., one node per folder, mailbox or channel, and is kept up to date by sync. Read it to see what arrived from a source; file into a virtual tree, never into backends. A document from a backend shows up in a virtual tree only once it is linked there (document_link, or a rule).' },
  }, async (request, reply) => {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) return reply;
    const available = await workspace.listTrees(request.query?.type || null);
    const trees = treeScopeBase(request) ? available.filter(tree => tree.id === workspace.getTree().id) : available;
    const count = Array.isArray(trees) ? trees.length : 0;
    const responseObject = new ResponseObject().found(trees, 'Trees retrieved successfully', 200, count, count);
    return reply.code(responseObject.statusCode).send(responseObject.getResponse());
  });

  fastify.post('/', {
    onRequest: [fastify.authenticate],
    config: { mcp: {
      name: 'tree_create',
      description: 'Create an additional tree in a workspace. Type "context" makes a tree of shared layers where a path selects the intersection of its segments; "directory" makes filesystem-like folders with exact membership. Every workspace already has a default tree of each type; to add a folder or context path to an existing tree use path_create.',
      args: { ...arg.workspace, name: { description: 'Name of the new tree.' } },
    } },
    schema: {
      body: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['context', 'directory'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      const tree = await workspace.createTree(request.body.name, request.body.type);
      const responseObject = new ResponseObject().created(tree, 'Tree created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to create tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.patch('/:treeNameOrTreeId', {
    onRequest: [fastify.authenticate],
    config: { mcp: {
      name: 'tree_rename',
      description: 'Rename a whole tree. The built-in trees cannot be renamed. To rename a folder or context path inside a tree use path_rename.',
      args: { ...arg.workspace, ':treeNameOrTreeId': { name: 'tree', description: 'Current tree name or id, from tree_list.' }, name: { description: 'New tree name.' } },
    } },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      const tree = await workspace.renameTree(request.params.treeNameOrTreeId, request.body.name);
      const responseObject = new ResponseObject().success(tree, 'Tree renamed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = /reserved tree/i.test(error.message || '')
        ? new ResponseObject().conflict(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to rename tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.delete('/:treeNameOrTreeId', {
    onRequest: [fastify.authenticate],
    config: { mcp: {
      name: 'tree_delete',
      description: 'Delete a whole tree and every path in it. Documents stay in the workspace and in other trees. The built-in trees cannot be deleted. To remove one path use path_delete.',
      args: { ...arg.workspace, ':treeNameOrTreeId': { name: 'tree', description: 'Tree name or id, from tree_list.' } },
    } },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      await workspace.destroyTree(request.params.treeNameOrTreeId);
      const responseObject = new ResponseObject().deleted(true, 'Tree deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = /reserved tree/i.test(error.message || '')
        ? new ResponseObject().conflict(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to delete tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
