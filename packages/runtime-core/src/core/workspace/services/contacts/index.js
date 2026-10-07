import { identityKeys, isIdentity, isMessage, participants, providerId, providerKey } from './participants.js';
export { messageParties } from './participants.js';

/**
 * Contact extraction from filed messages, and matching against known identities.
 *
 * Every address on a message (From → `authored-by`, To/Cc/Bcc →
 * `addressed-to`) resolves to one Identity document, so "all mail from Alice"
 * is an incoming-edge read on Alice instead of a full-text scan.
 *
 * New contacts only come from messages a user FILED — linked into a context or a non-backends
 * directory. An IMAP mirror alone never extracts: auto-creating an identity
 * for every newsletter sender in a 30k mailbox would bury the contact list
 * (the same mistake as dumping attachments into the context root). Filing is
 * the signal that the mail matters, and it is where the contacts come from.
 *
 * - Identities resolve by `identity-email/<sha>` alias key (Identity derives
 *   one per address), so a hand-made contact is reused, never forked.
 * - Edges are DERIVED (`meta.src = extractor:email-contacts`): re-derivable,
 *   and not offered for deletion as if a person had drawn them.
 * - The account's own addresses do not create contacts. Explicit identities
 *   carrying those addresses still get their matching messages.
 * - New identities are filed nowhere: reachable from their messages and from
 *   the workspace-wide identity listing, not spilled into the user's trees.
 */

export const CONTACT_EXTRACTOR_SRC = 'extractor:email-contacts';
const IDENTITY_SCHEMA = 'data/schema/identity';
// Machine senders: by local part (noreply@, notifications@) or by domain
// (anything@noreply.github.com, @bounces.example.com).
const SERVICE_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|postmaster|alerts?)([._+-]|@)/i;
const SERVICE_DOMAIN = /@([^@]*\.)?(no-?reply|notifications?|bounces?|mailer)\./i;
export const isServiceAddress = (address) => SERVICE_LOCAL.test(address) || SERVICE_DOMAIN.test(address);
const DEBOUNCE_MS = 500;
const CHUNK = 200;

function identityRecord({ address, name }) {
    const service = isServiceAddress(address);
    // A machine sender's display name is per message — GitHub sends as
    // "<actor> <notifications@github.com>" — so it names the ACTOR, not the
    // sender. Name services by address; the message keeps its own header.
    const displayName = !service && name && name.toLowerCase() !== address ? name : address;
    return {
        schema: `${IDENTITY_SCHEMA}/${service ? 'service' : 'person'}`,
        data: {
            displayName,
            primaryEmail: address,
            channels: [{ kind: 'email', value: address, primary: true }],
            identifiers: [{ type: 'email', identifier: address, primary: true }],
        },
        metadata: { source: CONTACT_EXTRACTOR_SRC },
    };
}

/**
 * Creation is opt-in through filing; matching an existing identity is not.
 * Keep only participant keys/roles in memory, never message bodies. One paged
 * scan on startup builds the reverse lookup; subsequent edits touch matches
 * only, independent of the total mailbox size. Events repair the index as
 * documents change, and rebuilding on restart repairs interrupted work.
 */
export class ContactExtractor {
    #get; #getMany; #listIds; #isUserFiled; #listRelations; #putMany; #reconcile; #ownAddresses; #logger;
    #messages = new Map();
    #identities = new Map();
    #messagesByKey = new Map();
    #identitiesByKey = new Map();
    #whatsapp = new Map();
    #ready = false;
    #stopped = false;
    #pending = new Set();
    #timer = null;
    #running = Promise.resolve();

    constructor({ get, getMany = (ids) => Promise.all(ids.map(get)), listIds = async () => [], isUserFiled,
        listRelations, putMany, reconcileRelations, ownAddresses = async () => [], logger = console }) {
        this.#get = get;
        this.#getMany = getMany;
        this.#listIds = listIds;
        this.#isUserFiled = isUserFiled;
        this.#listRelations = listRelations;
        this.#putMany = putMany;
        this.#reconcile = reconcileRelations;
        this.#ownAddresses = ownAddresses;
        this.#logger = logger;
    }

    #serial(fn) {
        const task = this.#running.then(() => {
            if (this.#stopped) throw new Error('Contact reconciliation stopped');
            return fn();
        });
        this.#running = task.catch((error) => this.#logger.warn?.({ error: error.message }, 'Contact reconciliation failed'));
        return task;
    }

    enqueue(ids = []) {
        if (this.#stopped) return;
        for (const id of ids) if (Number.isSafeInteger(Number(id)) && Number(id) > 0) this.#pending.add(Number(id));
        if (!this.#pending.size || this.#timer) return;
        this.#timer = setTimeout(() => { void this.drain().catch(() => {}); }, DEBOUNCE_MS);
        this.#timer.unref?.();
    }

    async drain() {
        do {
            if (this.#timer) clearTimeout(this.#timer);
            this.#timer = null;
            const batch = [...this.#pending];
            this.#pending.clear();
            await this.extract(batch);
        } while (this.#pending.size && !this.#stopped);
    }

    refresh(ids = []) {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        const batch = [...new Set([...this.#pending, ...ids])];
        this.#pending.clear();
        return this.extract(batch);
    }

    async stop() {
        this.#stopped = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#pending.clear();
        await this.#running;
    }

    extract(ids = []) {
        return this.#serial(async () => {
            await this.#loadIndex();
            const affected = new Set();
            const stats = { messages: 0, identitiesCreated: 0, edges: 0 };
            const own = new Set((await this.#ownAddresses()).map((a) => String(a).trim().toLowerCase()));
            for (let i = 0; i < ids.length && !this.#stopped; i += CHUNK) {
                const batch = ids.slice(i, i + CHUNK).map(Number);
                const docs = new Map((await this.#getMany(batch)).filter(Boolean).map((doc) => [doc.id, doc]));
                for (const id of batch) this.#index(id, docs.get(id), affected);
                for (const id of batch) {
                    const members = this.#messages.get(id);
                    if (!members) continue;
                    const missing = members.map(({ party }) => party).filter((p) => !this.#matches(p).size && !own.has(p.address));
                    if (!missing.length || !(await this.#isUserFiled(id))) continue;
                    stats.messages++;
                    for (const party of missing) {
                        if (this.#matches(party).size || this.#stopped) continue;
                        const [identityId] = await this.#putMany([this.#identityRecord(party)]);
                        if (!identityId) throw new Error('Contact creation returned no identity');
                        this.#index(identityId, await this.#get(identityId), affected);
                        stats.identitiesCreated++;
                    }
                }
                // Release native read snapshots and let navigation run between batches.
                await new Promise((resolve) => setImmediate(resolve));
            }
            stats.edges = await this.#syncMessages([...affected]);
            if (this.#stopped) throw new Error('Contact reconciliation stopped');
            return stats;
        });
    }

    async #loadIndex() {
        if (this.#ready) return;
        this.#messages.clear(); this.#identities.clear();
        this.#messagesByKey.clear(); this.#identitiesByKey.clear();
        const ids = await this.#listIds();
        for (let i = 0; i < ids.length && !this.#stopped; i += CHUNK) {
            for (const doc of await this.#getMany(ids.slice(i, i + CHUNK))) if (doc) this.#index(doc.id, doc);
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (this.#stopped) throw new Error('Contact reconciliation stopped');
        // Includes old backend-only messages and identities made before this
        // service existed. Reconciliation preserves user-authored relations.
        await this.#syncMessages([...this.#messages.keys()]);
        this.#ready = true;
    }

    #replaceKeys(index, id, before, after) {
        for (const key of before) {
            const ids = index.get(key);
            ids?.delete(id);
            if (ids?.size === 0) index.delete(key);
        }
        for (const key of after) {
            if (!index.has(key)) index.set(key, new Set());
            index.get(key).add(id);
        }
    }

    #index(id, doc, affected = null) {
        const before = this.#identities.get(id) || [];
        const after = identityKeys(doc);
        if (this.#identities.has(id) || isIdentity(doc)) {
            for (const key of [...before, ...after]) for (const from of this.#messagesByKey.get(key) || []) affected?.add(from);
            // Also clean up legacy edges after an identifier was removed.
            if (affected) for (const edge of this.#listRelations(id).incoming) {
                if (edge.meta?.src === CONTACT_EXTRACTOR_SRC) affected.add(edge.from);
            }
            this.#replaceKeys(this.#identitiesByKey, id, before, after);
            if (isIdentity(doc)) this.#identities.set(id, after); else this.#identities.delete(id);
        }
        const old = this.#messages.get(id) || [];
        const current = participants(doc);
        if (this.#messages.has(id) || isMessage(doc)) {
            this.#replaceKeys(this.#messagesByKey, id, old.flatMap(({ party }) => party.keys), current.flatMap(({ party }) => party.keys));
            if (isMessage(doc)) this.#messages.set(id, current); else this.#messages.delete(id);
            affected?.add(id);
        }
    }

    #matches(party) {
        return new Set(party.keys.flatMap((key) => [...(this.#identitiesByKey.get(key) || [])]));
    }

    #identityRecord(party) {
        const { platform, scope, identifier } = party;
        if (party.address) {
            const record = identityRecord(party);
            if (providerKey(platform, scope, identifier)) {
                record.data.identifiers.push({ type: platform, provider: scope, identifier });
                record.data.channels.push({ kind: platform, value: identifier, platform, metadata: { account: scope } });
            }
            return record;
        }
        const contact = this.#whatsapp.get(providerKey(platform, scope, identifier));
        return {
            schema: `${IDENTITY_SCHEMA}/person`,
            data: {
                displayName: contact?.name || party.name || identifier,
                identifiers: [{ type: platform, provider: scope, identifier }],
                channels: [{ kind: platform, value: identifier, platform, metadata: { account: scope } }],
            },
            metadata: { source: CONTACT_EXTRACTOR_SRC, ...(platform === 'whatsapp' ? { whatsappAccount: scope } : {}) },
        };
    }

    async #syncMessages(ids) {
        let changed = 0;
        for (let i = 0; i < ids.length && !this.#stopped; i += CHUNK) {
            const entries = ids.slice(i, i + CHUNK).map((from) => ({ from, relations:
                (this.#messages.get(from) || []).flatMap(({ p, party }) => [...this.#matches(party)].map((to) => ({ p, to }))),
            }));
            if (entries.length) changed += await this.#reconcile(entries, { src: CONTACT_EXTRACTOR_SRC });
            await new Promise((resolve) => setImmediate(resolve));
        }
        return changed;
    }

    /** Cache the provider directory; it must never create identities by itself. */
    syncWhatsAppContacts(account, contacts = []) {
        return this.#serial(async () => {
            await this.#loadIndex();
            for (const contact of contacts) {
                const jid = providerId('whatsapp', contact.id);
                if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
                const name = contact.name || contact.notify || contact.verifiedName;
                if (!name) continue;
                const key = providerKey('whatsapp', account, jid);
                this.#whatsapp.set(key, { name: String(name) });
                for (const id of this.#identitiesByKey.get(key) || []) {
                    const doc = await this.#get(id);
                    if (![CONTACT_EXTRACTOR_SRC, 'extractor:whatsapp-contacts'].includes(doc?.metadata?.source)) continue;
                    if (doc.data.displayName !== String(name)) await this.#putMany([{ ...doc, data: { ...doc.data, displayName: String(name) } }]);
                }
            }
        });
    }
}

export { ContactExtractor as EmailContactExtractor };
