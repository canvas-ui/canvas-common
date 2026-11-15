import { requireWorkspaceRead, requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';
import { emailListPreview } from '../../../runtimes/workspace/connectors/imap/content.js';
import * as arg from '../../mcp/args.js';

export default async function messageRoutes(app) {
    const fail = (reply, error) => reply.code(error.statusCode || 400).send({ status: 'error', message: error.message });
    app.get('/accounts', {
        onRequest: [app.authenticate, requireWorkspaceRead()],
        config: { mcp: {
            name: 'message_account_list',
            description: 'List the e-mail, Slack and WhatsApp accounts connected to a workspace and whether sending through each is enabled. Call it before message_send to pick the account (driver and address).',
            args: { ...arg.workspace },
        } },
    }, async (request) => ({
        status: 'success', payload: await request.workspace.messagingAccounts(),
    }));
    app.get('/thread/:docId', { onRequest: [app.authenticate, requireWorkspaceRead()] }, async (request, reply) => {
        try {
            const binding = request.resourceToken;
            if (binding && binding.type !== 'agent') return reply.code(403).send({ status: 'error', message: 'Share tokens cannot browse message threads' });
            const thread = await request.workspace.messageThread(request.params.docId, {
                contextPath: binding?.type === 'agent' && binding.basePath && binding.basePath !== '/' ? binding.basePath : null,
            });
            return { status: 'success', payload: { ...thread, documents: thread.documents.map(emailListPreview) } };
        } catch (error) { return fail(reply, error); }
    });
    app.get('/reply-target/:docId', { onRequest: [app.authenticate, requireWorkspaceRead()] }, async (request, reply) => {
        try {
            const id = Number(request.params.docId);
            if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid document ID');
            const binding = request.resourceToken;
            if (binding?.type === 'agent' && binding.basePath && binding.basePath !== '/') {
                const ids = await request.workspace.list({ context: binding.basePath, ids: [id], idsOnly: true, limit: 1 });
                if (!ids.includes(id)) return reply.code(403).send({ status: 'error', message: 'Message is outside the agent scope' });
            }
            return { status: 'success', payload: await request.workspace.messageReplyTarget(id) };
        } catch (error) { return fail(reply, error); }
    });
    app.get('/:driver/:address/connection', { onRequest: [app.authenticate, requireWorkspaceAdmin()] }, async (request, reply) => {
        if (request.resourceToken) return reply.code(403).send({ status: 'error', message: 'Device pairing requires a user account' });
        try { return { status: 'success', payload: await request.workspace.messageConnection(request.params.driver, request.params.address) }; }
        catch (error) { return fail(reply, error); }
    });
    app.delete('/:driver/:address/connection', { onRequest: [app.authenticate, requireWorkspaceAdmin()] }, async (request, reply) => {
        if (request.resourceToken) return reply.code(403).send({ status: 'error', message: 'Device pairing requires a user account' });
        try { return { status: 'success', payload: await request.workspace.messageConnection(request.params.driver, request.params.address, true) }; }
        catch (error) { return fail(reply, error); }
    });
    app.get('/outbox/:requestId', {
        onRequest: [app.authenticate, requireWorkspaceWrite()],
        config: { mcp: {
            name: 'message_send_status',
            description: 'Check what happened to an earlier message_send by its requestId, without sending anything. Use it after a timeout or an unclear answer instead of sending again.',
            args: { ...arg.workspace, ':requestId': { description: 'The requestId that was passed to message_send.' } },
        } },
    }, async (request, reply) => {
        if (request.resourceToken && request.resourceToken.type !== 'agent') return reply.code(403).send({ status: 'error', message: 'Share tokens cannot access the outbox' });
        try { return { status: 'success', payload: await request.workspace.messageSendStatus(request.params.requestId, request.resourceToken?.agentId || request.user.id) }; }
        catch (error) { return fail(reply, error); }
    });
    app.post('/send', {
        onRequest: [app.authenticate, requireWorkspaceWrite()],
        bodyLimit: 12 * 1024 * 1024,
        config: {
            rateLimit: { max: 20, timeWindow: '1 minute' },
            mcp: {
                name: 'message_send',
                description: 'Send a message to people outside Canvas through a connected e-mail, Slack or WhatsApp account, or reply to a message document. This communicates externally as that account, so use it only when the user asked for it. For a new message give driver, address and the recipients (to for e-mail, target for Slack and WhatsApp); for a reply give replyToDocumentId and the account and thread are resolved for you. "accepted" in the answer means the provider took the message, not that it was delivered.',
                args: {
                    ...arg.workspace,
                    requestId: { description: 'A new UUID for this message. After a timeout or error, retry with the same requestId so the message is not sent twice.' },
                    text: { description: 'Plain-text message body.' },
                    replyToDocumentId: { description: 'Id of the e-mail or chat message document to reply to.' },
                    driver: { description: 'Account type, from message_account_list. Omit for a reply.' },
                    address: { description: 'Account address or label, from message_account_list. Omit for a reply.' },
                    target: { description: 'Slack channel name or id, or WhatsApp conversation id. Omit for e-mail and for a reply.' },
                    files: { description: 'Attach stored files: [{ documentId }], or one attachment of an e-mail document with attachmentIndex.' },
                    quote: { description: 'E-mail replies: quote the original message below the text.' },
                    forward: { description: 'E-mail: forward the message in replyToDocumentId to new recipients.' },
                    html: { description: 'E-mail: HTML body sent alongside text.' },
                },
                only: ['requestId', 'text', 'html', 'replyToDocumentId', 'replyAll', 'quote', 'forward', 'driver', 'address', 'target', 'to', 'cc', 'bcc', 'subject', 'files'],
            },
        },
        schema: { body: {
            type: 'object', required: ['requestId', 'text'], additionalProperties: false,
            properties: {
                requestId: { type: 'string', pattern: '^[\\w-]{16,128}$' },
                // Empty only for a forward without a note (checked in the service).
                text: { type: 'string', maxLength: 32000 },
                files: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['documentId'], properties: {
                    documentId: { type: 'integer', minimum: 1 }, attachmentIndex: { type: 'integer', minimum: 0 },
                } } },
                images: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['mimeType', 'base64'], properties: { name: { type: 'string', maxLength: 200 }, mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }, base64: { type: 'string', maxLength: 11184812 } } } },
                html: { type: 'string', maxLength: 512000 },
                quote: { type: 'boolean' }, forward: { type: 'boolean' },
                driver: { type: 'string', enum: ['imap', 'slack', 'whatsapp'] }, address: { type: 'string', maxLength: 256 },
                target: { type: 'string', maxLength: 256 }, replyToDocumentId: { type: 'integer', minimum: 1 },
                subject: { type: 'string', maxLength: 998 }, replyAll: { type: 'boolean' },
                ...Object.fromEntries(['to', 'cc', 'bcc'].map((k) => [k, { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 320 } }])),
            },
        } },
    }, async (request, reply) => {
        // A document/workspace share does not grant use of an account identity.
        if (request.resourceToken && request.resourceToken.type !== 'agent') return reply.code(403).send({ status: 'error', message: 'Share tokens cannot send messages' });
        try {
            const binding = request.resourceToken;
            const result = await request.workspace.sendMessage(request.body, {
                id: binding?.agentId || request.user.id,
                isAgent: binding?.type === 'agent', basePath: binding?.basePath || '/',
            });
            return { status: 'success', payload: result };
        } catch (error) { return fail(reply, error); }
    });
}
