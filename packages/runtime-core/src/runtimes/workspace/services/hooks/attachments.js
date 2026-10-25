import path from 'node:path';
import { classifyDocument } from '../../db/classifier.js';
import { joinKey, sanitizeSegment, mimeForFilename, MIME_EXTENSIONS } from './key-utils.js';

const array = value => Array.isArray(value) ? value : [value];

function attachmentType(attachment) {
    const type = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
    return !type || type === 'application/octet-stream' ? mimeForFilename(attachment.filename) : type;
}

export function emailDate(doc) {
    for (const value of [doc.data?.sentAt, doc.data?.date, doc.data?.receivedAt,
        (doc.timelines || []).find(t => (t.timeline || t.name) === 'content')?.start,
        doc.createdAt, doc.created]) {
        if (!value) continue;
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date;
    }
    return null;
}

// Reuse a previous conflict rename for these same bytes. The File document's
// locations survive restarts and dedupe across messages; no separate ledger or
// direct database access is needed. Stored verifies the bytes still exist.
function previousKey(endpoints, to, key, onConflict) {
    const keys = endpoints.filter(e => e.backend === to).map(e => e.key);
    if (keys.includes(key)) return key;
    if (onConflict !== 'rename') return key;
    const ext = path.posix.extname(key);
    const stem = key.slice(0, key.length - ext.length);
    return keys.filter(candidate => candidate.startsWith(`${stem}-`) && candidate.endsWith(ext))
        .filter(candidate => /^[1-9]\d*$/.test(candidate.slice(stem.length + 1, ext ? -ext.length : undefined)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] || key;
}

/** Copy matching email attachments through Stored, retaining the original mail
 * and its blobs. Per-message names/dates come from the Email, not the shared
 * content-addressed File (the same PDF can occur under several names/dates).
 */
export function matchingAttachments(doc, action) {
    const patterns = array(action.mime ?? '*').map(value => String(value).trim().toLowerCase());
    if (!patterns.length || patterns.some(pattern => !/^(\*|[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+)|\*\/\*)$/.test(pattern))) {
        throw new Error('Choose an attachment MIME type, such as application/pdf or image/*');
    }
    if (action.filename !== undefined && typeof action.filename !== 'string') throw new Error('Attachment filename filter must be text');
    return (doc.data?.attachments || []).filter(attachment => attachment &&
        (action.includeInline === true || attachment.isInline !== true) &&
        patterns.some(pattern => pattern === '*' || pattern === '*/*' || (pattern.endsWith('/*')
            ? attachmentType(attachment).startsWith(pattern.slice(0, -1)) : attachmentType(attachment) === pattern)) &&
        (!action.filename || String(attachment.filename || '').toLowerCase().includes(action.filename.toLowerCase())));
}

export async function extractAttachments(action, { workspace, doc, scope, logger, provenance, helpers }) {
    if (!doc?.id || !classifyDocument(doc).isEmail()) return { status: 'skipped', error: 'Not an email' };
    const to = String(action.to || '').trim();
    if (!to || !workspace.backendKeepsPaths(to)) throw new Error('Choose a destination backend that supports folder paths');
    const onConflict = action.onConflict || 'rename';
    if (!['rename', 'error'].includes(onConflict)) throw new Error('Attachment extraction supports rename or error on conflict');
    const attachments = matchingAttachments(doc, action);
    if (!attachments.length) return { status: 'skipped', error: 'No matching attachments' };

    const date = emailDate(doc);
    if (!date && /\{\{\s*(YYYY|YY|MM|DD|HH|mm|ss)\s*\}\}/.test(`${action.folder || ''}/${action.subfolder || ''}`)) {
        throw new Error('The email has no valid date for the destination folder template');
    }
    const failures = [];
    for (const attachment of attachments) {
        try {
            // Mail blobs are durable before the email insertion event. In the
            // single-message ingest path the File/includes edge may land later.
            const checksum = attachment.checksum;
            if (typeof checksum !== 'string' || !/^sha256\/[a-f0-9]{64}$/i.test(checksum)) {
                throw new Error('Attachment has no stored content identity; resync the email first');
            }
            let file = await workspace.getByChecksumString(checksum);
            if (!file) {
                if (!/^stored:\/\/[^/]+\/.+/.test(attachment.url || '')) throw new Error('Attachment bytes are unavailable; resync the email first');
                const id = await workspace.put({
                    schema: 'data/schema/file', checksumArray: [checksum], data: {},
                    locations: [{ url: attachment.url, metadata: { filename: attachment.filename, size: attachment.size, synced: true } }],
                    metadata: { contentType: attachmentType(attachment), size: attachment.size, source: 'email' },
                }, { context: null, emitEvent: false, provenance });
                file = await workspace.get(id);
            }
            if (!file?.id) throw new Error('Could not index the attachment');
            await workspace.assertRelation(doc.id, 'includes', file.id);

            let filename = sanitizeSegment(path.posix.basename(String(attachment.filename || '').replaceAll('\\', '/')), `attachment-${file.id}`);
            if (!path.posix.extname(filename)) filename += MIME_EXTENSIONS[attachmentType(attachment)] || '';
            const templateDoc = { ...doc, metadata: { ...doc.metadata, filename, contentType: attachmentType(attachment) } };
            const render = template => helpers.interpolate(helpers.expandKeyTemplate(String(template || ''), {
                doc: templateDoc, sourceKey: filename, ...(date ? { date } : {}),
            }), scope);
            const key = joinKey(render(action.folder), render(action.subfolder), filename);
            const endpoints = await workspace.documentByteEndpoints(file);
            const available = await workspace.documentByteEndpoints(file, { readable: true });
            const targetKey = previousKey(endpoints, to, key, onConflict);
            const source = available.find(e => e.url === attachment.url)
                || available.find(e => e.backend !== to || e.key !== targetKey) || available[0];
            if (!source) throw new Error('No readable copy of the attachment is available');
            await workspace.transferDocumentBytes(file, { to, key: targetKey, from: source, mode: 'copy', onConflict });
            logger.debug(`rule extractAttachments: email ${doc.id}, attachment ${file.id} -> ${to}/${targetKey}`);
        } catch (error) {
            failures.push(`${attachment.filename || 'Attachment'}: ${error.message}`);
        }
    }
    if (failures.length) throw new Error(`${failures.length} of ${attachments.length} attachments failed: ${failures.join('; ')}`);
}
