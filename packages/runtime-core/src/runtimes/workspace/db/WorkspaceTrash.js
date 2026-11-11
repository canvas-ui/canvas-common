import { availableLocations } from '@augmentd-labs/canvas-synapsd/src/utils/document-locations.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { normalizeSegment } from '../../../utils/backend-documents.js';
import { parseLocationUrl } from '@augmentd-labs/canvas-synapsd/src/utils/path-helpers.js';
import { backendIdentity, normalizeRemovalPolicy } from '../storage/removal-policy.js';
import { TRASH_RETENTION_DAYS } from '../storage/index/contracts.js';
import Workspace from '../Workspace.js';
import WorkspaceDocuments from './WorkspaceDocuments.js';

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 6 * 3_600_000;
const DELETED_PAGE = 1000;

const expiryOf = (deletedAt) => {
    const at = Date.parse(deletedAt);
    return Number.isFinite(at) ? new Date(at + TRASH_RETENTION_DAYS * DAY_MS).toISOString() : null;
};
const sha256Of = (document) => {
    for (const value of document?.checksumArray || []) {
        const match = /^sha256[/:]([0-9a-f]{64})$/i.exec(String(value));
        if (match) return match[1].toLowerCase();
    }
    return null;
};
const documentName = (document) => {
    const data = document?.data || {};
    for (const field of ['title', 'name', 'filename', 'subject']) {
        if (typeof data[field] === 'string' && data[field].trim()) return data[field].trim();
    }
    if (typeof document?.metadata?.filename === 'string' && document.metadata.filename) return document.metadata.filename;
    const location = locationPaths(document)[0];
    if (location) return location.slice(location.lastIndexOf('/') + 1);
    return `${String(document?.schema || 'document').split('/').pop()} ${document?.id}`;
};
// `stored://workspace:home/Invoices/a.pdf` → `workspace:home/Invoices/a.pdf`
const locationPaths = (document) => (document?.locations || [])
    .map((location) => /^stored:\/\/(.+)$/.exec(String(location?.url || ''))?.[1])
    .filter(Boolean)
    .map((value) => { try { return decodeURIComponent(value); } catch { return value; } });
const parentOf = (value) => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : value);

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
    // ─────────────────────────────────────────────────────────────────────────
    // Recently deleted: one list over the document Trash and the Trash of
    // every file backend, with one expiry (CANVAS_TRASH_RETENTION_DAYS).
    // ─────────────────────────────────────────────────────────────────────────

    async #fileBackends() {
        return (await this.#workspace.listBackendsByDriver('file')).map((backend) => backend.address);
    }

    /**
     * Everything that was deleted and can still be brought back, newest first.
     * A deleted file whose document is in the Trash too is one item: restoring
     * it puts the bytes and the filing back together.
     */
    async listDeleted({ search = '', limit = 500, offset = 0 } = {}) {
        const items = [];
        const bySha = new Map();
        const { documents } = await this.listTrash({ parse: true });
        for (const document of documents) {
            const deletedAt = document.trashed?.trashedAt || null;
            const item = {
                id: `doc:${document.id}`,
                kind: 'document',
                name: documentName(document),
                schema: document.schema || null,
                documentId: document.id,
                from: (document.trashed?.placements || []).flatMap((placement) => placement.paths),
                reason: document.trashed?.reason === 'source-missing' ? 'source-missing' : 'removed',
                deletedAt,
                expiresAt: expiryOf(deletedAt),
                size: document.metadata?.size ?? document.data?.size ?? null,
                copies: [],
            };
            // Filed nowhere: say where the bytes were instead.
            if (!item.from.length) item.from = [...new Set(locationPaths(document).map(parentOf))];
            const sha = sha256Of(document);
            if (sha && !bySha.has(sha)) bySha.set(sha, item);
            items.push(item);
        }
        for (const backend of await this.#fileBackends()) {
            let cursor = null;
            do {
                const page = await this.#workspace.listBackendTrash('file', backend, { cursor, limit: DELETED_PAGE })
                    .catch(() => ({ items: [], cursor: null }));
                for (const entry of page.items) {
                    const id = `file:${backend}:${entry.id}`;
                    const owner = entry.type === 'file' && entry.sha256 ? bySha.get(entry.sha256) : null;
                    if (owner) {
                        owner.copies.push({ id, backend, key: entry.key });
                        owner.size ??= entry.size ?? null;
                        continue;
                    }
                    const slash = entry.key.lastIndexOf('/');
                    items.push({
                        id,
                        kind: entry.type === 'directory' ? 'folder' : 'file',
                        name: entry.key.slice(slash + 1),
                        backend,
                        key: entry.key,
                        from: [`${backend}/${slash > 0 ? entry.key.slice(0, slash) : ''}`.replace(/\/$/, '')],
                        reason: 'removed',
                        deletedAt: entry.deletedAt || null,
                        expiresAt: expiryOf(entry.deletedAt),
                        size: entry.size ?? null,
                        copies: [],
                    });
                }
                cursor = page.cursor;
            } while (cursor);
        }
        const needle = String(search || '').trim().toLowerCase();
        const matching = needle
            ? items.filter((item) => item.name.toLowerCase().includes(needle) || item.from.some((path) => path.toLowerCase().includes(needle)))
            : items;
        matching.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
        return { items: matching.slice(offset, offset + limit), total: matching.length, retentionDays: TRASH_RETENTION_DAYS };
    }

    #splitDeletedIds(ids) {
        const documents = [];
        const files = new Map();
        const unknown = [];
        for (const id of [...new Set(ids)]) {
            const doc = /^doc:(\d+)$/.exec(id);
            const file = /^file:(.+):([a-f0-9-]{36,64})$/.exec(id);
            if (doc) documents.push(Number(doc[1]));
            else if (file) files.set(file[1], [...(files.get(file[1]) || []), file[2]]);
            else unknown.push(id);
        }
        return { documents, files, unknown };
    }

    // The backend Trash entries that belong to trashed documents, per item id.
    async #copiesOf(documentIds) {
        if (!documentIds.length) return new Map();
        const wanted = new Set(documentIds.map((id) => `doc:${id}`));
        const { items } = await this.listDeleted({ limit: Number.MAX_SAFE_INTEGER });
        return new Map(items.filter((item) => wanted.has(item.id)).map((item) => [item.id, item.copies]));
    }

    async #settleFiles(files, action) {
        const results = [];
        for (const [backend, ids] of files) {
            for (let at = 0; at < ids.length; at += 200) {
                const batch = ids.slice(at, at + 200);
                try {
                    const { results: done } = action === 'restore'
                        ? await this.#workspace.restoreBackendTrash('file', backend, batch)
                        : await this.#workspace.discardBackendTrash('file', backend, batch);
                    for (const r of done) results.push({ id: `file:${backend}:${r.id}`, ok: !!r.ok, message: r.ok ? undefined : (r.message || r.reason) });
                } catch (error) {
                    for (const id of batch) results.push({ id: `file:${backend}:${id}`, ok: false, message: error.message });
                }
            }
        }
        return results;
    }

    /** Bring deleted items back to where they were. */
    async restoreDeleted(ids) {
        const { documents, files, unknown } = this.#splitDeletedIds(ids);
        const results = unknown.map((id) => ({ id, ok: false, message: 'Unknown item' }));
        const copies = await this.#copiesOf(documents);
        for (const list of copies.values()) for (const copy of list) {
            const [, backend, id] = /^file:(.+):([a-f0-9-]{36,64})$/.exec(copy.id);
            files.set(backend, [...(files.get(backend) || []), id]);
        }
        const fileResults = await this.#settleFiles(files, 'restore');
        const attached = new Set([...copies.values()].flat().map((copy) => copy.id));
        results.push(...fileResults.filter((r) => !attached.has(r.id)));
        if (documents.length) {
            const { restored, failed } = await this.restoreFromTrash(documents);
            for (const id of restored) results.push({ id: `doc:${id}`, ok: true });
            for (const failure of failed) {
                // The filing is unknown, but the bytes went back to their
                // folder, where a scan files them again.
                const bytesBack = (copies.get(`doc:${failure.id}`) || []).some((copy) => fileResults.find((r) => r.id === copy.id)?.ok);
                if (bytesBack) await this.untrashOnLink(failure.id);
                results.push({ id: `doc:${failure.id}`, ok: bytesBack, message: bytesBack ? undefined : failure.error });
            }
        }
        return { results };
    }

    /** Delete items from the Trash for good. */
    async discardDeleted(ids) {
        const { documents, files, unknown } = this.#splitDeletedIds(ids);
        const results = unknown.map((id) => ({ id, ok: false, message: 'Unknown item' }));
        const copies = await this.#copiesOf(documents);
        if (documents.length) {
            const { destroyed, preserved = [], failed } = await this.emptyTrash({ documentIds: documents });
            for (const id of [...destroyed, ...preserved]) {
                results.push({ id: `doc:${id}`, ok: true });
                for (const copy of copies.get(`doc:${id}`) || []) {
                    const [, backend, entry] = /^file:(.+):([a-f0-9-]{36,64})$/.exec(copy.id);
                    files.set(backend, [...(files.get(backend) || []), entry]);
                }
            }
            for (const failure of failed) results.push({ id: `doc:${failure?.id ?? failure}`, ok: false, message: failure?.error || 'Not deleted' });
        }
        const attached = new Set([...copies.values()].flat().map((copy) => copy.id));
        results.push(...(await this.#settleFiles(files, 'discard')).filter((r) => !attached.has(r.id)));
        return { results };
    }

    /**
     * Delete trashed documents whose retention ran out. File backends expire
     * their own Trash on the same clock. With retention off (0 days) nothing
     * expires here: the document Trash is then emptied by hand only.
     */
    async sweepExpired(now = Date.now()) {
        const { documents } = await this.listTrash({ parse: false });
        const expired = documents
            .filter((document) => {
                const at = Date.parse(document.trashed?.trashedAt);
                return Number.isFinite(at) && at + TRASH_RETENTION_DAYS * DAY_MS <= now;
            })
            .map((document) => document.id);
        if (!expired.length) return { expired };
        const { destroyed, preserved = [] } = await this.emptyTrash({ documentIds: expired });
        return { expired: [...destroyed, ...preserved] };
    }

    #sweepTimer = null;

    scheduleSweep() {
        if (this.#sweepTimer) return;
        const run = () => this.#workspace.sweepDeleted().catch(() => {});
        this.#sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
        this.#sweepTimer.unref?.();
        setTimeout(run, 60_000).unref?.();
    }

    stopSweep() {
        clearInterval(this.#sweepTimer);
        this.#sweepTimer = null;
    }
}
