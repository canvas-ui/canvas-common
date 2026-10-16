import crypto from 'node:crypto';
import path from 'node:path';
import { classifyDocument } from '../../documents/classifier.js';
import { messageError } from './outbox.js';

export const MAX_FILE_BYTES = 18 * 1024 * 1024;

/** Resolve workspace-owned references, never arbitrary caller URLs or paths. */
export async function messageFiles(workspace, references = [], principal = {}) {
    if (!Array.isArray(references) || references.length > 8) throw messageError('Up to 8 files are allowed');
    const files = [];
    let total = 0;
    for (const ref of references) {
        if (!ref || !Number.isSafeInteger(ref.documentId) || ref.documentId < 1
            || Object.keys(ref).some(key => !['documentId', 'attachmentIndex'].includes(key))
            || (ref.attachmentIndex !== undefined && (!Number.isSafeInteger(ref.attachmentIndex) || ref.attachmentIndex < 0))) {
            throw messageError('Choose a file document or an indexed email attachment');
        }
        if (principal.basePath && principal.basePath !== '/') {
            const ids = await workspace.list({ context: principal.basePath, ids: [ref.documentId], idsOnly: true, limit: 1 });
            if (!ids.includes(ref.documentId)) throw messageError('File is outside the agent scope', 403);
        }
        const doc = await workspace.get(ref.documentId);
        if (!doc) throw messageError('File document not found', 404);
        const kind = classifyDocument(doc);
        const attachment = ref.attachmentIndex === undefined ? null : doc.data?.attachments?.[ref.attachmentIndex];
        if (ref.attachmentIndex !== undefined ? !kind.isEmail() || !attachment?.url : !kind.isFile()) {
            throw messageError('Choose a file document or an available email attachment');
        }
        const size = attachment?.size ?? doc.metadata?.size;
        if (Number(size) + total > MAX_FILE_BYTES) throw messageError('Files must total at most 18 MB');
        const resolved = await workspace.resolveDocument(doc, { stream: true, ...(attachment ? { url: attachment.url } : {}) });
        if (!resolved?.stream && !resolved?.buffer) throw messageError('File bytes are unavailable', 404);
        const chunks = [];
        try {
            for await (const chunk of resolved.stream || [resolved.buffer]) {
                const bytes = Buffer.from(chunk);
                total += bytes.length;
                if (total > MAX_FILE_BYTES) throw messageError('Files must total at most 18 MB');
                chunks.push(bytes);
            }
        } finally { resolved.stream?.destroy?.(); }
        const content = Buffer.concat(chunks);
        let name = attachment?.filename || kind.filename;
        if (!name) {
            const location = doc.locations?.find(loc => loc.url === resolved.url) || doc.locations?.[0];
            try { name = decodeURIComponent(new URL(location?.url).pathname.split('/').pop()); } catch { /* use document fallback */ }
        }
        // Strip control characters from names before handing them to a provider.
        // eslint-disable-next-line no-control-regex
        const filename = path.posix.basename(String(name || `file-${doc.id}`).replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 200) || `file-${doc.id}`;
        const mime = String(attachment?.contentType || kind.mime || '').split(';')[0].trim();
        const contentType = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime) ? mime : 'application/octet-stream';
        files.push({ filename, contentType, content, checksum: crypto.createHash('sha256').update(content).digest('hex') });
    }
    return files;
}
