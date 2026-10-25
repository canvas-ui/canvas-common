import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { readPolicyConfig, writePolicies, blobBackendName } from '../../../runtimes/workspace/storage/policies/index.js';

export default async function storagePoliciesRoutes(fastify) {
    const send = (reply, data, message) => {
        const response = new ResponseObject().success(data, message);
        return reply.code(response.statusCode).send(response.getResponse());
    };
    const fail = (reply, error) => reply.code(error.statusCode || 500).send({ error: error.message, code: error.code });
    const listing = workspace => ({ ...readPolicyConfig(workspace), blobBackend: blobBackendName(workspace),
        capabilities: Object.fromEntries(Object.keys(workspace.dataBackends).map(name => [name, workspace.storageOperations?.capabilities(name) || null])),
        status: workspace.storagePolicyService?.status() || { state: 'unavailable' } });
    fastify.get('/', { onRequest: [fastify.authenticate, requireWorkspaceRead()] }, async (request, reply) => {
        try { return send(reply, listing(request.workspace), 'Storage policies retrieved'); }
        catch (error) { return fail(reply, error); }
    });
    fastify.put('/', { onRequest: [fastify.authenticate, requireWorkspaceWrite()] }, async (request, reply) => {
        try {
            if (!request.workspace.storageOperations) throw Object.assign(new Error('Stored replication service is unavailable'), { statusCode: 503 });
            await writePolicies(request.workspace, request.body?.policies, request.body?.revision);
            request.workspace.storagePolicyService.schedule();
            return send(reply, listing(request.workspace), 'Storage policies saved; replication is asynchronous');
        } catch (error) { return fail(reply, error); }
    });
    fastify.post('/:policyId/apply', { onRequest: [fastify.authenticate, requireWorkspaceWrite()] }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!readPolicyConfig(workspace).policies.some(p => p.id === request.params.policyId)) throw Object.assign(new Error('Policy not found'), { statusCode: 404 });
            if (!workspace.storagePolicyService) throw Object.assign(new Error('Stored replication service is unavailable'), { statusCode: 503 });
            // The completion barrier includes every matching policy, including
            // overlapping targets; a single-policy backfill must not evict early.
            return send(reply, await workspace.storagePolicyService.reconcile({ dryRun: request.body?.dryRun === true }), 'Policy placement planned');
        } catch (error) { return fail(reply, error); }
    });
    fastify.post('/operations/:operationId/retry', { onRequest: [fastify.authenticate, requireWorkspaceWrite()] }, async (request, reply) => {
        try { return send(reply, await request.workspace.storageOperations.retry(request.params.operationId), 'Operation retried'); }
        catch (error) { return fail(reply, error); }
    });
}
