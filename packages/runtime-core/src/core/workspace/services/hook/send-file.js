import crypto from 'node:crypto';
import { classifyDocument } from '../../documents/classifier.js';
import { matchingAttachments } from './attachments.js';

/** A stable outbox key per rule, file version and rendered destination. A
 * replay/backfill cannot duplicate an accepted or ambiguous delivery. */
export async function sendFile(action, { workspace, doc, scope, logger, interpolate, provenance }) {
    if (!doc?.id) return { status: 'skipped', error: 'Event carries no document' };
    const deliveryRules = Array.isArray(doc.metadata?.fileDeliveryRules) ? doc.metadata.fileDeliveryRules : [];
    if (deliveryRules.includes(scope.rule.id)) return { status: 'skipped', error: 'This rule already produced the outgoing message' };
    if (!['imap', 'slack', 'whatsapp'].includes(action.driver) || typeof action.address !== 'string' || !action.address.trim()) throw new Error('Choose a sending account');
    const source = action.source || 'document';
    if (!['document', 'attachments', 'download'].includes(source)) throw new Error('Unknown file source');
    const documents = source === 'download'
        ? (await Promise.all((scope.downloads || []).map(id => workspace.get(id)))).filter(Boolean)
        : [doc];
    const entries = [];
    for (const document of documents) {
        if (source === 'attachments') {
            if (!classifyDocument(document).isEmail()) continue;
            for (const attachment of matchingAttachments(document, action)) {
                entries.push({ document, ref: { documentId: document.id, attachmentIndex: document.data.attachments.indexOf(attachment) },
                    name: attachment.filename, identity: attachment.checksum || attachment.url });
            }
        } else if (classifyDocument(document).isFile()) {
            entries.push({ document, ref: { documentId: document.id }, name: classifyDocument(document).filename || document.data?.title,
                identity: document.checksumArray?.[0] || document.updatedAt });
        }
    }
    if (!entries.length) return { status: 'skipped', error: source === 'download' ? 'No file from an earlier download action' : 'No matching files or attachments' };
    const failures = [];
    for (const entry of entries) {
        try {
            const render = value => interpolate(String(value || ''), { ...scope, file: { id: entry.document.id, name: entry.name || `file-${entry.document.id}` } });
            const input = { driver: action.driver, address: action.address.trim(), text: render(action.message), files: [entry.ref] };
            if (action.driver === 'imap') {
                input.to = (Array.isArray(action.to) ? action.to : [action.to]).filter(Boolean).map(render);
                if (!input.to.length) throw new Error('Choose an email recipient');
                input.subject = render(action.subject || '{{file.name}}');
            } else {
                input.target = render(action.target).trim();
                if (!input.target) throw new Error('Choose a destination conversation');
            }
            input.requestId = `rule-file-${crypto.createHash('sha256').update(JSON.stringify({ rule: scope.rule.id, identity: entry.identity, input })).digest('hex')}`;
            const result = await workspace.sendMessage(input, { id: `rule:${scope.rule.id}`, provenance, fileDeliveryRules: [...deliveryRules, scope.rule.id] });
            if (result.status !== 'accepted') throw new Error(result.message || 'Delivery unconfirmed; inspect the destination before retrying');
            if (result.rejected?.length) throw new Error(`Some recipients were rejected: ${result.rejected.join(', ')}`);
            logger.debug(`rule sendFile: ${entry.document.id} via ${action.driver}; receipt ${input.requestId}; accepted ${result.providerMessageId || ''}`);
        } catch (error) { failures.push(`${entry.name || 'File'}: ${error.message}`); }
    }
    if (failures.length) throw new Error(`${failures.length} of ${entries.length} file deliveries failed: ${failures.join('; ')}`);
}
