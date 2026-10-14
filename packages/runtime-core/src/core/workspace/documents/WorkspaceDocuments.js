import { readMessageThread } from '../services/messages/thread.js';

import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';

import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { WorkspaceConnectorIndex, connectorDriverForProvenanceUrl } from '../services/connectors/index.js';
import Workspace from '../Workspace.js';

export default class WorkspaceDocuments {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    #normalizeFeatureInput(features = [], attributes) {
        return features.length > 0 ? features : (attributes?.allOf ?? attributes ?? []);
    }

    // Extract raw path strings from a context/directory input (string | string[] |
    // { tree?, path }). The tree qualifier is dropped on purpose: a workspace has
    // exactly one context tree and one directory tree, so the db's ctx:/dir:
    // default-tree resolution always lands on them.
    static #extractPaths(value) {
        if (value == null) { return []; }
        let paths = value;
        if (typeof value === 'object' && !Array.isArray(value)) {
            paths = value.path ?? value.context ?? value.directory ?? '/';
        }
        return (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string');
    }

    static #buildPaths(context, directory) {
        return [
            ...WorkspaceDocuments.#extractPaths(context).map((p) => `ctx:${p}`),
            ...WorkspaceDocuments.#extractPaths(directory).map((p) => `dir:${p}`),
        ];
    }

    static #isTreeQualified(value) {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value.tree ?? value.treeId));
    }

    // Write-target spec for db.put/link/unlink. The ctx:/dir: paths grammar can
    // only address the DEFAULT trees, so tree-qualified selectors (e.g. the
    // backends tree) must be passed through as selector objects instead.
    static buildWriteSpec(context, directory) {
        if (WorkspaceDocuments.#isTreeQualified(context) || WorkspaceDocuments.#isTreeQualified(directory)) {
            const toSelector = (value) => {
                if (value == null) { return null; }
                if (typeof value === 'object' && !Array.isArray(value)) { return value; }
                return { path: value };
            };
            return { context: toSelector(context), directory: toSelector(directory) };
        }
        return { paths: WorkspaceDocuments.#buildPaths(context, directory) };
    }

    normalizeQuerySpec(spec = {}) {
        const { attributes, features = null, context, directory, limit = 200, ...rest } = spec;
        // Tree-qualified selectors survive as selector objects (parseSpec keeps
        // the tree id per entry); the paths string grammar targets default trees.
        if (WorkspaceDocuments.#isTreeQualified(context) || WorkspaceDocuments.#isTreeQualified(directory)) {
            return {
                limit,
                ...rest,
                ...(context != null ? { context } : {}),
                ...(directory != null ? { directory } : {}),
                ...(features != null ? { features } : {}),
                ...(features == null && attributes != null ? { features: attributes } : {}),
            };
        }
        const paths = WorkspaceDocuments.#buildPaths(context, directory);
        return {
            limit,
            ...rest,
            ...(paths.length ? { paths } : {}),
            ...(features != null ? { features } : {}),
            ...(features == null && attributes != null ? { features: attributes } : {}),
        };
    }

    #assertBackendsWriteAllowed(directory, allowBackendsWrite = false) {
        if (allowBackendsWrite || directory == null) { return; }
        if (this.#isBackendsTreeSelector(directory)) {
            throw new Error('Backends tree is read-only through the generic document API');
        }
    }

    // Does a directory selector target the backends tree? (by tree id or name)
    #isBackendsTreeSelector(directory) {
        if (!WorkspaceDocuments.#isTreeQualified(directory)) { return false; }
        const backends = this.#runtime.state.db?.getTree(Workspace.BACKENDS_TREE_NAME);
        if (!backends) { return false; }
        const target = this.#runtime.state.db.getTree(directory.tree ?? directory.treeId);
        return target?.id === backends.id;
    }

    async put(record, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false, provenance = null } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        const writtenThrough = allowBackendsWrite
            ? null
            : await this.#connectorWriteThrough(record, this.#normalizeFeatureInput(features, attributes));
        if (writtenThrough) return writtenThrough.id;
        const result = await this.#runtime.getActiveDb().put(record, {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
        // A re-put of identical content resolves to the SAME document by
        // checksum, so this is also the path a copy-then-delete move takes.
        if (!allowBackendsWrite && (context != null || directory != null)) await this.#runtime.trash.untrashOnLink(result).catch(() => {});
        return result;
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false, provenance = null } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        const result = await this.#runtime.getActiveDb().link(id, {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
        if (!allowBackendsWrite && (context != null || directory != null)) await this.#runtime.trash.untrashOnLink(id).catch(() => {});
        await this.#cascadeThreadContext('link', [id], context, emitEvent);
        // Silent automation links still make backend-only documents eligible
        // for extraction. Schedule inference without re-entering hook rules.
        if (!emitEvent) this.#runtime.inference.onDocEventForEmbed({ id });
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Threads — the thread is the unit of work, the message is the unit of
    // storage. See docs/connectors.md "Threads".
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Every message below this one on the `replies-to` incoming axis. Chat
     * drivers point each reply at the thread ROOT (Slack `thread_ts`, Graph
     * `replyToId`), so that is one hop; email points at the IMMEDIATE parent
     * (In-Reply-To), so a thread is a chain and the walk is a bounded BFS.
     * Each iterator is drained synchronously (LMDB read-txn caveat).
     */
    #threadReplyIds(id) {
        const rootId = parseDocumentId(id, 'Document ID');
        const seen = new Set([rootId]);
        const queue = [rootId];
        const out = [];
        try {
            const edges = this.#runtime.getActiveDb().edges;
            while (queue.length && out.length < Workspace.THREAD_CASCADE_LIMIT) {
                const current = queue.shift();
                for (const replyId of [...edges.incoming(current, 'replies-to')].map(Number)) {
                    if (seen.has(replyId)) continue;
                    seen.add(replyId);
                    out.push(replyId);
                    queue.push(replyId);
                }
            }
        } catch { /* no edge plane (degraded db) — nothing to cascade */ }
        return out;
    }

    /** Upper bound on replies one link/unlink will drag along. */
    static THREAD_CASCADE_LIMIT = 1000;

    /**
     * Filing a thread root into a context pulls its replies along; taking it
     * out takes them out. CONTEXT tree only: directory (backends) placement is
     * where the bytes came from, and a reply already lives beside its root
     * there. Transitive over `replies-to` (bounded), and a reply that fails to
     * follow never fails the caller's own link. `/` is skipped — every
     * document is at the context root already and unlink refuses to remove it.
     */
    async #cascadeThreadContext(op, ids, context, emitEvent = true) {
        if (context == null) return;
        if (typeof context === 'string' && (context.trim() === '' || context.trim() === '/')) return;
        const db = this.#runtime.getActiveDb();
        for (const id of ids) {
            const replies = this.#threadReplyIds(id);
            if (!replies.length) continue;
            const spec = { ...WorkspaceDocuments.buildWriteSpec(context, null), features: [], emitEvent };
            for (const replyId of replies) {
                if (Number(replyId) === Number(id)) continue;
                await (op === 'link' ? db.link(replyId, spec) : db.unlink(replyId, spec)).catch((error) =>
                    this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, root: id, reply: replyId, op, error: error.message }, 'Thread membership cascade failed'));
            }
        }
    }

    /** Paths from `paths` that are not a strict prefix (ancestor) of another. */
    static leafPaths(paths = []) {
        const list = [...new Set((paths || []).filter(Boolean))];
        return list.filter((p) => !list.some((q) => q !== p && q.startsWith(p.endsWith('/') ? p : `${p}/`)));
    }

    /**
     * Copy a thread root's CONTEXT placements onto a reply. The ingest-side
     * half of the thread rule: a reply that arrives after its root was curated
     * lands where the root is. Directory placements are deliberately not
     * copied — the connector already filed the reply under its channel.
     */
    async inheritThreadMemberships(replyId, rootId) {
        if (this.#workspace.isRemovalHeld(replyId)) return;
        const reply = parseDocumentId(replyId, 'Reply document ID');
        const root = parseDocumentId(rootId, 'Root document ID');
        if (reply === root) return 0;
        let copied = 0;
        for (const placement of await this.#workspace.listDocumentPlacements(root)) {
            if (placement.type !== 'context') continue;
            // A context path ANDs the layers along it, so memberships list
            // every ancestor too; linking the leaves ticks those already.
            for (const treePath of Workspace.leafPaths(placement.paths)) {
                if (!treePath || treePath === '/') continue;
                await this.#runtime.getActiveDb().link(reply, { context: { tree: placement.treeId, path: treePath }, features: [], emitEvent: true });
                copied++;
            }
        }
        return copied;
    }

    /**
     * Remove a document from a path. Non-destructive: the document survives in
     * the store and in every other path it is filed under.
     *
     * `options.trashIfOrphaned` adds the filesystem-mount rule — if this was the
     * document's LAST placement it is filed into the trash path instead of
     * becoming reachable only through the flat workspace-wide list. See
     * `docs/data-representation.md`.
     */
    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        const { trashIfOrphaned = false, ...dbOptions } = options;

        // Snapshot placements BEFORE the unlink — afterwards the very paths a
        // restore would have to put the document back into are gone.
        const placementsBefore = trashIfOrphaned
            ? await this.#workspace.listDocumentPlacements(id).catch(() => [])
            : null;

        const result = await this.#runtime.getActiveDb().unlink(id, {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...dbOptions,
        });

        if (trashIfOrphaned) { await this.#runtime.trash.trashIfOrphaned(id, placementsBefore); }
        await this.#cascadeThreadContext('unlink', [id], context);
        return result;
    }

    async delete(id, options = {}) {
        const docId = parseDocumentId(id, 'Document ID');
        const { managedBlobs, checksums } = await this.#collectDeletionArtifacts([docId]);
        const result = await this.#runtime.getActiveDb().delete(docId, options);
        if (result) {
            await this.#workspace.trashOperations.release(docId);
            await this.#cascadeManagedBlobDeletion(managedBlobs);
            await this.#purgeDeletedDocThumbnails(checksums);
        }
        return result;
    }

    async get(id, options = { parse: true }) {
        return await this.#runtime.getActiveDb().get(parseDocumentId(id, 'Document ID'), options);
    }

    async has(id, { context = null, directory = null, features = [], attributes } = {}) {
        return await this.#runtime.getActiveDb().has(parseDocumentId(id, 'Document ID'), {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async putMany(records, { context = '/', directory = null, features = [], attributes, allowBackendsWrite = false } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);

        // Documents that mirror a remote object go to their source first (see
        // #connectorWriteThrough). Everything else keeps the single batched
        // write it always had — the split only happens when the batch actually
        // contains a mirrored document, which is the rare case.
        const list = Array.isArray(records) ? records : [records];
        const normalizedFeatures = this.#normalizeFeatureInput(features, attributes);
        const writtenThrough = allowBackendsWrite ? [] : await Promise.all(
            list.map((record) => this.#connectorWriteThrough(record, normalizedFeatures)),
        );
        if (!writtenThrough.some(Boolean)) {
            return await this.#runtime.getActiveDb().putMany(list, {
                ...WorkspaceDocuments.buildWriteSpec(context, directory),
                features: this.#normalizeFeatureInput(features, attributes),
            });
        }

        const localIndexes = [];
        const local = [];
        list.forEach((record, index) => {
            if (writtenThrough[index]) return;
            localIndexes.push(index);
            local.push(record);
        });
        const localIds = local.length
            ? await this.#runtime.getActiveDb().putMany(local, {
                ...WorkspaceDocuments.buildWriteSpec(context, directory),
                features: this.#normalizeFeatureInput(features, attributes),
            })
            : [];

        // Reassemble in the caller's order — a batch's result array is
        // positional, and callers match ids back to what they sent.
        const out = list.map((_, index) => writtenThrough[index]?.id ?? null);
        localIndexes.forEach((index, i) => { out[index] = Array.isArray(localIds) ? localIds[i] : null; });
        return out;
    }

    /**
     * Write-through to a connector source.
     *
     * A document that mirrors a remote object (a synced GitHub issue, a CalDAV
     * event) must be changed AT THE SOURCE, not in the mirror: the sync cursor
     * would otherwise overwrite a local-only edit at the next poll and the user
     * would watch their change silently revert. So an update of such a document
     * goes to the driver first, and what the source returns is re-ingested —
     * identity is the provenance URL, so that is a clean upsert of the same
     * document.
     *
     * Returns `{ id }` when it took the write, `null` to fall through to the
     * ordinary local write. Falls through — rather than failing — whenever the
     * document is not a live mirror or its backend cannot push updates, so a
     * read-only connector keeps behaving exactly as before. It does NOT swallow
     * remote failures: once this path is taken, a driver error propagates,
     * because an edit that silently landed only locally is worse than an error.
     */
    async #connectorWriteThrough(record, features = []) {
        const id = Number(record?.id);
        if (!Number.isInteger(id) || id <= 0) return null;
        const patch = record?.data;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;

        const existing = await this.#workspace.get(id).catch(() => null);
        if (!existing) return null;

        const provenanceUrl = (existing.locations || [])
            .map((location) => (typeof location === 'string' ? location : location?.url))
            .find((url) => connectorDriverForProvenanceUrl(url));
        if (!provenanceUrl) return null;

        /*
         * Falling through with a mirrored document still costs something: a
         * plain local write recomputes the checksum array from content, which
         * DESTROYS the identity checksum (sha256 of the provenance URL) the
         * connector dedups on — so the next sync no longer recognises the
         * document and forks a duplicate beside it. Re-stamping the identity
         * keeps the document a mirror: the local edit stands until the source
         * next contradicts it, which is the honest outcome for something the
         * user cannot actually write to.
         */
        const fallThroughLocally = () => {
            if (record.checksumArray === undefined) {
                record.checksumArray = [WorkspaceConnectorIndex.identityChecksum(provenanceUrl)];
            }
            return null;
        };

        // Boot the connector service only now — the provenance URL already
        // proves this document mirrors a source, so the cost lands on the one
        // update that needs it rather than on every document write. (The
        // service does not auto-start unless the home backend is enabled.)
        const connectors = await this.#runtime.integrations.connectors().catch(() => null);
        if (!connectors) return fallThroughLocally();

        const target = await connectors
            .resolveBackendForProvenance(provenanceUrl, existing.metadata?.connector)
            .catch(() => null);
        if (!target) return fallThroughLocally();
        if (!connectors.supportsWrite(target.driver, target.address, 'update')) return fallThroughLocally();

        let result;
        try {
            result = await connectors.updateDocument(
                target.driver, target.address, { provenanceUrl }, patch, { features },
            );
        } catch (error) {
            // The source refused (revoked token, missing scope, deleted object).
            // Retag it so the transport can pass the reason through instead of a
            // generic 500 — "Failed to update documents" tells the user nothing
            // about the one thing that actually went wrong.
            const rejected = new Error(`${target.driver} rejected the change: ${error.message}`);
            rejected.code = 'ECONNECTORWRITE';
            rejected.cause = error;
            throw rejected;
        }
        this.#runtime.state.logger.debug({ workspaceId: this.#workspace.id, docId: id, provenanceUrl }, 'Document update written through to connector source');
        return { id: result?.docId ?? id };
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const result = await this.#runtime.getActiveDb().linkMany(docIds, {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
        await this.#cascadeThreadContext('link', docIds, context, emitEvent);
        return result;
    }

    /** Bulk `unlink`; `options.trashIfOrphaned` applies the same rule per document. */
    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const { trashIfOrphaned = false, ...dbOptions } = options;

        const placementsBefore = new Map();
        if (trashIfOrphaned) {
            for (const docId of docIds) {
                placementsBefore.set(docId, await this.#workspace.listDocumentPlacements(docId).catch(() => []));
            }
        }

        const result = await this.#runtime.getActiveDb().unlinkMany(docIds, {
            ...WorkspaceDocuments.buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...dbOptions,
        });

        if (trashIfOrphaned) {
            for (const entry of (result?.successful ?? [])) {
                const docId = entry?.id ?? entry;
                await this.#runtime.trash.trashIfOrphaned(docId, placementsBefore.get(docId) || []).catch(() => {});
            }
        }
        await this.#cascadeThreadContext('unlink', docIds, context);
        return result;
    }

    async deleteMany(ids, options = {}) {
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const { managedBlobs, checksums } = await this.#collectDeletionArtifacts(docIds);
        const result = await this.#runtime.getActiveDb().deleteMany(docIds, options);
        const deletedIds = new Set((result?.successful ?? []).map((entry) => entry?.id ?? entry));
        for (const id of deletedIds) await this.#workspace.trashOperations.release(id);
        await this.#cascadeManagedBlobDeletion(managedBlobs, deletedIds);
        await this.#purgeDeletedDocThumbnails(checksums, deletedIds);
        return result;
    }

    /**
     * Pre-delete snapshot for a plain index-delete's side effects:
     * - managedBlobs: documents whose EVERY location lives on a managed stored
     *   backend (workspace:data — opaque, non-browseable by design) would
     *   orphan their blobs; the URLs are collected so the bytes can be removed
     *   after the delete succeeds. Documents with any user-owned location
     *   (workspace:home file, imap message, device) are never touched.
     * - checksums: primary checksum per doc, so cached thumbnails (derived
     *   artifacts keyed thumb:<checksum>:<size>) can be dropped too.
     */
    async #collectDeletionArtifacts(ids) {
        const managedBackends = new Set(Object.entries(this.#workspace.dataBackends || {})
            .filter(([, cfg]) => cfg?.managed === true && cfg?.readOnly !== true && cfg?.enabled !== false)
            .map(([name]) => name));
        const managedBlobs = new Map();
        const checksums = new Map();
        if (ids.length === 0) { return { managedBlobs, checksums }; }

        const fetched = await this.#workspace.getDocumentsByIdArray(ids, { parse: false }).catch(() => null);
        const docs = Array.isArray(fetched) ? fetched : (fetched?.data ?? []);
        for (const doc of docs.filter(Boolean)) {
            if (Array.isArray(doc.checksumArray) && doc.checksumArray[0]) {
                checksums.set(doc.id, doc.checksumArray[0]);
            }
            const urls = (doc.locations || []).map((l) => l?.url).filter(Boolean);
            if (urls.length === 0 || managedBackends.size === 0) { continue; }
            const allManaged = urls.every((url) => {
                const parsed = parseLocationUrl(url);
                return parsed?.scheme === 'stored' && managedBackends.has(parsed.backend);
            });
            if (allManaged) { managedBlobs.set(doc.id, urls); }
        }
        return { managedBlobs, checksums };
    }

    // Cache hygiene, not correctness (thumbnails are content-addressed): drop
    // deleted docs' cached thumbnails so derived artifacts don't accumulate.
    // Skipped when the stored index isn't running — not worth booting it for.
    async #purgeDeletedDocThumbnails(checksums, deletedIds = null) {
        if (!checksums || checksums.size === 0 || !this.#runtime.state.storedIndex?.isRunning) { return; }
        const targets = [];
        for (const [docId, checksum] of checksums) {
            if (deletedIds && !deletedIds.has(docId)) { continue; }
            targets.push(checksum);
        }
        if (targets.length > 0) {
            await this.#runtime.state.storedIndex.purgeThumbnails(targets).catch(() => {});
        }
    }

    /** Wipe every cached thumbnail (regenerated on demand). */
    async clearThumbnailCache() {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return await this.#runtime.state.storedIndex.clearThumbnailCache();
    }

    async #cascadeManagedBlobDeletion(byId, deletedIds = null) {
        if (!byId || byId.size === 0) { return; }
        if (!this.#runtime.state.storedIndex?.isRunning) { await this.#runtime.integrations.startStoredIndex().catch(() => null); }
        if (!this.#runtime.state.storedIndex?.isRunning) { return; }
        for (const [docId, urls] of byId) {
            if (deletedIds && !deletedIds.has(docId)) { continue; }
            for (const url of urls) {
                await this.#runtime.state.storedIndex.deleteStoredUrl(url).catch((err) =>
                    this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, docId, url, error: err.message }, 'Blob cascade: failed to delete managed blob'));
            }
        }
    }

    async getByChecksumString(checksumString, options = { parse: true }) {
        return await this.#runtime.getActiveDb().getByChecksumString(checksumString, options);
    }

    async listDocumentTreeMemberships(id, treeNameOrId) {
        return await this.#runtime.getActiveDb().listDocumentTreeMemberships(parseDocumentId(id, 'Document ID'), treeNameOrId);
    }

    /**
     * Every place this document is filed: which paths of which trees hold it.
     * The data behind the Synapses tab, and the basis of the orphan test and of
     * trash restore provenance.
     */
    async listDocumentPlacements(id) {
        const docId = parseDocumentId(id, 'Document ID');
        const placements = [];
        for (const tree of await this.#workspace.listTrees()) {
            if (!tree) { continue; }
            const paths = await this.#workspace.listDocumentTreeMemberships(docId, tree.id);
            placements.push({ tree: tree.name, treeId: tree.id, type: tree.type, paths });
        }
        return placements;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Relations — typed doc<->doc edges (synapsd edge plane)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Assert `from --predicate--> to` by writing it through the subject
     * document's own `data.relations`; synapsd derives the edge from the row.
     * The row is the source of truth — a rebuilt edge plane (`rebuildL3`)
     * reconstructs every user-drawn relation, which a bare edge-plane write
     * could not promise. (Relations are structural, not content: checksums,
     * FTS and embeddings all strip them, so this causes no dedup churn or
     * re-embed.) Idempotent: asserting a declared relation is a no-op.
     */
    async assertRelation(fromId, predicate, toId) {
        return await this.#runtime.getActiveDb().assertRelation(
            parseDocumentId(fromId, 'Relation source document ID'),
            predicate,
            parseDocumentId(toId, 'Relation target document ID'),
        );
    }

    /**
     * Retract an asserted relation: remove it from the subject row's
     * `data.relations` and drop the derived edge. Derived (extractor/agent)
     * edges between the same pair survive — they are not the row's to delete.
     * Returns false when the row does not declare it (or no longer exists).
     */
    async retractRelation(fromId, predicate, toId) {
        return await this.#runtime.getActiveDb().retractRelation(
            parseDocumentId(fromId, 'Relation source document ID'),
            predicate,
            parseDocumentId(toId, 'Relation target document ID'),
        );
    }

    /**
     * Every edge touching this document, both directions, with provenance.
     * `meta.src` is 'doc' for asserted edges (the synthesized default) and
     * 'extractor:<name>' / 'agent:<hookId>' for derived ones — the UI only
     * offers to delete the former.
     */
    async messageThread(id, { contextPath = null } = {}) {
        const docId = parseDocumentId(id, 'Document ID');
        const message = await this.#workspace.get(docId);
        if (!message) throw Object.assign(new Error('Message not found'), { statusCode: 404 });
        if (!['data/schema/message', 'data/schema/message/email'].includes(message.schema)) {
            throw Object.assign(new Error('This document is not a message'), { statusCode: 400 });
        }
        return readMessageThread(docId, {
            edges: this.#runtime.getActiveDb().edges,
            getMany: (ids) => this.#workspace.getDocumentsByIdArray(ids),
            allowedIds: contextPath ? (ids) => this.#workspace.list({ context: contextPath, ids, idsOnly: true, limit: 200 }) : null,
        });
    }

    listDocumentRelations(id) {
        const docId = parseDocumentId(id, 'Document ID');
        const edges = this.#runtime.getActiveDb().edges;
        const { outgoing, incoming } = edges.edgesOf(docId);
        return {
            outgoing: outgoing.map(({ p, to }) => ({ p, to, meta: edges.edge(docId, p, to)?.meta ?? null })),
            incoming: incoming.map(({ p, from }) => ({ p, from, meta: edges.edge(from, p, docId)?.meta ?? null })),
        };
    }

    async hasByChecksumString(checksumString, { context = null, directory = null, features = [], attributes } = {}) {
        return await this.#runtime.getActiveDb().hasByChecksumString(checksumString, {
            paths: WorkspaceDocuments.#buildPaths(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    // Emit a tree-scoped document event for a known selection (e.g. after a
    // scoped purge) so cross-client consumers (browser extension auto-close, web
    // UI) refresh. Selectors are { tree, path } as returned by
    // get{Context,Directory}TreeSelector; pass whichever applies.
    emitTreeDocumentEvent(eventName, { context = null, directory = null, documentIds = [] } = {}) {
        this.#runtime.getActiveDb().emitTreeDocumentEvent(eventName, { context, directory, documentIds });
    }
}
