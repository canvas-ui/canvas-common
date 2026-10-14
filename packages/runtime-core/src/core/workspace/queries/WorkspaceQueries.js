import { parseDocumentId } from '../../../utils/documentId.js';
import Workspace from '../Workspace.js';

// Workspace delegates this domain to a collaborator. Runtime dependencies stay
// private to the local host; the public Workspace API is the transport boundary.
export default class WorkspaceQueries {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    async list(spec = {}) {
        const querySpec = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));
        const searchQuery = querySpec.query ?? querySpec.search ?? querySpec.q;
        if (typeof searchQuery === 'string' && searchQuery.trim()) {
            return await this.#runtime.getActiveDb().search(querySpec);
        }
        return await this.#runtime.getActiveDb().list(querySpec);
    }

    async search(spec = {}) {
        const querySpec = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));
        if (querySpec.maxDistance === undefined) { querySpec.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#runtime.getActiveDb().search(querySpec);
    }

    // Stateless multi-query refinement: `spec` supplies the structured scope
    // (path/features/filters/canvas), `queries` is the ordered stack of text
    // queries that AND-narrow it (last ranks). Text is passed separately, so any
    // single query carried on the spec is dropped from the base scope.
    async searchRefined(queries = [], spec = {}, options = {}) {
        const baseSpec = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));
        delete baseSpec.query; delete baseSpec.search; delete baseSpec.q;
        const opts = { ...options };
        if (opts.maxDistance === undefined) { opts.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#runtime.getActiveDb().searchRefined(queries, baseSpec, opts);
    }

    // Compound query: OR/AND of independent refinement chains ("lines"). `spec`
    // supplies the shared structured scope, each line its own query chain (+
    // optional per-line filters). See SynapsD.searchCompound for semantics.
    async searchCompound(lines = [], spec = {}, options = {}) {
        const baseSpec = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));
        delete baseSpec.query; delete baseSpec.search; delete baseSpec.q;
        const opts = { ...options, baseSpec };
        if (opts.maxDistance === undefined) { opts.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#runtime.getActiveDb().searchCompound(lines, opts);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Query sessions (live, delta-emitting views)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalize ONE session cue spec the same way list()/search() normalize a
     * read: canvas querySpec folding + context/directory → the ctx:/dir: paths
     * grammar.
     *
     * Cues are the CANDIDATE-SET stage: bitmap algebra (paths, features,
     * filters incl. geo, literal id-sets) that can be cached, AND-ed and
     * precisely invalidated. Text and image relevance are a SCORE, not a
     * membership predicate — they have no bitmap key to invalidate and belong
     * to the ranking stage (see buildMatch + QuerySession.materialize). Any
     * text a canvas leaf folds in is therefore dropped here; the transport
     * rejects caller-supplied text outright rather than silently ignoring it.
     * `limit`/`offset` are paging concerns of the session as a whole (opts),
     * not of a cue, and are dropped too.
     */
    normalizeSessionSpec(spec = {}) {
        const cue = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));
        delete cue.query; delete cue.search; delete cue.q;
        delete cue.limit; delete cue.offset; delete cue.page;
        delete cue.sortBy; delete cue.order;
        return cue;
    }

    /**
     * Open a long-running, refinable query session over this workspace's db.
     * Cue specs are workspace-normalized (see normalizeSessionSpec); everything
     * else — modes, emit shapes, invalidation — is synapsd's QuerySession.
     *
     * Sessions hold a reference to the live db, so the workspace tracks them and
     * closes them on stop(): a session surviving a shutdown would keep emitting
     * against a torn-down db. The returned session's close() is idempotent and
     * deregisters itself.
     *
     * @param {object|object[]} specs  one spec, an array of specs, or {spec,label}[]
     * @param {object} opts            { mode, emit, combinator, debounceMs, limit, offset }
     */
    async openSession(specs = [], opts = {}) {
        const db = this.#runtime.getActiveDb();
        const list = (Array.isArray(specs) ? specs : (specs ? [specs] : []))
            .filter(Boolean)
            .map((entry) => (entry && typeof entry === 'object' && 'spec' in entry)
                ? { label: entry.label, spec: this.#workspace.normalizeSessionSpec(entry.spec) }
                : this.#workspace.normalizeSessionSpec(entry));

        const session = await db.openSession(list, opts);
        this.#runtime.state.sessions.add(session);
        const close = session.close.bind(session);
        session.close = () => { this.#runtime.state.sessions.delete(session); close(); };
        return session;
    }

    /**
     * Build a typed match descriptor for the RANKING stage — the second half of
     * a session read, applied over the cue-narrowed candidate set.
     *
     * Text and image fuse: with both, the image rides as a vector leg on
     * synapsd's typed match and RRF-merges with the full text pipeline (FTS +
     * dense + text→image kNN), so "broken door" resurfaces the summarized NOTE
     * about the entrance next to the photos the camera frame matched. Text
     * alone stays a plain string (the classic fts/vector/hybrid path); an image
     * alone is a single kNN leg and keeps its exact distance order.
     *
     * Returns null when there is nothing to rank by — the caller then gets the
     * cheap listing path (bitmap slice, no Lance).
     *
     * @param {object} p
     * @param {string|null}  p.text        free text ("broken door")
     * @param {Buffer|null}  p.imageBytes  EPHEMERAL query image (camera frame) — embedded, never stored
     * @param {string|null}  p.contentType mime for imageBytes
     * @param {number|null}  p.similarTo   reuse an indexed document's stored image vector
     */
    async buildMatch({ text = null, imageBytes = null, contentType = null, similarTo = null, minDistance, maxDistance } = {}) {
        const db = this.#runtime.getActiveDb();
        const vectors = [];

        if (imageBytes) {
            if (!this.#runtime.state.inferd) { throw new Error('inferd service not available for image query embedding'); }
            const vector = await this.#runtime.state.inferd.embedImageQuery(this.#workspace.id, imageBytes, contentType);
            if (!vector) { throw new Error('image query embedding failed (no image-capable provider for this workspace?)'); }
            vectors.push({ space: 'image', vector, minDistance, maxDistance });
        } else if (similarTo != null) {
            const docId = parseDocumentId(similarTo, 'Document ID');
            const vector = await db.getDocumentVector(docId, 'image');
            if (!vector) { throw new Error(`document ${docId} has no image-space vector`); }
            vectors.push({ space: 'image', vector, minDistance, maxDistance });
        }

        const query = typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
        if (!query && vectors.length === 0) { return null; }
        if (query && vectors.length === 0) { return query; }
        return { text: query, vectors };
    }

    /** Close every session opened against this workspace (called from stop()). */
    closeSessions() {
        for (const session of [...this.#runtime.state.sessions]) {
            try { session.close(); } catch (err) { this.#runtime.state.logger.debug({ err: err.message }, 'Error closing query session'); }
        }
        this.#runtime.state.sessions.clear();
    }

    /**
     * Search by image over the joint image space. Two query sources:
     *  - imageBytes: an EPHEMERAL query image (camera frame, upload) — embedded
     *    via the inferd service, never stored or indexed;
     *  - similarTo: an already-indexed document id ("more like this") — its
     *    stored vector is reused, no bytes cross any boundary.
     * `spec` is the usual structured scope; results come back best-first in
     * kNN order. No implicit distance floor: a frame query wants its top-K,
     * pass maxDistance to cut noise (same semantics as the text path).
     *
     * Optional `text` switches to FUSED mode: the image becomes a vector leg in
     * synapsd's typed match descriptor and RRF-fuses with the full text
     * pipeline (FTS + dense + text→image kNN) — so the image query resurfaces
     * NOTES ranked by the text, not just photos. Note: fused mode cannot
     * exclude the similarTo self-match (RRF has no excludeIds); callers pair
     * similarTo with text knowing the reference doc may rank first.
     */
    async searchByImage({ imageBytes = null, contentType = null, similarTo = null, text = null, spec = {}, limit, offset, minDistance, maxDistance, debug = false, idsOnly = false } = {}) {
        const db = this.#runtime.getActiveDb();
        let vector;
        let excludeIds = [];
        if (imageBytes) {
            if (!this.#runtime.state.inferd) { throw new Error('inferd service not available for image query embedding'); }
            // A text-only backend (e.g. ollama) throws from embedImage — fold it
            // into the error envelope instead of 500ing the route.
            try {
                vector = await this.#runtime.state.inferd.embedImageQuery(this.#workspace.id, imageBytes, contentType);
            } catch (error) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = `image query embedding failed: ${error.message}`;
                return empty;
            }
            if (!vector) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = 'image query embedding failed (no image-capable provider for this workspace?)';
                return empty;
            }
        } else if (similarTo != null) {
            const docId = parseDocumentId(similarTo, 'Document ID');
            vector = await db.getDocumentVector(docId, 'image');
            if (!vector) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = `document ${docId} has no image-space vector`;
                return empty;
            }
            excludeIds = [docId]; // a doc's nearest neighbour is always itself
        } else {
            throw new Error('searchByImage requires imageBytes or similarTo');
        }
        const querySpec = this.#runtime.docs.normalizeQuerySpec(this.composeCanvasQuerySpec(spec));

        // Fused mode: image rides as a vector leg on the typed match descriptor,
        // RRF-merged with the text legs by synapsd — notes and photos in one page.
        if (typeof text === 'string' && text.trim().length > 0) {
            delete querySpec.query; delete querySpec.search; delete querySpec.q;
            return await db.search({
                ...querySpec,
                query: {
                    text,
                    vectors: [{ space: 'image', vector, minDistance, maxDistance }],
                },
                limit, offset, idsOnly, debug,
                maxDistance: Workspace.DEFAULT_MAX_COSINE_DISTANCE, // text dense leg floor
            });
        }

        return await db.searchByVector(vector, querySpec, {
            space: 'image', limit, offset, minDistance, maxDistance,
            withDistances: !!debug, idsOnly, excludeIds,
        });
    }

    /**
     * If the read targets a path whose leaf is a canvas layer, AND-compose the
     * canvas's stored querySpec (features + filters) into the spec before
     * delegating to the DB. Lets `GET /workspaces/:id/documents?context=/foo/bar/baz`
     * apply baz's querySpec when baz is a canvas — no separate /canvases/:id/documents
     * endpoint needed.
     *
     * Applies to BOTH scope keys: `spec.context` (context tree) and
     * `spec.directory` (directory tree). Directory membership is node-exact, so
     * a directory-tree canvas reads its PARENT folder's documents (the canvas
     * node itself holds none) — with or without a stored querySpec.
     */
    composeCanvasQuerySpec(spec) {
        if (!spec || typeof spec !== 'object') { return spec; }
        // Live canvas filter preview: when the client fully drives the filters
        // (toolbox-on-canvas), it opts out of folding the canvas's STORED
        // querySpec so its edits — including REMOVING a saved filter — take
        // effect. Without this the stored spec is always AND-composed, so
        // loosening a filter would never preview until Save.
        if (spec.applyCanvasQuerySpec === false) { return spec; }
        let out = this.#composeCanvasForScope(spec, 'context');
        out = this.#composeCanvasForScope(out, 'directory');
        return out;
    }

    #composeCanvasForScope(spec, scopeKey) {
        const scope = spec?.[scopeKey];
        if (!scope) { return spec; }

        let treeRef = null;
        let paths = [];
        if (typeof scope === 'string') {
            paths = [scope];
        } else if (Array.isArray(scope)) {
            paths = scope.filter((p) => typeof p === 'string');
        } else if (typeof scope === 'object') {
            treeRef = scope.tree ?? scope.treeId ?? null;
            const p = scope.path ?? scope.context ?? scope.directory;
            paths = Array.isArray(p) ? p.filter((s) => typeof s === 'string') : (typeof p === 'string' ? [p] : []);
        }
        if (paths.length === 0) { return spec; }

        let tree;
        try {
            tree = treeRef
                ? this.#workspace.getTree(treeRef)
                : (scopeKey === 'directory' ? this.#workspace.getDefaultDirectoryTree() : this.#workspace.getDefaultContextTree());
        } catch (_) {
            return spec;
        }
        if (!tree || typeof tree.getLayerForPath !== 'function') { return spec; }

        let features = spec.features ?? spec.attributes ?? null;
        let filters = Array.isArray(spec.filters) ? [...spec.filters] : (spec.filters ? [spec.filters] : []);
        let query = spec.query ?? spec.search ?? spec.q ?? null;
        let sort = null;
        let nextScope = spec[scopeKey];
        let touched = false;

        for (const path of paths) {
            let leaf = null;
            try { leaf = tree.getLayerForPath(path); } catch (_) { /* ignore */ }
            if (leaf?.type !== 'canvas') { continue; }
            const qs = leaf.querySpec || {};
            features = WorkspaceQueries.#composeCanvasFeatures(features, qs.features);
            filters = WorkspaceQueries.#composeCanvasFilters(filters, qs.filters);
            query = WorkspaceQueries.#composeCanvasQuery(query, qs.query ?? qs.search ?? qs.q);
            // A canvas's saved sort is the view's default order; last canvas on
            // the path wins. The caller (request) overrides it when it sends its
            // own sortBy — see the injection guard below.
            if (qs.sort && qs.sort.sortBy) { sort = qs.sort; }
            if (tree.type === Workspace.DIRECTORY_TYPE) {
                nextScope = WorkspaceQueries.#withCanvasParentPath(nextScope, path);
            }
            touched = true;
        }

        if (!touched) { return spec; }

        const callerHasSort = spec.sortBy !== undefined && spec.sortBy !== null && spec.sortBy !== '';
        return {
            ...spec,
            [scopeKey]: nextScope,
            ...(features !== undefined ? { features } : {}),
            filters,
            ...(query ? { query } : {}),
            ...(sort && !callerHasSort ? { sortBy: sort.sortBy, order: sort.order || spec.order || 'asc' } : {}),
        };
    }

    static #composeCanvasFeatures(callerFeatures, canvasFeatures) {
        if (canvasFeatures === null || canvasFeatures === undefined) { return callerFeatures; }
        if (callerFeatures === null || callerFeatures === undefined) { return canvasFeatures; }
        const toBuckets = (f) => {
            if (Array.isArray(f)) { return { anyOf: [...f] }; }
            if (f && typeof f === 'object') {
                const out = {};
                if (Array.isArray(f.allOf))  { out.allOf  = [...f.allOf]; }
                if (Array.isArray(f.anyOf))  { out.anyOf  = [...f.anyOf]; }
                if (Array.isArray(f.noneOf)) { out.noneOf = [...f.noneOf]; }
                return out;
            }
            return {};
        };
        const a = toBuckets(callerFeatures);
        const b = toBuckets(canvasFeatures);
        const merged = {};
        for (const key of ['allOf', 'anyOf', 'noneOf']) {
            const left = a[key] || [];
            const right = b[key] || [];
            if (left.length || right.length) {
                merged[key] = [...new Set([...left, ...right])];
            }
        }
        return Object.keys(merged).length === 0 ? null : merged;
    }

    static #composeCanvasFilters(callerFilters, canvasFilters) {
        const a = Array.isArray(callerFilters) ? callerFilters : [];
        const b = Array.isArray(canvasFilters) ? canvasFilters : [];
        if (!a.length && !b.length) { return callerFilters || []; }
        return [...new Set([...a, ...b])];
    }

    static #composeCanvasQuery(callerQuery, canvasQuery) {
        const a = typeof callerQuery === 'string' ? callerQuery.trim() : '';
        const b = typeof canvasQuery === 'string' ? canvasQuery.trim() : '';
        if (a && b && a !== b) return `${b} ${a}`;
        return a || b || null;
    }

    static #withCanvasParentPath(context, canvasPath) {
        const parentPath = WorkspaceQueries.#parentPath(canvasPath);
        if (typeof context === 'string') return parentPath;
        if (Array.isArray(context)) {
            return context.map((entry) => entry === canvasPath ? parentPath : entry);
        }
        if (context && typeof context === 'object') {
            const pathValue = context.path ?? context.context;
            if (Array.isArray(pathValue)) {
                return { ...context, path: pathValue.map((entry) => entry === canvasPath ? parentPath : entry) };
            }
            return { ...context, path: parentPath };
        }
        return context;
    }

    static #parentPath(value) {
        const normalized = String(value || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        if (normalized === '/') return '/';
        const idx = normalized.lastIndexOf('/');
        return idx <= 0 ? '/' : normalized.slice(0, idx);
    }
}
