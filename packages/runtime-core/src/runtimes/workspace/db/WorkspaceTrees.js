import { normalizeBackendsTreePath } from '../../../utils/backend-documents.js';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { deleteDocumentsInBatches } from './bulk-delete.js';
import { exportSubtree as exportTreeSubtree, importSubtree as importTreeSubtree } from '../portability/subtree.js';
import Workspace from '../Workspace.js';

export default class WorkspaceTrees {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    getTree(nameOrId) {
        const tree = nameOrId
            ? this.#runtime.getActiveDb().getTree(nameOrId)
            : this.#getPreferredContextTree();
        if (!tree) throw new Error(`Tree not found: ${nameOrId}`);
        return tree;
    }

    async listTrees(type = null) {
        return await this.#runtime.getActiveDb().listTrees(type);
    }

    async createTree(name, type = Workspace.CONTEXT_TYPE, options = {}) {
        return await this.#runtime.getActiveDb().createTree(name, type, options);
    }

    async renameTree(nameOrId, newName) {
        this.#assertTreeNotReserved(nameOrId, 'rename');
        return await this.#runtime.getActiveDb().renameTree(nameOrId, newName);
    }

    async destroyTree(nameOrId) {
        this.#assertTreeNotReserved(nameOrId, 'delete');
        return await this.#runtime.getActiveDb().deleteTree(nameOrId);
    }

    // The three pre-created trees (and any tree flagged settings.protected) are
    // structural — services and clients address them by name.
    #assertTreeNotReserved(nameOrId, action) {
        const db = this.#runtime.getActiveDb();
        const tree = db.getTree(nameOrId);
        if (!tree) { return; }
        if (tree.settings?.protected === true) {
            throw new Error(`Cannot ${action} reserved tree "${tree.name}"`);
        }
        // Reserved = the canonical instance each structural name resolves to.
        // A stray duplicate carrying a reserved name (leftover from a start
        // race) stays deletable by id — only the tree that name-resolution
        // actually lands on is load-bearing.
        for (const name of [Workspace.CONTEXT_TREE_NAME, Workspace.DIRECTORY_TREE_NAME, Workspace.BACKENDS_TREE_NAME]) {
            if (db.getTree(name)?.id === tree.id) {
                throw new Error(`Cannot ${action} reserved tree "${tree.name}"`);
            }
        }
    }

    getContextTree(nameOrId = null) {
        const tree = nameOrId ? this.#workspace.getTree(nameOrId) : this.#getPreferredContextTree();
        if (tree.type !== Workspace.CONTEXT_TYPE) throw new Error(`Tree is not a context tree: ${nameOrId}`);
        return tree;
    }

    getDirectoryTree(nameOrId = null) {
        const tree = nameOrId ? this.#workspace.getTree(nameOrId) : this.#getPreferredDirectoryTree();
        if (tree.type !== Workspace.DIRECTORY_TYPE) throw new Error(`Tree is not a directory tree: ${nameOrId}`);
        return tree;
    }

    getDefaultContextTree() { return this.#workspace.getContextTree(); }
    getDefaultDirectoryTree() { return this.#workspace.getDirectoryTree(); }

    exportSubtree(treeName, path, options = {}) {
        return exportTreeSubtree(this.#runtime.getActiveDb(), this.#workspace.getTree(treeName), path,
            { workspaceId: this.#workspace.id, workspaceName: this.#workspace.name }, options);
    }

    importSubtree(treeName, archive, options = {}) {
        return importTreeSubtree(this.#runtime.getActiveDb(), this.#workspace.getTree(treeName), archive, options);
    }

    /**
     * Remove a folder from the backends tree AND cascade-purge the documents
     * that lived under it from the index. Backend-ingested docs are re-synced
     * if the user re-enables the backend, so this lets a user discard the
     * leftovers of a backend they removed without orphaning index entries.
     * Bytes on the backend are NOT touched — see destroyBackendsTreePath for that.
     *
     * Keep the subtree queryable while bounded purge batches run. Remove its
     * now-empty nodes last, so failed deletions also remain reachable for retry.
     */
    async removeBackendsTreePath(path, { recursive = false } = {}) {
        const tree = this.#workspace.getBackendsTree();
        const normalizedPath = normalizeBackendsTreePath(path);
        if (normalizedPath === '/') {
            throw new Error('Cannot remove the backends root directory');
        }

        const node = tree.getLayerForPath(normalizedPath);
        if (!node) return { data: null, count: 0, error: `Path not found: ${normalizedPath}`, purged: 0 };
        if (node.locked) throw new Error(`Path is locked: ${normalizedPath}`);
        if (!recursive && (await tree.listDirectories(normalizedPath)).length) {
            return { data: null, count: 0, error: 'Directory is not empty', purged: 0 };
        }

        const bitmap = recursive
            ? await tree.findRecursive(normalizedPath)
            : await tree.find(normalizedPath);
        const documentIds = bitmap ? bitmap.toArray() : [];

        let purgeResult = null;
        if (documentIds.length > 0) {
            purgeResult = await deleteDocumentsInBatches(this.#workspace, documentIds, { emitEvent: false });
        }
        if (purgeResult?.failed.length) {
            return { data: null, count: 0, error: 'Some documents could not be purged; the folder was kept for retry', purged: purgeResult.successful.length, purgeResult };
        }
        const result = await tree.removePath(normalizedPath, recursive);
        return { ...result, purged: purgeResult?.successful?.length || 0, purgeResult };
    }

    /**
     * Remove a backends-tree folder AND delete the mirrored resources on the
     * backend itself (rw backends only; read-only/foreign locations degrade to
     * reference-drop). The byte half of "remove from canvas AND the backend".
     *
     * Per document: locations that belong to the backend mirrored by `path` are
     * destroyed via the stored index (stored:// delete, workspace file rm, imap
     * EXPUNGE — readOnly config degrades each to a reference drop). Whatever the
     * destroy pass didn't fully delete is then purged from the index (destroy
     * implies purge). The folder is removed last so a mid-failure stays retryable.
     */
    async destroyBackendsTreePath(path, { recursive = false } = {}) {
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        const tree = this.#workspace.getBackendsTree();
        const normalizedPath = normalizeBackendsTreePath(path);
        const segments = normalizedPath.split('/').filter(Boolean); // [driver, address, ...rest]
        if (segments.length < 2) {
            throw new Error('destroy requires a backend resource path (/<driver>/<resource-address>/...)');
        }
        const node = tree.getLayerForPath(normalizedPath);
        if (!node) { return { data: null, count: 0, error: `Path not found: ${normalizedPath}` }; }
        if (node.locked) {
            throw new Error(`Path is locked: a backend mapped to ${normalizedPath} is enabled`);
        }

        const [driver, address, ...rest] = segments;
        const scope = driver === 'imap'
            ? { kind: 'imap', account: address.toLowerCase(), folder: rest.join('/').toLowerCase() || null }
            : { kind: 'stored', backend: this.#runtime.state.storedIndex.resolveBackendForTreePath(normalizedPath) };

        const bitmap = recursive ? await tree.findRecursive(normalizedPath) : await tree.find(normalizedPath);
        const documentIds = bitmap ? bitmap.toArray() : [];

        const destroyed = { docsDestroyed: 0, docsPurged: 0, deletedLocations: 0, droppedRefs: 0, failed: [] };
        const leftovers = [];
        for (const id of documentIds) {
            try {
                const doc = await this.#workspace.get(id).catch(() => null);
                if (!doc) { continue; }
                const urls = (doc.locations || [])
                    .map((l) => l?.url)
                    .filter((url) => WorkspaceTrees.#locationMatchesBackendScope(url, scope));
                const res = urls.length > 0
                    ? await this.#workspace.destroyDocument(doc, { urls })
                    : { deleted: [], droppedRefs: [], docDeleted: false };
                destroyed.deletedLocations += res.deleted.length;
                destroyed.droppedRefs += res.droppedRefs.length;
                if (res.docDeleted) { destroyed.docsDestroyed += 1; } else { leftovers.push(id); }
            } catch (err) {
                destroyed.failed.push({ id, reason: err.message });
                leftovers.push(id);
            }
        }
        if (leftovers.length > 0) {
            const purgeResult = await deleteDocumentsInBatches(this.#workspace, leftovers, { emitEvent: false });
            destroyed.docsPurged = purgeResult?.successful?.length || 0;
            if (purgeResult.failed.length) {
                return { data: null, count: 0, error: 'Some documents could not be purged; the folder was kept for retry', destroyed };
            }
        }

        const result = await tree.removePath(normalizedPath, true);
        return { ...result, destroyed };
    }

    /**
     * Does a location URL belong to the backend scope mirrored by a backends-tree
     * path? Tree segments are normalized lowercase, so compares are
     * case-insensitive (IMAP folder INBOX ↔ tree node inbox).
     */
    static #locationMatchesBackendScope(url, scope) {
        if (typeof url !== 'string') { return false; }
        const parsed = parseLocationUrl(url);
        if (!parsed) { return false; }
        if (scope.kind === 'imap') {
            if (parsed.scheme !== 'imap' || parsed.backend.toLowerCase() !== scope.account) { return false; }
            if (!scope.folder) { return true; }
            const folder = parsed.key.split(';')[0].toLowerCase();
            return folder === scope.folder || folder.startsWith(`${scope.folder}/`);
        }
        return parsed.scheme === 'stored' && !!scope.backend && parsed.backend === scope.backend;
    }

    /**
     * Backend-node enable-lock: while a backend is enabled, its mirror node
     * /<driver>/<resource-address> (backends tree) is structurally locked (no
     * remove/rename/move). Holder-scoped: each backend adds its own
     * system:backend:<holder> entry, so shared nodes (two mailboxes on one
     * account) stay locked until the last holder releases.
     */
    async lockBackendTreeNode(backendPath, holder) {
        const tree = this.#workspace.getBackendsTree();
        await tree.insertPath(backendPath, { ignoreLocks: true });
        await tree.lockPath(backendPath, `${Workspace.BACKEND_NODE_LOCK_PREFIX}${holder}`);
        this.#workspace.emit('backend.tree.changed', { workspaceId: this.#workspace.id, treeName: Workspace.BACKENDS_TREE_NAME, path: backendPath });
    }

    async unlockBackendTreeNode(backendPath, holder) {
        const tree = this.#workspace.getBackendsTree();
        if (typeof tree.pathExists === 'function' && !tree.pathExists(backendPath)) { return; }
        await tree.unlockPath(backendPath, `${Workspace.BACKEND_NODE_LOCK_PREFIX}${holder}`, { system: true })
            .catch(() => {});
        this.#workspace.emit('backend.tree.changed', { workspaceId: this.#workspace.id, treeName: Workspace.BACKENDS_TREE_NAME, path: backendPath });
    }

    getContextTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getDirectoryTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getBackendsTreeSelector(path = '/') {
        const normalizedPath = Array.isArray(path)
            ? path.map((value) => normalizeBackendsTreePath(value))
            : normalizeBackendsTreePath(path);
        return this.#workspace.getDirectoryTreeSelector(normalizedPath, Workspace.BACKENDS_TREE_NAME);
    }

    getBackendsTree() {
        return this.#workspace.getDirectoryTree(Workspace.BACKENDS_TREE_NAME);
    }

    /**
     * A file left the backend: walk up from its folder and drop every node
     * that is now empty (no documents anywhere below, no children) until the
     * backend root (`/driver/address`, never removed) or a node that still
     * holds something. Folders are not objects — a mirror deletes a tree file
     * by file — so without this every emptied folder stayed on as a shell.
     * `removePath` refuses non-empty and locked nodes, so a concurrent insert
     * simply stops the walk.
     */
    async pruneEmptyBackendPaths(treePath) {
        const tree = this.#workspace.getBackendsTree();
        if (!tree) return 0;
        // Paths here are the tree's own (getPathByNodeId / listDocumentTreePaths):
        // case-exact, so no normalizer — it would fold `Test` to `test` and miss.
        const segments = String(treePath || '').split('/').filter(Boolean);
        let removed = 0;
        while (segments.length > 2) {
            const current = `/${segments.join('/')}`;
            if (this.#policyBackendDirectories().some(p => p === current || p.startsWith(`${current}/`))) break;
            if (tree.pathExists(current)) {
                const docs = await tree.findRecursive(current);
                if (docs && !docs.isEmpty) break;
                let result;
                try { result = await tree.removePath(current, false); } catch { break; }
                if (result?.error) break;
                removed += 1;
            }
            segments.pop();
        }
        return removed;
    }

    /**
     * After a resync: remove every empty folder node under a backend root that
     * is not on disk any more (`keepDirs` = the mount's current directory
     * skeleton, relative to the root). Deepest first, so a chain of empty
     * shells collapses in one pass. Locked nodes are left alone.
     */
    async sweepEmptyBackendPaths(rootPath, keepDirs = []) {
        const tree = this.#workspace.getBackendsTree();
        if (!tree) return 0;
        const root = `/${String(rootPath || '').split('/').filter(Boolean).join('/')}`;
        if (root.split('/').filter(Boolean).length < 2 || !tree.pathExists(root)) return 0;
        // On-disk dirs resolve through the tree (segment sanitizing and all) to
        // node ids — comparing ids sidesteps every naming difference.
        const keep = new Set();
        for (const dir of keepDirs) for (const id of tree.getNodeIdsForPath(`${root}/${dir}`)) keep.add(id);
        for (const dir of this.#policyBackendDirectories()) for (const id of tree.getNodeIdsForPath(dir)) keep.add(id);
        const rootIds = new Set(tree.getNodeIdsForPath(root));
        const paths = [];
        for (const nodeId of tree.getNodeIdsForPath(root, { recursive: true })) {
            if (rootIds.has(nodeId) || keep.has(nodeId)) continue;
            const nodePath = await tree.getPathByNodeId(nodeId);
            if (nodePath && nodePath.startsWith(`${root}/`)) paths.push(nodePath);
        }
        paths.sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
        let removed = 0;
        for (const nodePath of paths) {
            if (!tree.pathExists(nodePath)) continue;
            const docs = await tree.findRecursive(nodePath);
            if (docs && !docs.isEmpty) continue;
            try { if (!(await tree.removePath(nodePath, false))?.error) removed += 1; } catch { /* locked */ }
        }
        return removed;
    }

    #policyBackendDirectories() {
        return (this.#workspace.storageOperations?.owners('workspace-directory:') || []).flatMap(owner => owner.replicas.map(replica => {
            const root = this.#runtime.state.storedIndex.getBackendTreeRoot(replica.backend);
            return root ? `${root}/${replica.key}` : null;
        }).filter(Boolean));
    }

    #normalizeTreeSelector(type, selector, defaultPath = '/') {
        if (selector == null) return null;

        if (typeof selector === 'string' || Array.isArray(selector)) {
            selector = { path: selector };
        }

        if (typeof selector !== 'object' || Array.isArray(selector)) {
            throw new Error(`Invalid ${type} selector`);
        }

        const resolvedPath = selector.path ?? selector[type] ?? defaultPath;
        const tree = selector.tree ?? selector.treeId ?? null;
        const resolvedTree = tree
            ? (type === Workspace.CONTEXT_TYPE ? this.#workspace.getContextTree(tree) : this.#workspace.getDirectoryTree(tree))
            : (type === Workspace.CONTEXT_TYPE ? this.#workspace.getDefaultContextTree() : this.#workspace.getDefaultDirectoryTree());

        return { ...selector, tree: resolvedTree.id, path: resolvedPath };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tree setup
    // ─────────────────────────────────────────────────────────────────────────

    #getPreferredContextTree() {
        const db = this.#runtime.getActiveDb();
        return db.getTree(Workspace.CONTEXT_TREE_NAME) || db.getDefaultContextTree();
    }

    #getPreferredDirectoryTree() {
        const db = this.#runtime.getActiveDb();
        return db.getTree(Workspace.DIRECTORY_TREE_NAME) || db.getDefaultDirectoryTree();
    }

    async ensureContextTree() {
        if (this.#runtime.state.db.getTree(Workspace.CONTEXT_TREE_NAME)) {
            return this.#runtime.state.db.getTree(Workspace.CONTEXT_TREE_NAME);
        }

        // synapsd creates its default context tree as 'default'/'ContextTree';
        // the workspace addresses it as 'context'.
        const defaultContextTree = this.#runtime.state.db.getDefaultContextTree();
        if (defaultContextTree?.type === Workspace.CONTEXT_TYPE && ['default', 'ContextTree'].includes(defaultContextTree.name)) {
            await this.#runtime.state.db.renameTree(defaultContextTree.id, Workspace.CONTEXT_TREE_NAME);
            return this.#runtime.state.db.getTree(Workspace.CONTEXT_TREE_NAME);
        }

        await this.#runtime.state.db.createTree(Workspace.CONTEXT_TREE_NAME, Workspace.CONTEXT_TYPE);
        return this.#runtime.state.db.getTree(Workspace.CONTEXT_TREE_NAME);
    }

    async ensureDirectoryTree() {
        if (this.#runtime.state.db.getTree(Workspace.DIRECTORY_TREE_NAME)) {
            return this.#runtime.state.db.getTree(Workspace.DIRECTORY_TREE_NAME);
        }

        await this.#runtime.state.db.createTree(Workspace.DIRECTORY_TREE_NAME, Workspace.DIRECTORY_TYPE);
        return this.#runtime.state.db.getTree(Workspace.DIRECTORY_TREE_NAME);
    }

    async ensureBackendsTree() {
        const existing = this.#runtime.state.db.getTree(Workspace.BACKENDS_TREE_NAME);
        if (existing) {
            if (existing.type !== Workspace.DIRECTORY_TYPE) {
                throw new Error(`Tree "${Workspace.BACKENDS_TREE_NAME}" exists but is not a directory tree — rename it to free the reserved name`);
            }
            return existing;
        }

        // linkContextRoot:false keeps backend mirrors out of the user's context
        // root until explicitly filed; protected guards rename/destroy.
        await this.#runtime.state.db.createTree(Workspace.BACKENDS_TREE_NAME, Workspace.DIRECTORY_TYPE, {
            isDefault: false,
            settings: { linkContextRoot: false, protected: true },
        });
        return this.#runtime.state.db.getTree(Workspace.BACKENDS_TREE_NAME);
    }
}
