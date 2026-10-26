import { availableLocations } from 'canvas-synapsd/src/utils/document-locations.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { normalizeSegment } from '../../../utils/backend-documents.js';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { backendIdentity, normalizeRemovalPolicy } from '../storage/removal-policy.js';
import Workspace from '../Workspace.js';
import WorkspaceDocuments from './WorkspaceDocuments.js';

export default class WorkspaceTrash {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    // ─────────────────────────────────────────────────────────────────────────
    // Trash — see docs/data-representation.md
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Is this document filed anywhere a user can navigate to?
     *
     * The root of a CONTEXT tree does not count. Every insert ticks it (tree
     * setting `linkContextRoot`) and `unlink` refuses to remove it, so a `/`
     * membership there means "exists in this workspace", not "filed somewhere" —
     * counting it would make every document look filed forever and the orphan
     * test a constant false. A directory tree's `/` DOES count: it is a real
     * folder and nothing ticks it implicitly.
     */
    static #isFiled(placements) {
        return placements.some(({ type, paths }) =>
            paths.some((path) => !(type === Workspace.CONTEXT_TYPE && path === '/')));
    }

    getTrashSelector() {
        return this.#workspace.getDirectoryTreeSelector(Workspace.TRASH_PATH, Workspace.DIRECTORY_TREE_NAME);
    }

    async observeSourceRemoval({ document, removedLocations, remainingLocations, source, suppressPolicy = false, manualRemoval = false, keepDocument = false }) {
        const groups = new Map();
        for (const location of removedLocations) {
            const parsed = parseLocationUrl(location.url);
            const backend = source?.backend || location.metadata?.backend || parsed?.backend;
            if (!backend) continue;
            if (!groups.has(backend)) groups.set(backend, []);
            groups.get(backend).push(location);
        }
        const ids = [];
        for (const [backend, locations] of groups) {
            const config = this.#workspace.dataBackends[backend] || {};
            const survives = remainingLocations.some(l => (l.metadata?.backend || parseLocationUrl(l.url)?.backend) === backend);
            ids.push(await this.#workspace.trashOperations.observe({ document, removedLocations: locations, remainingLocations, suppressPolicy, manualRemoval, keepDocument,
                source: { ...(source || { backend, driver: config.driver || 'unknown', policy: config.removalPolicy, survives }), backendIdentity: backendIdentity(config) } }));
        }
        return ids;
    }

    async finishRemovalObservation(operation, document) {
        await this.#runtime.state.storedIndex.reconcileRemovedLocations(document, operation.removedLocations.map(l => l.url), { notify: false });
    }

    async trashFromSourceLoss(id, placements, operationId) {
        const db = this.#runtime.getActiveDb();
        const old = db.internalStore.get(this.#trashProvenanceKey(id));
        // Persist restore provenance before unfiling; replay never replaces it
        // with the partially-unlinked placement set.
        if (!old) await db.internalStore.put(this.#trashProvenanceKey(id), {
            trashedAt: new Date().toISOString(), reason: 'source-missing', operationId, placements,
        });
        for (const placement of placements) for (const path of [...placement.paths].sort((a, b) => b.length - a.length)) {
            const spec = placement.type === 'context'
                ? { context: { tree: placement.treeId, path } }
                : { context: null, directory: { tree: placement.treeId, path } };
            await db.unlink(id, { ...WorkspaceDocuments.buildWriteSpec(spec.context, spec.directory), emitEvent: false });
        }
        await db.link(id, { context: null, directory: this.#workspace.getTrashSelector(), emitEvent: false });
        this.#trashedIds?.add(id);
        this.#workspace.emit('trash.changed', { documentId: id });
    }

    async removeTrackedCopy(operation, target) {
        const stored = this.#runtime.state.storedIndex?.stored;
        const config = this.#workspace.dataBackends[target.backend];
        if (target.backendIdentity !== backendIdentity(config)) throw new Error('Destination backend configuration changed; review the current copy');
        if (!config || config.enabled === false || config.readOnly || !normalizeRemovalPolicy(config.removalPolicy).acceptPropagatedDeletions) {
            throw new Error(`Backend ${target.backend} does not accept propagated deletions`);
        }
        if (!stored?.removeToTrash) throw new Error('Recoverable removal requires the updated canvas-stored runtime');
        const ownerName = `workspace-document:${operation.documentId}`;
        if (stored.replicas.owners().some(owner => owner.owner !== ownerName && owner.replicas.some(r => r.backend === target.backend && r.key === target.key))) {
            throw new Error('Another storage policy owner still needs this copy');
        }
        const result = await stored.removeToTrash(target.backend, target.key, {
            operationId: JSON.stringify([operation.id, target.backend, target.key]), sha256: operation.checksum,
        });
        if (!result.ok) throw new Error(result.reason || 'Copy removal failed');
        return result;
    }

    async verifyRemovalSource(operation) {
        if (operation.source.backendIdentity !== backendIdentity(this.#workspace.dataBackends[operation.source.backend] || {})) {
            throw new Error('Source backend configuration changed; deletion is paused');
        }
        if (operation.source.driver === 'imap') return this.#runtime.state.mailIndex.verifyRemovalSource(operation);
        const stored = this.#runtime.state.storedIndex?.stored;
        for (const endpoint of this.#runtime.state.storedIndex.locationEndpoints({ locations: operation.removedLocations })) {
            const backend = stored.getBackend(endpoint.backend);
            // Removing a backend configuration is not proof that its bytes
            // disappeared. Leave that operation for review until it is reachable.
            if (!backend) throw new Error('Source backend is unavailable; deletion is paused');
            if (typeof backend.verifyRoot === 'function' && !(await backend.verifyRoot()).ok) throw new Error('Source backend is unreachable; deletion is paused');
            if (await backend.stat(endpoint.key)) throw new Error('The source path exists again; review the current item');
        }
    }

    async actOnRemovalCopy(target, action) {
        const stored = this.#runtime.state.storedIndex?.stored;
        if (!stored) throw new Error('Storage is not running');
        return action === 'restore' ? stored.restoreTrash(target.backend, target.trashId, { origin: 'trash:restore' })
            : stored.discardTrash(target.backend, target.trashId);
    }

    async setMailboxRemovalPolicy(address, folder, policy) {
        const mailbox = (await this.#workspace.listImapMailboxes()).find(m => normalizeSegment(m.user || m.account) === normalizeSegment(address) && m.folder === folder);
        if (!mailbox) throw Object.assign(new Error('Mailbox not found'), { statusCode: 404 });
        await this.#workspace.saveImapMailbox({ id: mailbox.id, removalPolicy: normalizeRemovalPolicy(policy) });
        return this.#workspace.getBackend('imap', address);
    }

    #trashProvenanceKey(docId) { return `workspace/trash/${docId}`; }

    // File an orphaned document into the trash path. `placementsBefore` is the
    // snapshot taken before the unlink that orphaned it — restore puts it back
    // exactly there.
    async trashIfOrphaned(id, placementsBefore = null) {
        const docId = parseDocumentId(id, 'Document ID');

        // Only an unlink that ORPHANS a document trashes it. A document that was
        // already filed nowhere (never filed, or detached earlier by the plain
        // API) is left alone: this unlink changed nothing, and sweeping such
        // documents into the trash on an unrelated bulk remove would be a
        // surprise — with no provenance to restore them by, at that.
        if (placementsBefore && !WorkspaceTrash.#isFiled(placementsBefore)) { return false; }

        const placements = await this.#workspace.listDocumentPlacements(docId);
        if (WorkspaceTrash.#isFiled(placements)) { return false; }

        const db = this.#runtime.getActiveDb();
        await db.link(docId, { context: null, directory: this.#workspace.getTrashSelector() });
        await db.internalStore.put(this.#trashProvenanceKey(docId), {
            trashedAt: new Date().toISOString(),
            placements: (placementsBefore || []).map(({ tree, treeId, type, paths }) => ({
                tree, treeId, type,
                // A context root is not a place to restore to (see #isFiled).
                paths: paths.filter((path) => !(type === Workspace.CONTEXT_TYPE && path === '/')),
            })).filter((placement) => placement.paths.length > 0),
        });
        this.#trashedIds?.add(docId);
        return true;
    }

    // Ids currently in the trash, so the untrash-on-link check on the write path
    // is a Set lookup rather than an index read. Seeded lazily; kept in sync by
    // the trash operations themselves (all of which live in this class).
    #trashedIds = null;

    async #loadTrashedIds() {
        if (this.#trashedIds) { return this.#trashedIds; }
        const { ids } = await this.#runtime.getActiveDb()
            .listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, { path: Workspace.TRASH_PATH, idsOnly: true })
            .catch(() => ({ ids: [] }));
        this.#trashedIds = new Set(ids || []);
        return this.#trashedIds;
    }

    /**
     * Filing a document anywhere real takes it out of the trash. This is what
     * makes a file manager's copy-then-delete move self-healing regardless of
     * which half lands first — content addressing resolves the copy to the same
     * document, and if the delete got there first, the copy un-trashes it.
     */
    async untrashOnLink(idOrResult) {
        // put() answers with an id (or a result carrying one); link() is called
        // with the id directly.
        const raw = (idOrResult && typeof idOrResult === 'object') ? idOrResult.id : idOrResult;
        if (raw === undefined || raw === null) { return false; }
        const docId = parseDocumentId(raw, 'Document ID');

        await this.#workspace.trashOperations.release(docId);
        const trashed = await this.#loadTrashedIds();
        if (!trashed.has(docId)) { return false; }

        const db = this.#runtime.getActiveDb();
        await db.unlink(docId, { context: null, directory: this.#workspace.getTrashSelector() });
        await db.internalStore.remove(this.#trashProvenanceKey(docId));
        trashed.delete(docId);
        return true;
    }

    async listTrash({ limit = null, offset = 0, parse = true } = {}) {
        const db = this.#runtime.getActiveDb();
        const result = await db.listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, {
            path: Workspace.TRASH_PATH, limit, offset, parse,
        });
        const documents = (result.documents || []).map((document) => ({
            ...document,
            trashed: db.internalStore.get(this.#trashProvenanceKey(document.id)) || null,
        }));
        return { ...result, documents };
    }

    /**
     * Put documents back where they were when they were trashed. Missing tree
     * paths are recreated — a restore whose folder was deleted meanwhile should
     * still land somewhere, not fail.
     */
    async restoreFromTrash(ids) {
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const db = this.#runtime.getActiveDb();
        const restored = [];
        const failed = [];

        for (const docId of docIds) {
            try {
                const provenance = db.internalStore.get(this.#trashProvenanceKey(docId));
                let relinked = 0;
                for (const placement of (provenance?.placements || [])) {
                    for (const path of placement.paths) {
                        const tree = this.#workspace.getTree(placement.treeId) || this.#workspace.getTree(placement.tree);
                        if (!tree) { continue; }
                        if (!tree.pathExists(path)) { await tree.insertPath(path); }
                        const selector = placement.type === Workspace.DIRECTORY_TYPE
                            ? { context: null, directory: this.#workspace.getDirectoryTreeSelector(path, tree.name) }
                            : { context: this.#workspace.getContextTreeSelector(path, tree.name), directory: null };
                        await db.link(docId, selector);
                        relinked++;
                    }
                }

                // Nothing was put back (no provenance recorded, or its trees are
                // gone): leave the document IN the trash. Taking it out anyway
                // would strand it — filed nowhere and no longer listed here.
                if (relinked === 0) {
                    failed.push({ id: docId, error: 'No restore target recorded' });
                    continue;
                }
                await this.untrashOnLink(docId);
                restored.push(docId);
            } catch (error) {
                failed.push({ id: docId, error: error.message });
            }
        }
        return { restored, failed, count: docIds.length };
    }

    /**
     * Purge documents already in Trash through the normal deletion safeguards.
     * Preserve surviving backend copies when the original source went missing.
     */
    async emptyTrash({ documentIds = null } = {}) {
        const db = this.#runtime.getActiveDb();
        const trashed = new Set((await db.listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, {
            path: Workspace.TRASH_PATH, idsOnly: true,
        })).ids);
        const ids = documentIds ? parseDocumentIdArray(documentIds, 'Document ID array') : [...trashed];
        if (ids.some(id => !trashed.has(id))) throw Object.assign(new Error('Only items already in Trash can be purged'), { statusCode: 409 });
        if (!ids.length) { return { destroyed: [], failed: [], count: 0 }; }

        // An extant backend copy remains indexed in the backend mirror. Purging
        // a managed-tree placement does not grant permission to delete that
        // copy, or hide it until the next scan resurrects it.
        const preserved = [];
        const purgeIds = [];
        for (const id of ids) {
            const doc = await this.#workspace.get(id);
            const provenance = db.internalStore.get(this.#trashProvenanceKey(id));
            if (provenance?.reason === 'source-missing' && availableLocations(doc).length) {
                await db.unlink(id, { context: null, directory: this.#workspace.getTrashSelector(), emitEvent: false });
                await db.internalStore.remove(this.#trashProvenanceKey(id));
                this.#trashedIds?.delete(id);
                preserved.push(id);
            } else {
                if (!availableLocations(doc).length) await this.#workspace.storageOperations?.retireOwner?.(`workspace-document:${id}`);
                purgeIds.push(id);
            }
        }
        const result = purgeIds.length ? await this.#workspace.deleteMany(purgeIds) : { successful: [], failed: [] };
        const destroyed = (result?.successful ?? []).map((entry) => entry?.id ?? entry);
        for (const docId of destroyed) {
            await db.internalStore.remove(this.#trashProvenanceKey(docId));
            this.#trashedIds?.delete(docId);
            await this.#workspace.trashOperations.release(docId);
        }
        return { destroyed, preserved, failed: result?.failed ?? [], count: ids.length };
    }
}
