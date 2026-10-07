import Identity from 'canvas-synapsd/src/schemas/core/Identity.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';

export const isIdentity = (doc) => doc?.schema === 'data/schema/identity' || doc?.schema?.startsWith('data/schema/identity/');
export const isMessage = (doc) => doc?.schema === 'data/schema/message' || doc?.schema?.startsWith('data/schema/message/');
const email = (value) => {
    const address = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
};
export const providerId = (platform, id) => platform === 'whatsapp' ? String(id || '').replace(/:\d+(?=@)/, '') : String(id || '');
export const providerKey = (platform, scope, id) => scope && id ? JSON.stringify([platform, String(scope).toLowerCase(), providerId(platform, id)]) : null;

function parties(value) {
    return (Array.isArray(value) ? value : (value ? [value] : [])).flatMap((entry) => {
        if (entry && typeof entry === 'object' && entry.address) return [entry];
        return addressparser(String(entry || '')).flatMap((p) => p.group || [p]);
    }).map((p) => ({ address: email(p.address), name: String(p.name || '').trim() })).filter((p) => p.address);
}

export function messageParties(data = {}) {
    return { authors: parties(data.from), recipients: [...parties(data.to), ...parties(data.cc), ...parties(data.bcc)] };
}

export function identityKeys(doc) {
    if (!isIdentity(doc)) return [];
    const keys = Identity.prototype.emailAddresses.call(doc).filter(email).map(Identity.emailAliasKey);
    const data = doc.data || {};
    for (const item of [...(data.identifiers || []).map((i) => ({ platform: i.type, id: i.identifier, scope: i.provider || i.metadata?.account })),
        ...(data.channels || []).map((c) => ({ platform: c.kind, id: c.value, scope: c.metadata?.account }))]) {
        if (item.platform === 'email') continue;
        const scope = item.scope || (item.platform === 'whatsapp' ? doc.metadata?.whatsappAccount : null);
        const key = providerKey(item.platform, scope, item.id);
        if (key) keys.push(key);
    }
    return [...new Set(keys)];
}

// Only structured participant fields count. A display name or text mention is
// not identity evidence, and provider IDs must be scoped to their account/team.
export function participants(doc) {
    if (!isMessage(doc)) return [];
    if (doc.schema.startsWith('data/schema/message/email')) {
        const { authors, recipients } = messageParties(doc.data);
        return [...authors.map((party) => ({ p: 'authored-by', party })), ...recipients.map((party) => ({ p: 'addressed-to', party }))]
            .map(({ p, party }) => ({ p, party: { ...party, keys: [Identity.emailAliasKey(party.address)] } }));
    }
    const data = doc.data || {};
    const platform = data.platform;
    let scope = data.platformMetadata?.teamId || data.platformMetadata?.workspaceId;
    if (!scope) {
        const location = doc.locations?.find((l) => l.url?.startsWith(`${platform}://`));
        if (location) { try { scope = new URL(location.url).host; } catch { /* malformed provenance */ } }
    }
    const party = (sender) => {
        const id = providerId(platform, sender?.id);
        const address = email(sender?.email);
        const key = providerKey(platform, scope, id);
        const keys = [address && Identity.emailAliasKey(address), key].filter(Boolean);
        if (!keys.length || (platform === 'whatsapp' && !/@(s\.whatsapp\.net|lid)$/.test(id))) return null;
        return { keys, address, platform, scope, identifier: id, name: sender?.name || sender?.displayName || sender?.username || '' };
    };
    const result = [];
    const author = party(data.sender);
    if (author) result.push({ p: 'authored-by', party: author });
    for (const mention of data.mentions || []) {
        if (mention.type && mention.type !== 'user') continue;
        const mentioned = party(mention);
        if (mentioned) result.push({ p: 'mentions', party: mentioned });
    }
    return result;
}
