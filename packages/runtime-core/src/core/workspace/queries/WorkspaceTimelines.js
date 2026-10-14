import { parseDocumentId } from '../../../utils/documentId.js';

// Workspace delegates this domain to a collaborator. Runtime dependencies stay
// private to the local host; the public Workspace API is the transport boundary.
export default class WorkspaceTimelines {
    #runtime;
    constructor(_workspace, runtime) { this.#runtime = runtime; }

    // ─────────────────────────────────────────────────────────────────────────
    // Timeline API (delegated to db.timeline)
    // ─────────────────────────────────────────────────────────────────────────

    async listTimelines() {
        return await this.#runtime.getActiveDb().timeline.listTimelines();
    }

    async createTimeline(name) {
        return await this.#runtime.getActiveDb().timeline.createTimeline(name);
    }

    hasTimeline(name) {
        return this.#runtime.getActiveDb().timeline.hasTimeline(name);
    }

    async deleteTimeline(name) {
        return await this.#runtime.getActiveDb().timeline.deleteTimeline(name);
    }

    async queryTimeline(timelineNames, interval, options = {}) {
        return await this.#runtime.getActiveDb().timeline.queryInterval(timelineNames, interval, null, options);
    }

    // Per-bucket counts across timelines, intersected with the same candidate
    // scope as list() (context/directory path, features, filters, canvas
    // querySpec folding) — so rail densities always agree with the document list.
    async timelineHistogram(names, buckets, spec = {}) {
        const db = this.#runtime.getActiveDb();
        const querySpec = this.#runtime.docs.normalizeQuerySpec(this.#runtime.queries.composeCanvasQuerySpec(spec));
        const { bitmap } = await db.resolveCandidates(querySpec);
        return await db.timeline.histogram(names, buckets, bitmap);
    }

    async insertTimelineEntry(timelineName, id, interval) {
        return await this.#runtime.getActiveDb().timeline.insert(timelineName, parseDocumentId(id, 'Document ID'), interval);
    }

    // Additional (non-primary) positions for a document on one timeline — the
    // multi-position membership plane. The primary interval stays insert()'s.
    async insertTimelineEntries(timelineName, id, intervals) {
        return await this.#runtime.getActiveDb().timeline.insertEntries(timelineName, parseDocumentId(id, 'Document ID'), intervals);
    }

    // Removes the document's PRIMARY interval (BSI planes). Membership cells
    // from multi-position entries are derived from intervals, so clearing them
    // needs the intervals they were inserted with — pass them via
    // `options.intervals` (document-declared entries never need this: the row
    // is re-derived on update/delete).
    async removeTimelineEntry(timelineName, id, options = {}) {
        const db = this.#runtime.getActiveDb();
        const docId = parseDocumentId(id, 'Document ID');
        if (Array.isArray(options.intervals) && options.intervals.length > 0) {
            await db.timeline.removeEntries(timelineName, docId, options.intervals);
        }
        return await db.timeline.remove(timelineName, docId);
    }

    // Observed scale tiers for a timeline (both planes, coarse→fine).
    // Informational — membership tiling is adaptive (per-entry notation-derived
    // floor, synapsd 3.7.0); no per-timeline granularity config exists anymore.
    async getTimelineScales(name) {
        return await this.#runtime.getActiveDb().timeline.getScales(name);
    }

    // Covering decomposition of a range at the range's own notation-derived
    // floor — what the membership plane would store/probe. Debug/UI surface.
    decomposeTimelineRange(timelineName, interval) {
        return this.#runtime.getActiveDb().timeline.decomposeRange(timelineName, interval);
    }
}
