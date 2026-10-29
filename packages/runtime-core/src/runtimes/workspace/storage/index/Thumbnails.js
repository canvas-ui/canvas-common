import { renderVideoThumbnail, VIDEO_THUMBNAIL_MAX_BYTES } from './video-thumbnail.js';
import { availableLocations } from 'canvas-synapsd/src/utils/document-locations.js';
import { WorkspaceStoredIndex } from '../WorkspaceStoredIndex.js';
import path from 'path';

export default class Thumbnails {
    #index;
    #runtime;
    constructor(index, runtime) { this.#index = index; this.#runtime = runtime; }


    /**
     * On-demand thumbnail for an image, PDF or video document, cached in Stored's internal
     * cacache store ({WORKSPACE_ROOT}/cache — services.stored.cache)
     * keyed `thumb:<checksum>:<size>` — derived artifacts never touch the main
     * index and the cache is purgeable at any time (purgeThumbnails on
     * delete/destroy, clearThumbnailCache for a full wipe).
     * @param {object} doc File document (metadata.contentType image/* or
     *   application/pdf — PDFs thumbnail as a raster of page 1)
     * @param {number} [size] longest-edge px, clamped to THUMBNAIL_SIZES
     * @returns {Promise<{buffer: Buffer, mime: string}|null>} null when not
     *   thumbnailable / no checksum / no reachable bytes
     */
    async getThumbnail(doc, size = 256) {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const contentType = String(doc?.metadata?.contentType || '');
        const isPdf = contentType === 'application/pdf';
        const isVideo = contentType.startsWith('video/');
        if (!contentType.startsWith('image/') && !isPdf && !isVideo) return null;
        const checksum = Array.isArray(doc?.checksumArray) ? doc.checksumArray[0] : null;
        if (!checksum) return null;

        const edge = WorkspaceStoredIndex.THUMBNAIL_SIZES.reduce(
            (best, s) => (Math.abs(s - size) < Math.abs(best - size) ? s : best),
            WorkspaceStoredIndex.THUMBNAIL_SIZES[0],
        );
        const cacheKey = `thumb:${checksum}:${edge}`;
        const cache = this.#runtime.state.stored.cache;

        const hit = await cache.get(cacheKey).catch(() => null);
        if (hit?.data) return { buffer: hit.data, mime: 'image/webp' };

        if (isVideo && Number(doc?.metadata?.size) > VIDEO_THUMBNAIL_MAX_BYTES) return null;

        // Miss → resolve original bytes from the first reachable location.
        // resolve() returns { data, ranged }, not the raw buffer — pass the
        // bytes to sharp, not the wrapper object (else sharp throws and the
        // thumbnail 500s for every not-yet-cached image).
        let original = null;
        for (const loc of availableLocations(doc)) {
            if (!loc?.url) continue;
            try { const res = await this.#index.resolve(loc.url); if (res?.data) { original = res.data; break; } } catch { /* next */ }
        }
        if (!original) return null;

        const source = isPdf ? await this.#renderPdfFirstPage(original, edge)
            : isVideo ? await renderVideoThumbnail(original, edge) : original;
        if (!source) return null;

        const { default: sharp } = await import('sharp');
        const buffer = await sharp(source)
            .rotate() // honor EXIF orientation
            .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
        await cache.put(cacheKey, buffer, { source: checksum, size: edge }).catch((err) =>
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: err.message }, 'Thumbnail cache write failed'));
        return { buffer, mime: 'image/webp' };
    }

    // Bounds for PDF first-page rasterization — a hostile or degenerate PDF
    // must not stall the request path or balloon memory.

    /**
     * Rasterize page 1 of a PDF to a PNG buffer using pdfjs-dist +
     * @napi-rs/canvas — a pure-JS parse (no native PDF library), with
     * embedded-script eval disabled.
     * @param {Buffer} bytes the whole PDF
     * @param {number} edge longest-edge px of the target render
     * @returns {Promise<Buffer|null>} null when oversized, unparsable, or the
     *   render exceeds the timeout
     */
    async #renderPdfFirstPage(bytes, edge) {
        if (!Buffer.isBuffer(bytes) || bytes.length === 0
            || bytes.length > WorkspaceStoredIndex.PDF_THUMBNAIL_MAX_BYTES) return null;
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), WorkspaceStoredIndex.PDF_THUMBNAIL_TIMEOUT_MS);
            timer.unref?.();
        });
        const render = (async () => {
            const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const { createCanvas } = await import('@napi-rs/canvas');
            const { createRequire } = await import('node:module');
            // Built-in Type1 fonts (Helvetica etc.) ship with pdfjs — without
            // this, text set in a standard font renders blank.
            const standardFontDataUrl = path.join(
                path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
                'standard_fonts',
            ) + path.sep;
            const task = getDocument({
                data: new Uint8Array(bytes),
                isEvalSupported: false,
                useSystemFonts: false,
                standardFontDataUrl,
            });
            try {
                const pdf = await task.promise;
                const page = await pdf.getPage(1);
                const base = page.getViewport({ scale: 1 });
                const scale = edge / Math.max(base.width, base.height, 1);
                const viewport = page.getViewport({ scale });
                const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
                const ctx = canvas.getContext('2d');
                // PDFs have no intrinsic background — paint the page white.
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, viewport }).promise;
                return canvas.toBuffer('image/png');
            } finally {
                task.destroy().catch(() => {});
            }
        })().catch((err) => {
            this.#runtime.state.logger.warn({ workspaceId: this.#runtime.state.workspaceId, error: err.message }, 'PDF thumbnail render failed');
            return null;
        });
        try { return await Promise.race([render, timeout]); }
        finally { clearTimeout(timer); }
    }

    /**
     * Drop cached thumbnails (all sizes) for the given documents or primary
     * checksum strings. Called from the delete/destroy paths so derived
     * artifacts never outlive their source blobs — otherwise a stale entry
     * lingers in the stored cache forever. Best-effort: cacache.rm.entry on a
     * missing key is a no-op.
     */
    async purgeThumbnails(docsOrChecksums = []) {
        if (!this.#runtime.state.stored) return;
        const cache = this.#runtime.state.stored.cache;
        for (const item of docsOrChecksums) {
            const checksum = typeof item === 'string'
                ? item
                : (Array.isArray(item?.checksumArray) ? item.checksumArray[0] : null);
            if (!checksum) continue;
            for (const edge of WorkspaceStoredIndex.THUMBNAIL_SIZES) {
                await cache.delete(`thumb:${checksum}:${edge}`).catch(() => {});
            }
        }
    }

    /**
     * Remove EVERY cached thumbnail (thumb:* entries in the stored cache). The
     * cache is a derived artifact store — thumbnails regenerate on demand, so
     * clearing is always safe. Other cache content (non-thumb keys) is left
     * untouched.
     */
    async clearThumbnailCache() {
        if (!this.#runtime.state.stored) throw new Error('WorkspaceStoredIndex is not running');
        const cache = this.#runtime.state.stored.cache;
        let removed = 0;
        for await (const entry of cache.listStream()) {
            if (typeof entry?.key === 'string' && entry.key.startsWith('thumb:')) {
                await cache.delete(entry.key).catch(() => {});
                removed++;
            }
        }
        return { removed };
    }
}
