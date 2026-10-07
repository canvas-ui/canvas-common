import { messageImages } from './images.js';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import crypto from 'node:crypto';
import { convert as htmlToText } from 'html-to-text';
import { messageError } from './outbox.js';

// Forwarded attachments ride in the one SMTP message; most providers cap a
// message around 25 MB after base64, so refuse before building anything.
const MAX_FORWARD_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export function emailAddresses(value) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    return [...new Set(entries.flatMap((entry) => {
        if (typeof entry === 'object' && entry?.address) return [entry.address];
        return addressparser(String(entry || '')).flatMap((p) => p.group || [p]).map((p) => p.address);
    }).filter(Boolean).map((s) => String(s).trim()))];
}

export function normalizeSmtp(input = {}, previous = {}) {
    const smtp = { ...previous, ...input };
    if (input.password === '' || input.password === true) smtp.password = previous.password;
    const out = {
        enabled: smtp.enabled === true, allowAgentSend: smtp.allowAgentSend === true,
        host: String(smtp.host || '').trim(), port: Number(smtp.port || 587),
        secure: smtp.secure === true, user: String(smtp.user || '').trim(),
        password: typeof smtp.password === 'string' ? smtp.password : '',
        from: String(smtp.from || '').trim(), sentFolder: String(smtp.sentFolder || 'Sent').trim(),
        appendSent: smtp.appendSent === true,
    };
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw messageError('Invalid SMTP port');
    if (out.enabled && (!out.host || emailAddresses(out.from).length !== 1 || !/^[^\s@]+@[^\s@]+$/.test(emailAddresses(out.from)[0] || ''))) throw messageError('SMTP host and one From address are required');
    if (/[\r\n]/.test(out.from)) throw messageError('Invalid From address');
    return out;
}

export function emailRecipients(from, input = {}, parent = null) {
    const own = emailAddresses(from)[0] || '';
    const data = parent?.data || {};
    const fromSelf = emailAddresses(data.from).some((s) => s.toLowerCase() === own.toLowerCase());
    // A forward is a new message to new people: no default recipients, and
    // sending a copy to yourself is a legitimate choice.
    const forward = input.forward === true;
    let to = emailAddresses(input.to);
    if (!to.length && parent && !forward) to = emailAddresses(fromSelf ? data.to : (data.replyTo || data.headers?.['reply-to'] || data.from));
    let cc = emailAddresses(input.cc);
    if (input.replyAll && parent && !forward) {
        to = [...new Set([...to, ...emailAddresses(data.to)])];
        cc = [...new Set([...cc, ...emailAddresses(data.cc)])];
    }
    if (parent && !forward) {
        to = to.filter((s) => s.toLowerCase() !== own.toLowerCase());
        cc = cc.filter((s) => s.toLowerCase() !== own.toLowerCase());
    }
    cc = cc.filter((s) => !to.some((t) => t.toLowerCase() === s.toLowerCase()));
    const bcc = emailAddresses(input.bcc);
    return { to, cc, bcc };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function partyText(value) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    return entries.map((p) => (typeof p === 'object' && p
        ? (p.name && p.address ? `${p.name} <${p.address}>` : p.address || p.name || '')
        : String(p || ''))).filter(Boolean).join(', ');
}

function withPrefix(prefix, subject, already) {
    const s = String(subject || '');
    return already.test(s) ? s : `${prefix}: ${s}`;
}

// The quoted/forwarded original, built from the stored email rather than from
// what the client echoed back: the composer never has to round-trip arbitrary
// sender HTML through tiptap (which would drop tables, styles and layout).
function originalBody(data) {
    const rawHtml = typeof data.bodyHtml === 'string' && data.bodyHtml.trim() ? data.bodyHtml : null;
    // Only the <body> contents can nest inside our message; the sender's
    // <head> (styles, meta) is dropped the way webmail clients do.
    const html = rawHtml ? (rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? rawHtml) : null;
    const text = typeof data.body === 'string' && data.body.trim() ? data.body
        : rawHtml ? htmlToText(rawHtml, { wordwrap: false }) : '';
    return { html: html ?? `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`, text, hasHtml: !!html };
}

export function quoteOriginal(data, forward) {
    const body = originalBody(data);
    const date = data.date ? new Date(data.date) : null;
    const when = date && !Number.isNaN(date.getTime()) ? date.toUTCString() : '';
    const from = partyText(data.from);
    if (forward) {
        const rows = [['From', from], ['Date', when], ['Subject', data.subject || ''], ['To', partyText(data.to)], ['Cc', partyText(data.cc)]]
            .filter(([, v]) => v);
        return {
            text: ['---------- Forwarded message ---------', ...rows.map(([k, v]) => `${k}: ${v}`), '', body.text].join('\n'),
            html: `<div class="canvas-forward">---------- Forwarded message ---------<br>${rows.map(([k, v]) => `${k}: ${escapeHtml(v)}`).join('<br>')}<br><br>${body.html}</div>`,
            hasHtml: body.hasHtml,
        };
    }
    const attribution = `On ${when || 'an earlier date'}, ${from || 'the sender'} wrote:`;
    return {
        text: `${attribution}\n${body.text.split(/\r?\n/).map((l) => `> ${l}`).join('\n')}`,
        html: `<div class="canvas-quote-attribution">${escapeHtml(attribution)}</div>`
            + `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body.html}</blockquote>`,
        hasHtml: body.hasHtml,
    };
}

// Parent attachments that must travel with this message: every attachment on
// a forward, only the inline (cid-referenced) ones for a quoted reply so the
// quoted HTML still shows its images. `loadAttachment` resolves the stored
// blob; a forward refuses to go out with a missing file, a quote degrades.
async function parentAttachments(data, forward, quoting, loadAttachment) {
    if (!loadAttachment || !(forward || quoting)) return [];
    const list = (Array.isArray(data.attachments) ? data.attachments : [])
        .filter((a) => a?.url && (forward || (a.isInline && a.contentId)));
    const out = [];
    let total = 0;
    for (const a of list) {
        const content = await Promise.resolve().then(() => loadAttachment(a)).catch(() => null);
        if (!content) {
            if (forward && !a.isInline) throw messageError(`Attachment "${a.filename || 'attachment'}" could not be loaded for forwarding`);
            continue;
        }
        total += content.length;
        if (total > MAX_FORWARD_ATTACHMENT_BYTES) throw messageError('Forwarded attachments exceed the 18 MB message limit');
        const cid = a.contentId ? String(a.contentId).replace(/^<|>$/g, '') : undefined;
        out.push({
            filename: a.filename || 'attachment', content, contentType: a.contentType || 'application/octet-stream',
            ...(cid ? { cid } : {}), contentDisposition: a.isInline && cid ? 'inline' : 'attachment',
        });
    }
    return out;
}

export async function prepareEmail(config, input, parent = null, { loadAttachment = null } = {}) {
    const smtp = config.smtp;
    if (!smtp?.enabled || config.readOnly) throw messageError('Sending is not enabled for this email account', 403);
    const own = emailAddresses(smtp.from)[0];
    const data = parent?.data || {};
    const { to, cc, bcc } = emailRecipients(smtp.from, input, parent);
    const recipients = [...to, ...cc, ...bcc];
    if (!recipients.length || recipients.some((s) => /[\r\n]/.test(s) || !/^[^\s@]+@[^\s@]+$/.test(s))) throw messageError('Valid email recipients are required');
    if (recipients.length > 100) throw messageError('Too many recipients');
    const forward = input.forward === true && !!parent;
    if (input.forward === true && !parent) throw messageError('Forward needs the message to forward');
    const subject = input.subject ?? (!parent ? ''
        : forward ? withPrefix('Fwd', data.subject, /^(fwd?|fw):/i) : withPrefix('Re', data.subject, /^re:/i));
    if (/[\r\n]/.test(subject)) throw messageError('Invalid subject');
    // A forward starts a new conversation: no In-Reply-To/References, so the
    // recipients' clients do not file it into a thread they never saw.
    const parentId = forward ? null : data.messageId;
    const references = [...new Set([...String(Array.isArray(data.references) ? data.references.join(' ') : data.references || '').matchAll(/<[^<>\r\n]+>/g)].map((m) => m[0]).concat(parentId ? [parentId] : []))];
    const messageId = `<${crypto.randomUUID()}@${own.split('@')[1]}>`;
    const quoting = !!parent && (forward || input.quote === true);
    const quoted = quoting ? quoteOriginal(data, forward) : null;
    const ownText = String(input.text || '');
    const text = quoted ? (ownText.trim() ? `${ownText}\n\n${quoted.text}` : quoted.text) : ownText;
    // HTML goes out when the author wrote HTML or the quoted original is HTML;
    // a plain-text reply to a plain-text mail stays single-part.
    const pictures = messageImages(input.images);
    const authoredHtml = typeof input.html === 'string' && input.html.trim() ? input.html : null;
    const ownHtml = (authoredHtml ?? (ownText.trim() ? `<div style="white-space:pre-wrap">${escapeHtml(ownText)}</div>` : '')) + pictures.map((picture) => `<p><img src="cid:${picture.cid}" alt="Picture"></p>`).join('');
    const html = authoredHtml || pictures.length || quoted?.hasHtml
        ? `<!doctype html><html><body>${ownHtml}${quoted ? `${ownHtml ? '<br>' : ''}${quoted.html}` : ''}</body></html>`
        : undefined;
    const attachments = [...(parent ? await parentAttachments(data, forward, quoting && !!html, loadAttachment) : []), ...pictures.map((picture) => ({ ...picture, contentDisposition: 'inline' }))];
    const mail = {
        from: smtp.from, to, cc, subject, text, messageId,
        ...(html ? { html } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(parentId ? { inReplyTo: parentId, references } : {}),
        disableFileAccess: true, disableUrlAccess: true,
    };
    const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail(mail);
    return { raw: built.message, envelope: { from: own, to: recipients }, messageId, to, cc, subject };
}

export async function deliverEmail(config, prepared) {
    const smtp = config.smtp;
    const transport = nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.secure,
        requireTLS: !smtp.secure,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        disableFileAccess: true, disableUrlAccess: true,
    });
    try {
        const info = await transport.sendMail({ raw: prepared.raw, envelope: prepared.envelope });
        return { status: 'accepted', providerMessageId: prepared.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
    } finally { transport.close(); }
}
