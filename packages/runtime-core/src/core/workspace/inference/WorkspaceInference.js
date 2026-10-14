import { parseDocumentId } from '../../../utils/documentId.js';
import { classifyDocument } from '../documents/classifier.js';
import { extract as extractBlobMetadata } from 'canvas-stored/src/extractors/index.js';
import { pickGeo } from '../documents/geo.js';

export default class WorkspaceInference {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    /**
     * Progress of the captioning run. The run itself lives in the inference
     * daemon (canvas-inferd/src/summarize-run.js) — driving a vision model is
     * its job, not this object's — so this is a read across the socket.
     */
    async imageSummaryStatus() {
        if (!this.#runtime.state.inferd) { return { running: false, total: 0, described: 0, skipped: 0, failed: 0 }; }
        return this.#runtime.state.inferd.imageSummaryStatus(this.#workspace.id);
    }

    /**
     * Single write authority for `services.inferd`. Validation happens above
     * this (the route asks inferd to resolve the candidate first) — a workspace
     * must never persist a config its own runtime would refuse.
     */
    setInferdConfig(config = {}) {
        const services = this.#runtime.state.configStore.get('services') || {};
        this.#runtime.state.configStore.set('services', this.#runtime.state.crypto.protect({ ...services, inferd: config }));
        this.#workspace.emit('services.changed', { service: 'inferd' });
        return this.#workspace.inferdConfig;
    }

    /**
     * Caption this workspace's images into `metadata.summary`.
     *
     * The run is executed by the inference daemon: it owns the vision model, so
     * it owns the loop, the failure policy and the decision to abort when a
     * model worker dies. This workspace supplies only what the daemon cannot
     * know — which documents are images, their bytes, and where a caption is
     * stored (see the adapter in #registerInferd). Returns immediately; poll
     * `imageSummaryStatus()`.
     */
    async startImageSummaries({ force = false } = {}) {
        if (!this.#workspace.isActive) { throw new Error('Workspace is not active'); }
        if (!this.#runtime.state.inferd) { throw new Error('Inference service is not available'); }
        return this.#runtime.state.inferd.startImageSummaries(this.#workspace.id, { force: force === true });
    }

    /**
     * Ask a running caption run to stop.
     *
     * Cooperative rather than abortive: the in-flight image is allowed to
     * finish (a caption takes seconds, and killing the worker mid-generation
     * would just cost the model reload), then the loop exits at the next
     * boundary. Images not yet attempted stay untouched, so a later run picks
     * them up — nothing is half-written.
     */
    async stopImageSummaries() {
        if (!this.#runtime.state.inferd) { throw new Error('Inference service is not available'); }
        return this.#runtime.state.inferd.stopImageSummaries(this.#workspace.id);
    }

    /** Document ids of every image in this workspace — the caption run's input set. */
    async imageDocumentIds() {
        const bitmap = await this.#workspace.getBitmap('data/mime/image', { includeData: true });
        return Array.isArray(bitmap?.ids) ? bitmap.ids : [];
    }

    /** Store a caption the daemon produced. */
    async setDocumentSummary(docId, text) {
        return this.#runtime.getActiveDb().put({
            id: docId,
            metadata: { summary: text },
            updatedAt: new Date().toISOString(),
        }, { context: null, provenance: { origin: 'inferd', depth: 1 } });
    }

    // ── Embedding (inferd service seam) ───────────────────────────────────────
    // synapsd owns no embedding model; the inferd service computes vectors and
    // pushes them back here. These two methods are the workspace-level adapter
    // the inferd service registers with (storeVectors + resolveInput).

    // Mid-ingest maintenance cadence: every N vector upserts, compact the Lance
    // tables + refresh the ANN index. Each upsert is its own delete+add commit,
    // so a bulk import otherwise accumulates thousands of tiny fragments that
    // every query must brute-force scan — search latency grows with ingest
    // progress until it times out. Runs inside the (sequential) inferd queue
    // handler, so it never races other vector writes.
    static #EMBED_OPTIMIZE_EVERY = Math.max(50, Number(process.env.CANVAS_INFERD_OPTIMIZE_EVERY) || 500);

    /** Vector sink: persist inferd-computed chunk vectors into a synapsd space. */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts = {}) {
        const res = await this.#runtime.getActiveDb().storeDocumentEmbeddings(
            parseDocumentId(docId, 'Document ID'), schema, updatedAt, chunks, opts,
        );
        if (++this.#runtime.state.embedStoreCount >= WorkspaceInference.#EMBED_OPTIMIZE_EVERY) {
            this.#runtime.state.embedStoreCount = 0;
            await this.#optimizeSearchIndexes('mid-ingest');
        }
        return res;
    }

    /**
     * Compact Lance fragments, prune old versions and (re)build ANN indexes for
     * all vector spaces + the FTS table. Best-effort: FTS compaction can lose a
     * commit race against concurrent document puts (chokidar ingest) — that
     * attempt aborts harmlessly and the next cadence retries.
     */
    async #optimizeSearchIndexes(reason) {
        const db = this.#runtime.getActiveDb();
        try {
            await db.optimizeVectors();
            await db.optimizeLance();
            this.#runtime.state.logger.info({ workspaceId: this.#workspace.id, reason }, 'Search indexes optimized');
        } catch (error) {
            this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, reason, error: error.message }, 'Search index optimize failed');
        }
    }

    /**
     * Re-resolve this workspace's embedding backends and swap synapsd's vector
     * spaces to match — applied live, no workspace restart.
     *
     * Writes are quiesced first: the workspace's embedding queue is paused and
     * its in-flight batch allowed to finish, otherwise a batch straddling the
     * swap would scatter half its chunks into the outgoing table.
     */
    async applyInferdSpaces() {
        if (!this.#runtime.state.inferd || !this.#workspace.isActive) { return { applied: false, reason: 'workspace not active' }; }
        const spaces = await this.#runtime.state.inferd.spaceConfigsForWorkspace(this.#workspace.id, {
            userId: this.#workspace.owner, config: this.#runtime.config.resolveCredentials(this.#workspace.inferdConfig),
        });
        // Await: the drain below is only meaningful once the pause landed.
        await this.#runtime.state.inferd.pause(this.#workspace.id);
        try {
            await this.#runtime.state.inferd.drained(this.#workspace.id);
            const result = await this.#runtime.getActiveDb().setVectorSpaces(spaces);
            this.#runtime.state.logger.info({ workspaceId: this.#workspace.id, tables: result.tables }, 'Embedding vector spaces swapped');
            return result;
        } finally {
            await this.#runtime.state.inferd.resume(this.#workspace.id);
        }
    }

    /** Document ids under a `ctx://` / `dir://` path — scopes a partial re-embed. */
    async documentIdsUnderScope(scope) {
        return await this.#runtime.getActiveDb().documentIdsUnderScope(scope);
    }

    /** Ledger read: docIds that match `schemas` but have no embedding for `space`. */
    async getUnembeddedDocIds(space = 'text', schemas = null) {
        const ids = await this.#runtime.getActiveDb().getUnembeddedDocIds(space, schemas);
        const eligible = [];
        for (const id of ids) if (await this.#runtime.contacts.isUserFiled(id, { authoredRoot: true })) eligible.push(id);
        return eligible;
    }

    /** Wipe an embedding space (vectors + presence + seen) for a full re-embed. */
    async clearSpace(space = 'text') {
        return await this.#runtime.getActiveDb().clearSpace(space);
    }

    /**
     * Dense-vector tables in this workspace, flagged with which are live. Tables
     * a model swap left behind report `active:false` — they still hold their
     * vectors so switching back is free, and this is how you find the ones worth
     * reclaiming.
     */
    async listVectorTables() {
        return await this.#runtime.getActiveDb().listVectorTables();
    }

    /** Drop a superseded model's vectors + ledger. Refuses live tables. */
    async dropVectorTable(name) {
        return await this.#runtime.getActiveDb().dropVectorTable(name);
    }

    // ── inferd registration + live enqueue ────────────────────────────────────

    /** Register this workspace with the shared inferd service + subscribe events. */
    registerInferd() {
        if (this.#runtime.state.withoutSecrets || !this.#runtime.state.inferd || this.#runtime.state.inferdRegistered) { return; }
        this.#runtime.state.inferd.registerWorkspace(this.#workspace.id, {
            resolveInput: (docId) => this.#workspace.resolveEmbeddingInput(docId),
            storeVectors: (docId, schema, updatedAt, chunks, opts) =>
                this.#workspace.storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts),
            getUnembedded: (space, schemas) => this.#workspace.getUnembeddedDocIds(space, schemas),
            documentIdsUnderScope: (scope) => this.#workspace.documentIdsUnderScope(scope),
            clearSpace: (space) => this.#workspace.clearSpace(space),
            imageDocumentIds: () => this.#workspace.imageDocumentIds(),
            setSummary: (docId, text) => this.#workspace.setDocumentSummary(docId, text),
            onQueueDrained: () => {
                // The shared queue drains after every trickle (a single note
                // save); a full compact + HNSW rebuild per save would dwarf the
                // ingest itself. Only optimize once enough upserts accumulated —
                // queries tolerate a few dozen fragments fine.
                if (this.#runtime.state.embedStoreCount < 50) { return; }
                this.#runtime.state.embedStoreCount = 0;
                return this.#optimizeSearchIndexes('queue-drained');
            },
        }, { userId: this.#workspace.owner, config: this.#runtime.config.resolveCredentials(this.#workspace.inferdConfig) });
        // Live enqueue: new + content-updated docs. Blob ingestion also lands as
        // document.inserted (WorkspaceStoredIndex creates docs), so this covers
        // stored files too — no separate object:add subscription needed.
        //
        // Batch ops (tab ingestion, 100+ uploads, fs/directory bulk ingest) are
        // the common case — they emit `.batch` events with an id array. We
        // subscribe to both the singular and `.batch` variants: some bulk
        // emitters (putManyDirectoryPaths) fire only the singular event with
        // `ids`, regular putMany fires both. The queue dedups by
        // `${wsId}:${id}`, so the one overlap (putMany emitting both) is a
        // harmless no-op — no path is missed or embedded twice.
        //
        // Filing makes backend-only documents eligible for the first time.
        // The handler filters by current placement before adding queue work.
        this.#workspace.on('document.linked', this.onDocEventForEmbed);
        this.#workspace.on('document.linked.batch', this.onDocEventForEmbed);
        this.#workspace.on('document.inserted', this.onDocEventForEmbed);
        this.#workspace.on('document.updated', this.onDocEventForEmbed);
        this.#workspace.on('document.inserted.batch', this.onDocEventForEmbed);
        this.#workspace.on('document.updated.batch', this.onDocEventForEmbed);
        this.#runtime.state.inferdRegistered = true;
    }

    unregisterInferd() {
        if (!this.#runtime.state.inferd || !this.#runtime.state.inferdRegistered) { return; }
        this.#workspace.off('document.linked', this.onDocEventForEmbed);
        this.#workspace.off('document.linked.batch', this.onDocEventForEmbed);
        this.#workspace.off('document.inserted', this.onDocEventForEmbed);
        this.#workspace.off('document.updated', this.onDocEventForEmbed);
        this.#workspace.off('document.inserted.batch', this.onDocEventForEmbed);
        this.#workspace.off('document.updated.batch', this.onDocEventForEmbed);
        this.#runtime.state.inferd.unregisterWorkspace(this.#workspace.id);
        this.#runtime.state.inferdRegistered = false;
    }

    // Handles both single (`{ id }`) and batch (`{ ids: [...] }`) payloads;
    // enqueueMany routes through the same deduped queue as enqueue.
    onDocEventForEmbed = (payload) => {
        if (!this.#runtime.state.inferd) { return; }
        // Unfiled sources never enter the expensive work queue. ResolveInput
        // checks again because a queued document may have been unfiled.
        const ids = Array.isArray(payload?.ids)
            ? payload.ids
            : (payload?.id != null ? [payload.id] : []);
        if (ids.length === 0) { return; }
        const pending = Promise.all(ids.map(async id => await this.#runtime.contacts.isUserFiled(id, { authoredRoot: true }) ? id : null))
            .then(eligible => { if (this.#runtime.state.inferdRegistered) this.#runtime.state.inferd?.enqueueMany(this.#workspace.id, eligible.filter(id => id != null)); })
            .catch(error => this.#runtime.state.logger.debug({ error: error.message }, 'Filing check failed; embedding deferred'))
            .finally(() => this.#runtime.state.embedEligibilityPending.delete(pending));
        this.#runtime.state.embedEligibilityPending.add(pending);
    };

    /**
     * Input source for embedding one document. Return shapes:
     *   - null                          → doc gone (do NOT record as seen)
     *   - { skip:true, schema, ... }    → exists but not inferdable (record as seen)
     *   - { modality, schema, ... }     → inferdable (text|image + text|bytes)
     *
     * A `data/schema/file` is a byte blob: embed it from its *content*
     * (text/* → utf8, image/* → bytes), never from generateEmbeddingsData (which
     * for File yields the location URL string — garbage to embed). Only JSON
     * abstractions (note, …) use generateEmbeddingsData.
     */
    async resolveEmbeddingInput(docId) {
        const doc = await this.#runtime.getActiveDb().getDocument(parseDocumentId(docId, 'Document ID')).catch(() => null);
        if (!doc) { return null; }

        if (!await this.#runtime.contacts.isUserFiled(doc.id, { authoredRoot: true })) return null;

        const schema = doc.schema;
        const updatedAt = doc.updatedAt || new Date().toISOString();
        const chunkOpts = doc.indexOptions?.embeddingOptions?.chunking || {};
        const classification = classifyDocument(doc);
        // Use the classifier's mime (filename-derived when the stored contentType
        // is missing/generic) — the raw metadata.contentType can be the useless
        // 'application/json' default for fs-indexed images, which the embed router
        // (routes on image/*) would reject.
        const contentType = classification.mime || doc.metadata?.contentType || null;
        // User-authored comment rides along on every return shape (even skip/image),
        // so the inferd worker can give any commented doc a dedicated text vector.
        const comment = doc.hasComment ? doc.comment.trim() : '';
        // Generated summary (metadata.summary, captioner output) rides the same
        // rails into its own reserved text-space chunk.
        const summary = doc.hasSummary ? doc.metadata.summary.trim() : '';

        if (classification.isFile()) {
            // Byte blob: only text/image content is inferdable; everything else
            // (pdf, octet-stream, …) is a deliberate skip until a decoder/CLIP
            // model exists. Bytes must be reachable from this instance: stored://,
            // workspace files, or file://<deviceId> when the id is THIS device
            // (foreign-device locations throw and fall through to skip).
            if (!classification.isBlob() || !contentType) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
            const modality = classification.embeddingModality();
            if (!modality) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
            let resolveError = null;
            const resolved = await this.#workspace.resolveDocument(doc).catch((e) => { resolveError = e; return null; });
            if (!resolved?.buffer) {
                // We classified this as an inferdable blob but its bytes are
                // unreachable — usually stale/dead locations (e.g. a removed backend
                // like the legacy fs:home). Surface it instead of silently skipping,
                // so resync location cleanup can be triggered.
                this.#runtime.state.logger.warn({
                    workspaceId: this.#workspace.id,
                    docId: doc.id,
                    modality,
                    contentType,
                    locations: (doc.locations || []).map((l) => l.url),
                    error: resolveError?.message,
                }, 'embed: could not resolve blob bytes (stale/unreachable locations)');
                return { skip: true, schema, updatedAt, contentType, comment, summary };
            }
            if (modality === 'image') {
                const enrichedAt = await this.#enrichImageDocMetadata(doc, resolved.buffer, contentType)
                    .catch((e) => { this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, docId: doc.id, error: e.message }, 'embed: image metadata enrichment failed'); return null; });
                return { modality, schema, updatedAt: enrichedAt || updatedAt, bytes: resolved.buffer, contentType, comment, summary };
            }
            const textAt = await this.#enrichTextDocMetadata(doc, resolved.buffer, contentType)
                .catch((e) => { this.#runtime.state.logger.warn({ workspaceId: this.#workspace.id, docId: doc.id, error: e.message }, 'embed: text metadata enrichment failed'); return null; });
            return { modality, schema, updatedAt: textAt || updatedAt, text: resolved.buffer.toString('utf8'), contentType, chunkOpts, comment, summary };
        }

        // JSON abstraction (note, etc.) → the text the doc exposes for embedding.
        const data = typeof doc.generateEmbeddingsData === 'function' ? doc.generateEmbeddingsData() : null;
        const text = Array.isArray(data) ? data.join('\n').trim() : (typeof data === 'string' ? data.trim() : '');
        if (!text) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
        return { modality: 'text', schema, updatedAt, text, contentType, chunkOpts, comment, summary };
    }

    /**
     * EXIF/GPS/dimensions enrichment at embed time. Stored-backend ingest
     * extracts this inline (WorkspaceStoredIndex); photos that never pass
     * through it (file://-indexed via `ws add`, docs ingested before extraction
     * existed) hit this seam instead — the embed pipeline is the one place every
     * image's bytes already flow through. Extracted keys merge into
     * doc.metadata and an EXIF capture date lands on the 'content' timeline
     * (same convention as stored ingest), so photos are filterable by when they
     * were taken rather than when they were indexed.
     * Returns the post-update updatedAt, or null when nothing was written.
     */
    async #enrichImageDocMetadata(doc, buffer, contentType) {
        const meta = doc.metadata || {};
        // Bail only on keys that prove extraction already ran. A bare `geo` means
        // device/manual geo arrived from a client without EXIF ever being read,
        // so we still extract — the camera's fix outranks the uploader's location
        // and pickGeo below decides, rather than this guard.
        if (meta.exif || meta.dimensions) { return null; }
        const extracted = await extractBlobMetadata({ data: buffer }, { mimeType: contentType, key: `doc:${doc.id}` });
        const patch = {};
        for (const k of ['exif', 'dimensions', 'media']) {
            if (extracted[k] && typeof extracted[k] === 'object') { patch[k] = extracted[k]; }
        }
        // metadata patches shallow-merge top-level keys (Document.update), so
        // `geo` is replaced wholesale — resolve the winner first, and only write
        // when it actually changes to avoid a no-op update.
        const geo = pickGeo(meta.geo, extracted.geo, { incomingSource: 'exif' });
        if (geo && JSON.stringify(geo) !== JSON.stringify(meta.geo)) { patch.geo = geo; }
        if (Object.keys(patch).length === 0) { return null; }

        const update = { id: doc.id, metadata: patch, updatedAt: new Date().toISOString() };
        const capturedAt = extracted.exif?.capturedAt;
        const prior = Array.isArray(doc.timelines) ? doc.timelines : [];
        if (capturedAt && !prior.some((t) => (t.timeline || t.name) === 'content')) {
            update.timelines = [...prior, { timeline: 'content', start: capturedAt }];
        }
        // emitEvent:false — this runs inside the embed pipeline; a
        // document.updated event here would re-enqueue the doc and CLIP-embed
        // every photo a second time.
        // Enrichment changes content indexes, never virtual-tree placement.
        await this.#runtime.getActiveDb().put(update, { context: null, emitEvent: false });
        return update.updatedAt;
    }

    /**
     * The searchable head of a text blob, at embed time.
     *
     * Same seam as image EXIF, for the same reason: stored-backend ingest
     * extracts this inline, and blobs that never passed through it (`ws add`
     * via file://, anything ingested before extraction existed) hit this instead
     * — the embed pipeline is the one place every file's bytes already flow.
     *
     * Without it a File is FTS-indexed by its name alone, so a markdown file, a
     * config or a source file matched nothing you could remember about what it
     * says. Vectors already covered this case; keyword search did not.
     * Returns the post-update updatedAt, or null when nothing was written.
     */
    async #enrichTextDocMetadata(doc, buffer, contentType) {
        if (doc.metadata?.text?.content) { return null; }
        const extracted = await extractBlobMetadata({ data: buffer }, { mimeType: contentType, key: `doc:${doc.id}` });
        if (!extracted.text?.content) { return null; }

        // emitEvent:false — this runs inside the embed pipeline; a
        // document.updated event here would re-enqueue the doc and embed it a
        // second time.
        const update = { id: doc.id, metadata: { text: extracted.text }, updatedAt: new Date().toISOString() };
        // Enrichment changes content indexes, never virtual-tree placement.
        await this.#runtime.getActiveDb().put(update, { context: null, emitEvent: false });
        return update.updatedAt;
    }
}
