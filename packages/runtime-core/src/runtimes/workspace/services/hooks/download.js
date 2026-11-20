'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sanitizeSegment, joinKey, mimeForFilename } from './key-utils.js';
import { resolveKind, getFetcher } from '../fetchers/index.js';
import { listFiles } from '../fetchers/lib.js';

/**
 * The `download` rule action: fetch what a link (tab / bookmark / any document
 * with `data.url`) points at and file the result as a real file.
 *
 *   { "action": "download", "to": "workspace:home", "folder": "Downloads",
 *     "kind": "auto", "recursive": true, "insert": "/media/saved", "tags": [] }
 *
 * `kind` selects a fetcher driver (services/fetchers/drivers/*): 'auto'
 * classifies by URL shape, then by content type, then falls back to `page`.
 * The drivers own the how (canvas-captured, yt-dlp, wget, plain HTTP); this action owns the
 * where: placement under a backend, the file document, and idempotency.
 *
 *   auto     — arXiv → PDF; YouTube & co. → video; image/video/PDF URLs → the
 *              file itself; anything else → the page.
 *   file     — the URL's bytes as-is (aliases: image, arxiv).
 *   video    — yt-dlp (best video+audio, merged). `format` overrides.
 *   page     — one offline HTML file from the workspace capture service.
 *   website  — recursive mirror, `depth` levels deep (default 2, max 5).
 *
 * Files land under `folder` (plus the sub-path below the matched `when.path`
 * with `recursive: true`) in the workspace home folder, then move on to `to`
 * when that is another backend. The entry file (image, video, PDF, page's
 * index.html) is indexed as a file document filed exactly where the link is
 * (or at `insert` paths) and tagged with `tags`. A ledger in var/ makes the
 * action idempotent for each source document, rule and destination while
 * the downloaded document still exists. Retained links have includes and
 * derived-from relations; deleteSource removes the link after delivery.
 *
 * Downloads are awaited (`timeout` seconds, default 600, max 3600) so the run
 * log carries the outcome; a timeout kills the whole process group.
 */

const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const LEDGER_FILE = 'download-ledger.json';
const activeDownloads = new WeakMap();

function pageTitle(value) {
    return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

// A workspace has one runtime process. Reserve both identities before awaiting
// anything, so overlapping events cannot capture the same URL or title twice.
export async function download(action, options) {
    const { workspace, doc } = options;
    let active = activeDownloads.get(workspace);
    if (!active) { active = new Map(); activeDownloads.set(workspace, active); }
    const keys = [`url:${typeof doc?.data?.url === 'string' ? doc.data.url.trim() : doc?.id}`];
    const title = pageTitle(doc?.data?.title);
    if (title) keys.push(`title:${title}`);
    const pending = keys.map(key => active.get(key)).filter(Boolean);
    let release;
    const done = new Promise(resolve => { release = resolve; });
    for (const key of keys) active.set(key, done);
    try {
        await Promise.all(pending);
        return await downloadUnlocked(action, options);
    } finally {
        release();
        for (const key of keys) if (active.get(key) === done) active.delete(key);
    }
}

async function findSavedPage(workspace, url, title) {
    // Include unfiled captures: a prior run may have indexed its HTML and then
    // failed to file or transfer it. Exact comparisons avoid fuzzy FTS matches.
    for (let offset = 0; ; offset += 200) {
        const batch = await workspace.list({ features: { allOf: ['data/schema/file', 'data/mime/text/html'] }, context: null, directory: null,
            applyCanvasQuerySpec: false, order: 'asc', limit: 200, offset });
        if (batch?.error) throw new Error(String(batch.error));
        const docs = Array.isArray(batch) ? batch : batch.data;
        for (const saved of docs) {
            if (saved.metadata?.contentType !== 'text/html' || !saved.metadata?.capture) continue;
            const sameUrl = saved.metadata.sourceUrl === url;
            const sameTitle = title && pageTitle(saved.data?.title) === title;
            if (!sameUrl && !sameTitle) continue;
            const endpoints = await workspace.documentByteEndpoints(saved, { readable: true });
            if (endpoints.length) return { saved, endpoints, reason: sameUrl ? 'URL' : 'title' };
        }
        if (docs.length < 200) return null;
    }
}

// ── Placement ────────────────────────────────────────────────────────────────

function uniquePath(target) {
    if (!fs.existsSync(target)) { return target; }
    const ext = path.extname(target);
    const base = target.slice(0, -ext.length || undefined);
    for (let i = 1; i < 10_000; i++) {
        const candidate = `${base}-${i}${ext}`;
        if (!fs.existsSync(candidate)) { return candidate; }
    }
    throw new Error(`no free name for ${target}`);
}

function moveTree(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.renameSync(src, dest);
    } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
            fs.cpSync(src, dest, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true });
        } else { throw err; }
    }
}

function readLedger(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeLedger(file, ledger) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...readLedger(file), ...ledger }, null, 2));
    } catch { /* best effort */ }
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── The action ───────────────────────────────────────────────────────────────

async function downloadUnlocked(action, { workspace, doc, context, scope, logger, provenance, helpers, fetchers = {} }) {
    const { interpolate, expandKeyTemplate, parseLinkTarget, directorySelector } = helpers;
    if (!doc?.id) { logger.debug('rule download: event carries no document, skipping'); return; }
    if (doc.schema === 'data/schema/file') return { status: 'skipped', error: 'Already a downloaded file' };
    if ((scope.rule?.when?.path || scope.rule?.when?.pathExact || scope.rule?.when?.eventPathExact) && !scope.match) {
        return { status: 'skipped', error: 'No matching filing destination' };
    }
    const url = typeof doc?.data?.url === 'string' ? doc.data.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) { logger.debug(`rule download: ${doc.id} has no http(s) url, skipping`); return; }

    if (action.recursive === true && !scope.match) throw new Error('Recursive download requires an explicit filing-path match');

    const to = String(action.to || 'workspace:home').trim();
    const render = (template) => interpolate(expandKeyTemplate(String(template), { doc, sourceKey: '' }), scope);
    const folder = action.folder != null && String(action.folder).trim() !== '' ? render(action.folder) : '';
    const rel = action.recursive === true ? String((action.pathMode === 'full' ? scope.match?.path : scope.match?.rel) || '') : '';
    const destRel = joinKey(folder, rel);
    const homeRoot = path.resolve(workspace.homePath || path.join(workspace.rootPath, 'home'));
    const destDir = path.resolve(homeRoot, destRel || '.');
    if (destDir !== homeRoot && !destDir.startsWith(`${homeRoot}${path.sep}`)) {
        logger.warn(`rule download: refusing folder outside home/: ${destRel}`);
        return;
    }

    const targets = action.insert
        ? (Array.isArray(action.insert) ? action.insert : [action.insert]).map((p) => parseLinkTarget(interpolate(String(p), scope)))
        : [];
    if (!targets.length) {
        const c = typeof context?.classify === 'function' ? context.classify() : null;
        for (const [tree, paths] of Object.entries(c?.eventTreePaths || {})) {
            if (tree === 'backends') { continue; }
            for (const p of paths) { targets.push({ tree, path: p }); }
        }
    }
    // Backfills and non-filing events have no insertion selector. Resolve
    // current placements from the workspace, preserving named tree identity.
    if (!targets.length) {
        for (const placement of await workspace.listDocumentPlacements(doc.id)) {
            if (placement.tree === 'backends') continue;
            for (const targetPath of placement.paths || []) {
                const selector = { tree: placement.treeId, path: targetPath };
                targets.push({ tree: placement.tree, path: targetPath, selector: placement.type === 'directory'
                    ? { context: null, directory: selector } : { context: selector } });
            }
        }
    }
    const fileAlongside = async (id) => {
        for (const target of targets) {
            const selector = target.selector || (target.tree !== 'context'
                ? { context: null, directory: directorySelector(target) }
                : { context: workspace.getContextTreeSelector(target.path) });
            await workspace.link(id, { ...selector, features: action.tags || [], emitEvent: false, provenance });
        }
    };

    // Reuse a completed download for this source, rule and destination.
    const ledgerFile = path.join(workspace.varPath, LEDGER_FILE);
    const ledger = readLedger(ledgerFile);
    const ledgerKey = JSON.stringify([scope.rule?.id || 'rule', doc.id, url, to, destRel, action.insert || null, action.kind || 'auto']);
    const previous = ledger[ledgerKey];
    const relate = async (id) => {
        await workspace.assertRelation(id, 'derived-from', doc.id);
        await workspace.assertRelation(doc.id, 'includes', id);
    };
    const finish = async () => {
        if (action.deleteSource === true) await workspace.delete(doc.id, { provenance });
    };
    if (previous?.complete && (to !== 'workspace:home' || fs.existsSync(path.resolve(homeRoot, previous.file)))
        && await workspace.get(previous.documentId)) {
        await relate(previous.documentId);
        await fileAlongside(previous.documentId);
        await finish();
        logger.debug(`rule download: ${url} already downloaded (doc ${previous.documentId}), filing and relations reconciled`);
        return { status: 'skipped', reason: 'already downloaded', documentId: previous.documentId };
    }

    const kind = await resolveKind(url, action.kind, fetchers.probe);
    if (kind === 'page') {
        const existing = await findSavedPage(workspace, url, pageTitle(doc.data?.title));
        if (existing) {
            const { saved, endpoints, reason } = existing;
            const name = action.key
                ? sanitizeSegment(render(action.key).replace(/\{\{\s*ext\s*\}\}/g, '.html'), 'page.html')
                : path.basename(saved.metadata.filename || endpoints[0].key);
            let key = joinKey(destRel, name);
            await relate(saved.id);
            await fileAlongside(saved.id);
            const keepsPaths = workspace.backendKeepsPaths(to);
            if (!endpoints.some(e => e.backend === to && (!keepsPaths || e.key === key))) {
                const copied = await workspace.transferDocumentBytes(saved, {
                    to, mode: 'copy', key, onConflict: action.onConflict || 'rename', from: endpoints[0],
                });
                const delivered = copied?.locations?.find(location => location.backend === to && location.synced
                    && (!keepsPaths || location.key === key || copied.added?.includes(location.url)));
                if (!delivered) throw new Error(`Download delivery to ${to} is not complete; source link retained`);
                key = delivered.key;
            }
            writeLedger(ledgerFile, { [ledgerKey]: { file: key, documentId: saved.id, complete: true, at: new Date().toISOString() } });
            await finish();
            logger.debug(`rule download: ${url} reusing saved page by ${reason} (doc ${saved.id}), filing and relations reconciled`);
            return { status: 'skipped', reason: `saved page with matching ${reason}`, documentId: saved.id };
        }
    }
    const fetcher = getFetcher(kind);
    const fetchUrl = fetcher.resolveUrl(url);
    const timeoutMs = Math.min(Math.max(5, Number(action.timeout) || DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S) * 1000;
    const maxBytes = Math.max(1024, Number(action.maxBytes) || DEFAULT_MAX_BYTES);

    const eventId = scope.payload?.eventId || crypto.randomUUID();
    const handlerId = String(scope.rule?.id || 'rule').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const workDir = path.join(workspace.tmpPath, handlerId, `download-${eventId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const title = String(doc?.data?.title || '').trim();
    const fallbackBase = sanitizeSegment(title, `download-${doc.id}`);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

    // `fetchers[kind]` lets tests swap a driver's fetch() for a fake.
    const run = fetchers[kind] || ((u, ctx) => fetcher.fetch(u, ctx));
    const metadata = {};
    let entry;
    try {
        logger.debug(`rule download: ${doc.id} ${kind} ${fetchUrl} → home/${destRel || '.'}`);
        entry = await run(fetchUrl, { workspace, metadata, workDir, timeoutMs, signal: controller.signal, maxBytes, fallbackBase, logger, action });
    } catch (err) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new Error(`download of ${fetchUrl} failed: ${err.message}`, { cause: err });
    } finally {
        clearTimeout(abortTimer);
    }

    // Move what was fetched into place. A 'tree' layout (website mirror)
    // keeps its host/path tree below the destination folder; a single file
    // lands directly in it under a collision-free name.
    fs.mkdirSync(destDir, { recursive: true });
    let entryFinal;
    if (fetcher.layout === 'tree') {
        const topLevel = fs.readdirSync(workDir);
        for (const name of topLevel) {
            const src = path.join(workDir, name);
            const dest = path.join(destDir, name);
            if (fs.existsSync(dest) && fs.statSync(dest).isDirectory() && fs.statSync(src).isDirectory()) {
                fs.cpSync(src, dest, { recursive: true, force: true });
                fs.rmSync(src, { recursive: true, force: true });
            } else {
                moveTree(src, fs.existsSync(dest) ? uniquePath(dest) : dest);
            }
        }
        entryFinal = path.join(destDir, path.relative(workDir, entry));
        if (!fs.existsSync(entryFinal)) { entryFinal = listFiles(destDir).find((f) => /\.html?$/i.test(f)) || entryFinal; }
    } else {
        const name = action.key ? sanitizeSegment(render(action.key).replace(/\{\{\s*ext\s*\}\}/g, path.extname(entry)), path.basename(entry)) : path.basename(entry);
        const target = path.join(destDir, name);
        if (fs.existsSync(target) && action.onConflict === 'error') {
            fs.rmSync(workDir, { recursive: true, force: true });
            throw new Error(`Download destination already exists: ${target}`);
        }
        entryFinal = action.onConflict === 'overwrite' ? target : uniquePath(target);
        moveTree(entry, entryFinal);
    }
    fs.rmSync(workDir, { recursive: true, force: true });

    // Index the entry file exactly where the link is filed (or at `insert`).
    const relFile = path.relative(homeRoot, entryFinal).split(path.sep).join('/');
    const stat = fs.statSync(entryFinal);
    const checksum = sha256(entryFinal);
    const contentType = mimeForFilename(entryFinal);
    // Register the physical file synchronously; the home watcher may not have
    // seen it yet, and transfers require an indexed backend/key source.
    const source = fs.createReadStream(entryFinal);
    let stored;
    try { stored = await workspace.writeBackendObject('file', 'workspace:home', relFile, source); }
    finally { source.destroy(); }
    if (!stored?.ok) throw new Error(`Download could not be registered in workspace:home: ${stored?.reason || 'write failed'}`);
    const fileDoc = {
        schema: 'data/schema/file',
        checksumArray: [`sha256/${checksum}`],
        locations: [{ url: `stored://workspace:home/${relFile}` }],
        metadata: { ...metadata, contentType, size: stat.size, filename: path.basename(entryFinal), sourceUrl: url, sourceDocumentId: doc.id },
        data: { title: title || path.basename(entryFinal) },
    };
    // Index and relate before filing or transferring. If a destination fails,
    // the saved document remains traceable from the source link.
    const inserted = await context.insert(fileDoc, { context: null });
    const newId = inserted?.id ?? inserted;
    if (!['string', 'number'].includes(typeof newId)) throw new Error('Download was not indexed; source link retained');
    await relate(newId);
    await fileAlongside(newId);

    // Another backend than home: hand the bytes over (the index entry follows).
    if (to && to !== 'workspace:home') {
        const moved = await workspace.transferDocumentBytes(await workspace.get(newId), {
            to, mode: 'move', key: relFile, onConflict: action.onConflict || 'rename',
            from: { backend: 'workspace:home', key: relFile },
        });
        if (!moved || moved.state === 'pending') throw new Error(`Download delivery to ${to} is not complete; source link retained`);
        if (moved) { logger.debug(`rule download: ${relFile} moved on to ${to}`); }
    }

    writeLedger(ledgerFile, { [ledgerKey]: { file: relFile, documentId: newId, complete: true, at: new Date().toISOString() } });
    await finish();

    logger.debug(`rule download: ${doc.id} ${kind} ${fetchUrl} → ${to || 'workspace:home'} (doc ${newId}, filed at ${targets.map((t) => `${t.tree}:${t.path}`).join(', ') || 'nowhere'})`);
    return { status: 'ok', file: relFile, documentId: newId };
}
