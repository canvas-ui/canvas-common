import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

export default async function capturedRoutes(fastify) {
    const options = { onRequest: [fastify.authenticate, requireWorkspaceAdmin()] };
    const handle = (action) => async (request, reply) => {
        let response;
        try { response = ResponseObject.success(await action(request.workspace, request.body)); }
        catch (error) {
            response = [502, 504].includes(error.statusCode)
                ? ResponseObject.error(error.message, null, error.statusCode)
                : ResponseObject.fromError(error, 'Website capture request failed');
        }
        return reply.header('Cache-Control', 'no-store').code(response.statusCode).send(response.getResponse());
    };
    fastify.get('/config', options, handle(workspace => workspace.getCaptureConfig()));
    fastify.put('/config', options, handle((workspace, body) => workspace.saveCaptureConfig(body)));
    fastify.post('/test', options, handle(workspace => workspace.checkCaptureService()));
}
