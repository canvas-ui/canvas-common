import { ContactExtractor } from './index.js';
import Identity from 'canvas-synapsd/src/schemas/core/Identity.js';
import Workspace from '../../Workspace.js';

export default class WorkspaceContacts {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    // Read-only view that does NOT boot sources (safe for status polls).
    // ─────────────────────────────────────────────────────────────────────────
    // Contact extraction from filed email (services/contacts). See
    // EmailContactExtractor for the why.
    // ─────────────────────────────────────────────────────────────────────────

    contacts = null;

    /** Filed where a user navigates: not the backends mirror, not the trash, not a context root. */
    async isUserFiled(id, { authoredRoot = false } = {}) {
        const placements = await this.#workspace.listDocumentPlacements(id);
        const rootIsAuthored = authoredRoot && !placements.some(({ tree, paths }) => paths.length && (tree === Workspace.BACKENDS_TREE_NAME || paths.some(p => p === Workspace.TRASH_PATH || p.startsWith(`${Workspace.TRASH_PATH}/`))));
        return placements.some(({ tree, type, paths }) => tree !== Workspace.BACKENDS_TREE_NAME && paths.some((path) =>
            !(type === Workspace.CONTEXT_TYPE && path === '/' && !rootIsAuthored)
            && !(type === Workspace.DIRECTORY_TYPE && (path === Workspace.TRASH_PATH || path.startsWith(`${Workspace.TRASH_PATH}/`)))));
    }

    startContactExtraction() {
        if (this.contacts) return;
        const db = this.#runtime.getActiveDb();
        this.contacts = new ContactExtractor({
            get: (id) => this.#workspace.get(id),
            getMany: async (ids) => {
                const result = await this.#workspace.getDocumentsByIdArray(ids, { parse: false });
                if (result.error) throw new Error(result.error);
                return result.data;
            },
            listIds: async () => {
                const ids = await db.list({ context: null, directory: null,
                    attributes: { anyOf: ['data/schema/message', 'data/schema/identity'] }, idsOnly: true, limit: 0 });
                if (ids.error) throw new Error(ids.error);
                return ids;
            },
            isUserFiled: (id) => this.isUserFiled(id),
            listRelations: (id) => this.#workspace.listDocumentRelations(id),
            putMany: (records) => this.#workspace.putMany(records, { context: null }),
            reconcileRelations: (entries, options) => db.reconcileDerivedRelations(entries, options),
            ownAddresses: () => this.#runtime.integrations.mailReadonly().ownAddresses().catch(() => []),
            logger: this.#runtime.state.logger,
        });
        for (const event of ['document.linked', 'document.inserted', 'document.updated', 'document.deleted']) {
            this.#workspace.on(event, this.#onDocumentFiled);
            this.#workspace.on(`${event}.batch`, this.#onDocumentFiled);
        }
        // Build a compact participant lookup and repair known-contact edges in
        // the background. No Lance queries and no contact creation from mirrors.
        this.contacts.extract([]).catch(() => {});
    }

    async stopContactExtraction() {
        if (!this.contacts) return;
        for (const event of ['document.linked', 'document.inserted', 'document.updated', 'document.deleted']) {
            this.#workspace.off(event, this.#onDocumentFiled);
            this.#workspace.off(`${event}.batch`, this.#onDocumentFiled);
        }
        await this.contacts.stop();
        this.contacts = null;
    }

    // Backend-only messages still relate to KNOWN identities. The service
    // checks filing separately before it may create a new identity.
    #onDocumentFiled = (payload) => {
        if (!this.contacts) return;
        const ids = Array.isArray(payload?.ids) ? payload.ids : (payload?.id != null ? [payload.id] : []);
        this.contacts.enqueue(ids);
    };

    /** The identity carrying this email address (alias-key lookup), or null. */
    async findIdentityByEmail(address) {
        const key = Identity.emailAliasKey(address);
        if (!key) return null;
        const doc = await this.#runtime.getActiveDb().getByChecksumString(key).catch(() => null);
        return doc?.id ?? null;
    }

    /** Settle queued extraction (tests / maintenance callers). */
    async drainContactExtraction() { await this.contacts?.drain(); }

    // A contact may have just been saved while the debounced worker is pending.
    // Reconcile before serving its Relations tab so the first read is current.
    async refreshContactRelations(document) {
        if (document?.schema === 'data/schema/identity' || document?.schema?.startsWith('data/schema/identity/')) {
            await this.contacts?.refresh([document.id]);
        }
    }

    /** Extract contacts for every email filed in user trees (manual re-run). */
    async extractEmailContacts() {
        if (!this.contacts) throw new Error('Workspace is not active');
        const ids = await this.#workspace.list({ features: ['data/schema/message/email'], context: null, directory: null, idsOnly: true, limit: 0 });
        return this.contacts.extract(Array.isArray(ids) ? ids : []);
    }

    async extractMessageContacts() {
        if (!this.contacts) throw new Error('Workspace is not active');
        const ids = await this.#workspace.list({ features: ['data/schema/message'], context: null, directory: null, idsOnly: true, limit: 0 });
        return this.contacts.extract(Array.isArray(ids) ? ids : []);
    }
}
