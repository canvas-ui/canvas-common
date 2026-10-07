import { messageImages } from './images.js';
import { createLogger } from '../../../../utils/log.js';
import path from 'node:path';
import { normalizeSegment } from '../../../../utils/backend-documents.js';
import { prepareEmail, deliverEmail } from './email.js';
import { sendOnce, messageError } from './outbox.js';

export function sourceAccount(doc) {
    if (!doc) return null;
    if (doc.metadata?.connector && /^(slack|whatsapp):/.test(doc.metadata.connector)) {
        const [driver, ...parts] = doc.metadata.connector.split(':');
        return { driver, address: parts.join(':'), target: doc.data?.channel?.id };
    }
    const location = doc.locations?.find((l) => l.url?.startsWith('imap://'));
    const address = location?.url?.slice(7).split('/')[0] || doc.metadata?.mailAccount;
    return address ? { driver: 'imap', address: normalizeSegment(address) } : null;
}

export async function sendWorkspaceMessage(workspace, mail, connectors, input, principal = {}, { logger = createLogger('messages') } = {}) {
    // A forward may go out without a note of its own; everything else needs text
    // (for HTML email it is the plain-text alternative of `html`).
    if (typeof input.text !== 'string' || (!input.text.trim() && input.forward !== true && !input.images?.length) || input.text.length > 32000) throw messageError('Message text is required (maximum 32,000 characters)');
    messageImages(input.images);
    if (input.html != null && (typeof input.html !== 'string' || input.html.length > 512000)) throw messageError('Message HTML is too large (maximum 500 KB)');
    if (input.forward === true && input.replyToDocumentId == null) throw messageError('Forward needs the message to forward');
    const parent = input.replyToDocumentId != null ? await workspace.get(input.replyToDocumentId) : null;
    if (input.replyToDocumentId != null && !parent) throw messageError('Reply target not found', 404);
    const source = sourceAccount(parent);
    if (parent && !source) throw messageError('This document has no supported messaging account');
    const driver = source?.driver || input.driver;
    const address = source?.address || input.address;
    if (parent && ((input.driver && input.driver !== driver) || (input.address && normalizeSegment(input.address) !== address))) throw messageError('Reply account must match the original conversation');
    if (!['imap', 'slack', 'whatsapp'].includes(driver) || !address) throw messageError('Select a messaging account');

    const config = driver === 'imap' ? await mail.senderConfig(address) : connectors.messageAccount(driver, address).config;
    const permission = driver === 'imap' ? config.smtp : config;
    if (principal.isAgent && permission.allowAgentSend !== true) throw messageError('Agent sending is not enabled for this account', 403);
    if (principal.basePath && principal.basePath !== '/') {
        if (!parent) throw messageError('Path-bound agents can reply to in-scope messages only', 403);
        const visible = await workspace.list({ context: principal.basePath, ids: [parent.id], idsOnly: true, limit: 1 });
        if (!visible.includes(parent.id)) throw messageError('Reply target is outside the agent scope', 403);
    }
    if (driver !== 'imap' && (input.to?.length || input.cc?.length || input.bcc?.length || input.subject || input.replyAll || input.forward || input.html || input.quote)) throw messageError('Email recipients, subject, HTML, quoting, Reply all and Forward apply only to email');
    if (driver === 'slack' && input.images?.length) throw messageError('Pictures are supported for email and WhatsApp');
    if (driver === 'whatsapp' && input.images?.length > 1) throw messageError('WhatsApp supports one picture per message');
    if (input.forward === true && input.replyAll === true) throw messageError('Choose Reply all or Forward, not both');
    if (parent && input.target && input.target !== source.target) throw messageError('A reply cannot change conversations');

    // Validate/provider discovery before creating the send fence. No message
    // has left Canvas yet, so validation failures can be corrected normally.
    const instance = driver === 'imap' ? null : connectors.messageAccount(driver, address).instance;
    const loadAttachment = async (a) => (await workspace.resolveDocument(parent, { url: a.url }))?.buffer || null;
    const prepared = driver === 'imap' ? await prepareEmail(config, input, parent, { loadAttachment }) : await instance.prepareMessage(input, parent);
    const normalized = {
        driver, address, text: input.text, target: input.target || null,
        replyToDocumentId: parent?.id || null, to: input.to || [], cc: input.cc || [], bcc: input.bcc || [],
        subject: input.subject ?? null, replyAll: input.replyAll === true,
        images: input.images || [], html: input.html ?? null, quote: input.quote === true, forward: input.forward === true,
        principal: principal.id || 'user',
    };
    return sendOnce(path.join(workspace.varPath, 'message-outbox'), input.requestId, normalized, async () => {
        const sent = driver === 'imap'
            ? await deliverEmail(config, prepared)
            : await instance.sendMessage(prepared, input.requestId);
        const result = { status: sent.status, providerMessageId: sent.providerMessageId, driver, address,
            ...(sent.accepted ? { accepted: sent.accepted, rejected: sent.rejected } : {}) };
        // A local-index/Sent-folder failure must never be reported as an
        // unsuccessful send: the provider has already accepted the message.
        try {
            if (driver === 'imap') Object.assign(result, await mail.storeSentMessage(config, prepared.raw));
            else result.docId = await connectors.storeSentMessage(driver, address, sent);
        } catch (error) {
            logger.warn({ err: error, workspaceId: workspace.id, driver, address, requestId: input.requestId, providerMessageId: sent.providerMessageId }, 'Message accepted but local indexing failed');
            result.warnings = ['Message accepted, but its local copy could not be indexed.'];
        }
        return result;
    });
}
