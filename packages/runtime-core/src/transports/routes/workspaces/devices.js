'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

// The workspace's own device records (see runtime db/WorkspaceDevices.js).
function serializeDeviceDocument(document) {
  return {
    id: document.id,
    ...(document.data || {}),
  };
}

export default async function workspaceDeviceRoutes(fastify, _options) {
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const documents = await request.workspace.devices.list({
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
      });

      const devices = (documents || []).map(serializeDeviceDocument);
      const response = new ResponseObject().found(
        devices,
        'Workspace devices retrieved successfully',
        200,
        devices.length,
        documents?.totalCount ?? devices.length
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace devices');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/:deviceId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'deviceId'],
        properties: {
          id: { type: 'string' },
          deviceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const document = await request.workspace.devices.find(request.params.deviceId);
      if (!document) {
        const response = new ResponseObject().notFound('Workspace device not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(
        serializeDeviceDocument(document),
        'Workspace device retrieved successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to get workspace device');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.post('/', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
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
        required: ['devices'],
        properties: {
          devices: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['deviceId'],
              properties: {
                deviceId: { type: 'string', minLength: 1 },
                name: { type: 'string' },
                description: { type: 'string' },
                platform: { type: 'string' },
                arch: { type: 'string' },
                type: { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const linked = [];
      for (const device of request.body.devices) {
        const result = await request.workspace.devices.ensure(device);
        linked.push({ id: result.id, created: result.created, ...result.data });
      }

      const response = new ResponseObject().created(linked, 'Workspace devices linked successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to link workspace devices');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/:deviceId', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'deviceId'],
        properties: {
          id: { type: 'string' },
          deviceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const deviceId = String(request.params.deviceId || '').trim();
      if (!deviceId) {
        const response = new ResponseObject().badRequest('deviceId is required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const deleted = await request.workspace.devices.remove(deviceId);
      if (!deleted) {
        const response = new ResponseObject().notFound('Workspace device not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(
        { deviceId, deleted },
        'Workspace device unlinked successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to unlink workspace device');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
