'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Workspace Services Routes
 *
 * Manages workspace service configuration and lifecycle
 */
// Storage/connector backend routes live in ./backends.js (/:id/backends).
export default async function workspaceServicesRoutes(fastify, _options) {
    /**
     * List all services and their status
     */
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()]
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const servicesStatus = await fastify.workspaceManager.getServicesStatus(workspace.id, request.user.id);

            const response = new ResponseObject().success(servicesStatus);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Enable a service
     */
    fastify.post('/:serviceName/enable', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.enableService(workspace.id, request.user.id, serviceName);

            const response = new ResponseObject().success({
                message: `Service ${serviceName} enabled successfully`,
                result
            });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Disable a service
     */
    fastify.post('/:serviceName/disable', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.disableService(workspace.id, request.user.id, serviceName);

            const response = new ResponseObject().success({
                message: `Service ${serviceName} disabled successfully`,
                result
            });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}
