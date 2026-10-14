import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { MailParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';

export const isEmail = doc => /^data\/schema\/(?:message\/)?email(?:\/|$)/.test(doc?.schema || '');

export const emailText = (text, html) => text || (html ? htmlToText(html, { wordwrap: false }) : '');

export function emailBodyChecksum(data = {}) {
    return crypto.createHash('sha256').update(JSON.stringify([data.body || '', data.bodyHtml || ''])).digest('hex');
}

// Projection only: legacy inline bodies remain intact in the database. Single
// document reads and the content endpoint still have access to those bodies.
export function emailListPreview(doc) {
    if (!isEmail(doc)) return doc;
    const data = { ...doc.data };
    if (!data.bodyPreview && data.body) data.bodyPreview = data.body.slice(0, 2000).replace(/\s+/g, ' ').trim().slice(0, 200);
    delete data.body;
    delete data.bodyHtml;
    return { ...(doc.toJSON?.() || doc), data };
}

// Bodies are transient read results, never written back to the index. Drain
// attachment streams without buffering them; their blobs have their own URLs.
export async function resolveEmailBody(doc, resolveDocument) {
    if (!isEmail(doc)) throw Object.assign(new Error('Document is not an email'), { statusCode: 400 });
    if (typeof doc.data?.body === 'string' || typeof doc.data?.bodyHtml === 'string') {
        return { body: emailText(doc.data.body, doc.data.bodyHtml), bodyHtml: doc.data.bodyHtml || null };
    }
    const resolved = await resolveDocument(doc, { stream: true });
    if (!resolved) throw Object.assign(new Error('Email content is unavailable'), { statusCode: 404 });
    const source = resolved.stream || (resolved.buffer && Readable.from(resolved.buffer));
    if (!source) throw new Error('Email content returned no readable bytes');
    const parser = new MailParser({ skipImageLinks: true, skipTextToHtml: true });
    let body = { body: '', bodyHtml: null };
    parser.on('data', part => {
        if (part.type === 'attachment') {
            part.content.on('error', error => parser.destroy(error));
            part.content.once('end', () => part.release());
            part.content.resume();
        } else if (part.type === 'text') {
            body = { body: part.text || '', bodyHtml: part.html || null };
        }
    });
    await Promise.all([pipeline(source, parser), finished(parser, { cleanup: true })]);
    body.body = emailText(body.body, body.bodyHtml);
    return body;
}

export function emailInferenceText(doc, body) {
    const data = doc.data || {};
    const address = value => typeof value === 'string' ? value : [value?.name, value?.address].filter(Boolean).join(' ');
    return [
        `Subject: ${data.subject || ''}`,
        `From: ${address(data.from)}`,
        `To: ${(data.to || []).map(address).join(', ')}`,
        data.date && `Date: ${data.date}`,
        data.bodyPreview,
        body.body,
    ].filter(Boolean).join('\n');
}
