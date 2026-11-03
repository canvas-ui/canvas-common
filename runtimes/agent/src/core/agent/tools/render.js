'use strict';

/*
 * Rendering helpers for agent canvas tools.
 *
 * Tools hand the model TEXT, not JSON: a context tree becomes a list of
 * paths, a document list becomes one summary line per document, a single
 * document becomes a readable rendering (an email as headers + body, a note
 * as title + content, ...). Pure functions — no I/O — so they are trivially
 * testable and can be mirrored 1:1 by other runtimes (canvas-agentd).
 */

const SCHEMA_PREFIX = 'data/schema/';

// Short names the model may use instead of full schema ids.
const SCHEMA_ALIASES = {
    email: 'data/schema/message/email',
    emails: 'data/schema/message/email',
    mail: 'data/schema/message/email',
    message: 'data/schema/message',
    messages: 'data/schema/message',
    chat: 'data/schema/message',
    note: 'data/schema/note',
    notes: 'data/schema/note',
    tab: 'data/schema/tab',
    tabs: 'data/schema/tab',
    link: 'data/schema/link',
    links: 'data/schema/link',
    bookmark: 'data/schema/link',
    file: 'data/schema/file',
    files: 'data/schema/file',
    task: 'data/schema/task',
    tasks: 'data/schema/task',
    todo: 'data/schema/task',
    event: 'data/schema/event',
    events: 'data/schema/event',
    calendar: 'data/schema/event/calendar',
    identity: 'data/schema/identity',
    identities: 'data/schema/identity',
    contact: 'data/schema/identity',
    contacts: 'data/schema/identity',
    person: 'data/schema/identity',
    people: 'data/schema/identity',
    document: 'data/schema/document',
    documents: 'data/schema/document',
};

export const SCHEMA_HELP = 'email, message, note, tab, link, file, task, event, identity/contact (or any full data/schema/... id)';

const under = (schema, parent) => schema === parent || (typeof schema === 'string' && schema.startsWith(`${parent}/`));
const schemaLeaf = (schema, parent) =>
    (typeof schema === 'string' && schema.startsWith(`${parent}/`)) ? schema.slice(parent.length + 1) : '';

/**
 * Resolve a user/model supplied schema name to a full schema id.
 * @param {string} value
 * @returns {string|null}
 */
export function resolveSchema(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (raw.startsWith(SCHEMA_PREFIX)) return raw;
    const alias = SCHEMA_ALIASES[raw.toLowerCase()];
    if (alias) return alias;
    return `${SCHEMA_PREFIX}${raw.replace(/^\/+/, '')}`;
}

/** Short schema label for listings: data/schema/message/email -> email */


// ── Paths / time ─────────────────────────────────────────────────────────

export function normalizePath(value) {
    const raw = String(value ?? '').trim();
    const withRoot = raw.startsWith('/') ? raw : `/${raw}`;
    const collapsed = withRoot.replace(/\/+/g, '/');
    const trimmed = collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
    return trimmed || '/';
}

function formatDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace('T', ' ').slice(0, 16);
}

// ── Trees ────────────────────────────────────────────────────────────────

/** Walk down a tree to the node at basePath ('/' = root). Null when absent. */
export function extractSubtree(tree, basePath) {
    if (!tree || !basePath || basePath === '/') return tree ?? null;
    let node = tree;
    for (const segment of basePath.split('/').filter(Boolean)) {
        const children = node?.children || [];
        node = children.find((child) => child?.name === segment || child?.label === segment);
        if (!node) return null;
    }
    return node;
}

/**
 * Flatten a tree (as returned by GET /workspaces/:id/tree) into paths
 * relative to the given root node. Root itself is '/'.
 * @param {Object} node - subtree root
 * @param {Object} [options]
 * @param {number} [options.depth] - max depth below root (undefined = all)
 * @returns {Array<{ path: string, label: string|null, type: string|null }>}
 */
export function treeToPaths(node, { depth } = {}) {
    const entries = [];
    const walk = (current, prefix, level) => {
        for (const child of current?.children || []) {
            const name = child?.name ?? child?.label ?? child?.id;
            if (name === undefined || name === null || name === '' || name === '/') continue;
            const childPath = prefix === '/' ? `/${name}` : `${prefix}/${name}`;
            const label = child?.label && child.label !== name ? child.label : null;
            entries.push({ path: childPath, label, type: child?.type || null });
            if (depth === undefined || level + 1 < depth) walk(child, childPath, level + 1);
        }
    };
    walk(node, '/', 0);
    return entries;
}

export function formatPaths(entries) {
    if (!entries.length) return '(no sub-paths)';
    return entries
        .map((entry) => `${entry.path}${entry.label ? `  (${entry.label})` : ''}`)
        .join('\n');
}

// ── Text helpers ─────────────────────────────────────────────────────────

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/** Crude but dependency-free HTML → text (emails without a plain body). */
function htmlToText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : match;
            }
            return HTML_ENTITIES[entity.toLowerCase()] ?? match;
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncate(text, max) {
    const value = String(text ?? '');
    if (!max || value.length <= max) return value;
    return `${value.slice(0, max)}\n… [truncated, ${value.length - max} more characters]`;
}



function formatAddress(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    const { name, address, email, displayName } = entry;
    const addr = address || email || '';
    const label = name || displayName || '';
    if (label && addr) return `${label} <${addr}>`;
    return label || addr;
}

function formatAddressList(list) {
    if (!list) return '';
    return (Array.isArray(list) ? list : [list]).map(formatAddress).filter(Boolean).join(', ');
}

function fileName(doc) {
    const data = doc?.data || {};
    const candidates = [
        doc?.metadata?.filename,
        data.filename,
        data.name,
        data.path,
        data.url,
        doc?.locations?.[0]?.url,
        doc?.locations?.[0],
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.split('/').filter(Boolean).pop() || candidate;
        }
    }
    return '';
}

// ── Compact listing ──────────────────────────────────────────────────────

const PREVIEW_CHARS = 200;

function preview(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/**
 * The listing form of a document: what a search result needs to decide
 * whether to read the whole thing. Keys with nothing to say are omitted.
 * @param {Object} doc
 * @returns {{ id:number, schema:string, title?:string, from?:string, date?:string, preview?:string, attachments?:string[] }}
 */
export function summarizeDocument(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const schema = String(doc.schema || '');
    const data = doc.data || {};
    const summary = { id: doc.id, schema };
    let title; let from; let date; let body;
    if (schema === SCHEMA_ALIASES.email) {
        title = data.subject;
        from = formatAddress(data.from);
        date = data.date;
        body = data.bodyPreview || data.body || (data.bodyHtml ? htmlToText(data.bodyHtml) : '');
        if (data.attachments?.length) summary.attachments = data.attachments.map((attachment) => attachment.filename).filter(Boolean);
    } else if (schema === SCHEMA_ALIASES.message) {
        from = data.sender ? formatAddress({ name: data.sender.displayName || data.sender.name || data.sender.username, address: data.sender.email }) || data.sender.id : '';
        date = data.timestamp || data.date;
        body = data.text || (data.html ? htmlToText(data.html) : '');
    } else if (schema === SCHEMA_ALIASES.link) {
        title = data.label || data.title || data.uri;
        body = data.description;
    } else if (schema === SCHEMA_ALIASES.tab) {
        title = data.title || data.url;
        body = data.description;
    } else if (under(schema, SCHEMA_ALIASES.event)) {
        title = data.title;
        date = data.start;
        body = data.description;
    } else if (schema.startsWith(SCHEMA_ALIASES.identity)) {
        title = data.displayName || data.name || data.fullName;
        body = data.notes || data.description;
    } else {
        title = data.title || data.name || fileName(doc);
        body = data.content || data.description || data.text;
    }
    if (title) summary.title = String(title);
    if (from) summary.from = from;
    summary.date = date || doc.createdAt || undefined;
    if (!summary.date) delete summary.date;
    const snippet = preview(body);
    if (snippet) summary.preview = snippet;
    return summary;
}

/** Dotted-path projection of a document; id and schema always come along. */
export function pickFields(doc, fields) {
    if (!doc || typeof doc !== 'object') return doc;
    const picked = { id: doc.id, schema: doc.schema };
    for (const field of fields) {
        const value = field.split('.').reduce((current, key) => (current == null ? undefined : current[key]), doc);
        if (value !== undefined) picked[field] = value;
    }
    return picked;
}

// ── Full document rendering ──────────────────────────────────────────────

/**
 * Human/model readable rendering of one document.
 * @param {Object} doc
 * @param {Object} [options]
 * @param {number} [options.maxChars] - cap on the body/content part
 * @returns {string}
 */
export function renderDocument(doc, { maxChars = 12000 } = {}) {
    if (!doc || typeof doc !== 'object') return String(doc);
    const schema = String(doc.schema || '');
    const data = doc.data || {};
    const lines = [`Document #${doc.id}  (${schema || 'unknown schema'})`];
    const meta = [];
    if (doc.createdAt) meta.push(`created ${formatDate(doc.createdAt)}`);
    if (doc.updatedAt && doc.updatedAt !== doc.createdAt) meta.push(`updated ${formatDate(doc.updatedAt)}`);
    if (meta.length) lines.push(meta.join(', '));
    lines.push('');

    if (schema === SCHEMA_ALIASES.email) {
        lines.push(`From: ${formatAddress(data.from)}`);
        lines.push(`To: ${formatAddressList(data.to)}`);
        if (data.cc?.length) lines.push(`Cc: ${formatAddressList(data.cc)}`);
        if (data.replyTo?.length) lines.push(`Reply-To: ${formatAddressList(data.replyTo)}`);
        lines.push(`Date: ${data.date || ''}`);
        lines.push(`Subject: ${data.subject || '(no subject)'}`);
        if (data.messageId) lines.push(`Message-Id: ${data.messageId}`);
        if (data.inReplyTo) lines.push(`In-Reply-To: ${data.inReplyTo}`);
        if (data.folder?.path || data.folder?.name) lines.push(`Folder: ${data.folder.path || data.folder.name}`);
        const flags = [];
        if (data.isRead === false) flags.push('unread');
        if (data.isFlagged) flags.push('flagged');
        if (data.isDraft) flags.push('draft');
        if (data.importance && data.importance !== 'normal') flags.push(`importance: ${data.importance}`);
        if (flags.length) lines.push(`Flags: ${flags.join(', ')}`);
        if (data.labels?.length) lines.push(`Labels: ${data.labels.join(', ')}`);
        lines.push('');
        const body = (typeof data.body === 'string' && data.body.trim())
            ? data.body.trim()
            : (data.bodyHtml ? htmlToText(data.bodyHtml) : (data.bodyPreview || ''));
        lines.push(truncate(body || '(empty body)', maxChars));
        if (data.attachments?.length) {
            lines.push('');
            lines.push(`Attachments (${data.attachments.length}):`);
            for (const attachment of data.attachments) {
                const bits = [attachment.contentType, attachment.size ? `${attachment.size} bytes` : null, attachment.url].filter(Boolean);
                lines.push(`- ${attachment.filename}${bits.length ? `  (${bits.join(', ')})` : ''}`);
            }
        }
        return lines.join('\n');
    }

    if (schema === SCHEMA_ALIASES.message) {
        const sender = data.sender ? formatAddress({ name: data.sender.displayName || data.sender.name || data.sender.username, address: data.sender.email }) || data.sender.id : '';
        if (sender) lines.push(`From: ${sender}`);
        if (data.channel) lines.push(`Channel: ${data.channel.name || data.channel.id}`);
        if (data.timestamp || data.date) lines.push(`Date: ${data.timestamp || data.date}`);
        lines.push('');
        lines.push(truncate(data.text || (data.html ? htmlToText(data.html) : ''), maxChars));
        return lines.join('\n');
    }

    if (schema === SCHEMA_ALIASES.note) {
        if (data.title) lines.push(`Title: ${data.title}`, '');
        lines.push(truncate(data.content || '', maxChars));
        return lines.join('\n');
    }

    if (schema === SCHEMA_ALIASES.tab || schema === SCHEMA_ALIASES.link) {
        const title = schema === SCHEMA_ALIASES.link ? data.label || data.title : data.title;
        const url = schema === SCHEMA_ALIASES.link ? data.uri : data.url;
        if (title) lines.push(`Title: ${title}`);
        lines.push(`URL: ${url || ''}`);
        if (data.description) lines.push('', truncate(data.description, maxChars));
        return lines.join('\n');
    }

    if (schema === SCHEMA_ALIASES.task) {
        lines.push(`Title: ${data.title || ''}`);
        if (data.status) lines.push(`Status: ${data.status}`);
        if (data.priority) lines.push(`Priority: ${data.priority}`);
        if (data.dueDate) lines.push(`Due: ${data.dueDate}`);
        if (data.completed) lines.push(`Completed: ${data.completedAt || 'yes'}`);
        if (data.description) lines.push('', truncate(data.description, maxChars));
        return lines.join('\n');
    }

    if (under(schema, SCHEMA_ALIASES.event)) {
        lines.push(`Title: ${data.title || ''}`);
        lines.push(`Start: ${data.start || ''}${data.allDay ? ' (all day)' : ''}`);
        if (data.end) lines.push(`End: ${data.end}`);
        if (data.location) lines.push(`Location: ${data.location}`);
        if (data.recurrence) lines.push(`Recurrence: ${data.recurrence}`);
        if (data.description) lines.push('', truncate(data.description, maxChars));
        return lines.join('\n');
    }

    if (schema.startsWith(SCHEMA_ALIASES.identity)) {
        lines.push(`Name: ${data.displayName || ''}`);
        const type = schemaLeaf(schema, SCHEMA_ALIASES.identity);
        if (type) lines.push(`Type: ${type}`);
        if (data.primaryEmail) lines.push(`Email: ${data.primaryEmail}`);
        for (const identifier of data.identifiers || []) {
            lines.push(`- ${identifier.type}${identifier.provider ? `/${identifier.provider}` : ''}: ${identifier.identifier}${identifier.label ? ` (${identifier.label})` : ''}`);
        }
        for (const channel of data.channels || data.contacts || []) {
            lines.push(`- ${channel.kind}: ${channel.value}${channel.label ? ` (${channel.label})` : ''}`);
        }
        for (const org of data.organizations || []) {
            lines.push(`- organization: ${org.name}${org.role ? ` (${org.role})` : ''}`);
        }
        if (data.notes) lines.push('', truncate(data.notes, maxChars));
        return lines.join('\n');
    }

    if (schema === SCHEMA_ALIASES.file) {
        lines.push(`Name: ${fileName(doc)}`);
        if (data.mimeType) lines.push(`Type: ${data.mimeType}`);
        if (data.size) lines.push(`Size: ${data.size} bytes`);
        for (const location of doc.locations || []) {
            const url = typeof location === 'string' ? location : location?.url;
            if (url) lines.push(`- ${url}`);
        }
        const extra = { ...data };
        delete extra.mimeType; delete extra.size; delete extra.name; delete extra.filename; delete extra.path; delete extra.url;
        if (Object.keys(extra).length) lines.push('', truncate(JSON.stringify(extra, null, 2), maxChars));
        return lines.join('\n');
    }

    lines.push(truncate(JSON.stringify(data, null, 2), maxChars));
    return lines.join('\n');
}
