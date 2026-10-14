import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { parseInitializeDocument } from 'canvas-synapsd/src/utils/document.js';
import { predicateId } from 'canvas-synapsd/src/indexes/edges/predicates.js';

const FORMAT = 'canvas-subtree';
const CONTACT_RELATIONS = new Set(['authored-by', 'addressed-to', 'mentions', 'depicts', 'member-of']);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const join = (parent, child) => `${parent === '/' ? '' : parent}/${child}`;
const union = (a = [], b = [], key = JSON.stringify) => [...new Map([...a, ...b].map(item => [key(item), item])).values()];

export function subtreePath(value = '/') {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) throw fail('Invalid tree path');
    const parts = value.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) throw fail('Tree paths cannot contain . or ..');
    return parts.length ? `/${parts.join('/')}` : '/';
}

function nodeAt(root, path) {
    return path.split('/').filter(Boolean).reduce((node, name) => node?.children?.find(child => child.name === name), root);
}

async function memberIds(tree, path, node) {
    if (node.type === 'canvas') return [];
    if (tree.type === 'directory') return (await tree.find(path))?.toArray() || [];
    // Context paths are intersections, not recursive directory listings. Never
    // export a reused layer's documents from outside the selected branch.
    const layers = tree.resolveLayerIds(path);
    if (!layers.length) layers.push(tree.rootLayer.id);
    let members = null;
    for (const id of layers) {
        const bitmap = await tree.collection.getBitmap(id, false);
        if (!bitmap) return [];
        if (members) members.andInPlace(bitmap);
        else members = bitmap.clone();
    }
    return members?.toArray() || [];
}

/** Metadata and graph only. No backend reads, byte copies, or source writes. */
export async function exportSubtree(db, tree, path, source = {}, { dependencies = 'related', report = null } = {}) {
    if (!['none', 'related'].includes(dependencies)) throw fail('Unknown dependency selection');
    path = subtreePath(path);
    const root = nodeAt(tree.buildJsonTree(), path);
    if (!root) throw fail('Subtree not found', 404);
    if (root.type === 'canvas') throw fail('Select a folder to export its documents and saved views');
    const nodes = [];
    const selected = new Set();
    const queue = [{ node: root, path, relative: '' }];
    report?.phase('folders');
    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const { children = [], locked: _locked, lockedBy: _holders, ...view } = item.node;
        const documentIds = await memberIds(tree, item.path, item.node);
        documentIds.forEach(id => selected.add(id));
        nodes.push({ ...clone(view), path: item.relative, documentIds });
        for (const child of children) queue.push({ node: child, path: join(item.path, child.name), relative: item.relative ? `${item.relative}/${child.name}` : child.name });
        if (i % 100 === 0) await setImmediate();
    }
    const documents = new Map();
    const skipped = new Map();
    const pending = [...selected];
    const queued = new Set(pending);
    const read = async id => {
        if (documents.has(id)) return documents.get(id);
        const doc = await db.get(id);
        if (!doc) {
            skipped.set(id, { id, reason: 'not-found' });
            return null;
        }
        return clone(typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
    };
    const relations = [];
    report?.phase('documents');
    for (let i = 0; i < pending.length; i++) {
        const id = pending[i];
        if (documents.has(id)) continue;
        const doc = await read(id);
        if (!doc) {
            report?.progress(i + 1, pending.length);
            if (i % 50 === 0) await setImmediate();
            continue;
        }
        documents.set(id, doc);
        skipped.delete(id);
        for (const edge of db.edges.edgesOf(id).outgoing) {
            const meta = db.edges.edge(id, edge.p, edge.to)?.meta;
            relations.push({ from: id, p: edge.p, to: edge.to, ...(meta?.src && meta.src !== 'doc' ? { meta: clone(meta) } : {}) });
            if (dependencies !== 'related' || queued.has(edge.to)) continue;
            if (edge.p !== 'includes' && !CONTACT_RELATIONS.has(edge.p)) continue;
            const target = await db.get(edge.to);
            if (!target) skipped.set(edge.to, { id: edge.to, reason: 'not-found' });
            if (target && (edge.p === 'includes' || /^data\/schema\/identity(?:\/|$)/.test(target.schema))) {
                queued.add(edge.to);
                pending.push(edge.to);
            }
        }
        report?.progress(i + 1, pending.length);
        if (i % 50 === 0) await setImmediate();
    }
    const externalReferences = [];
    // Missing memberships must not make an otherwise valid archive fail the
    // importer's absent-document check. Keep dangling relationship targets as
    // external references so import preserves their unresolved provenance.
    for (const node of nodes) node.documentIds = node.documentIds.filter(id => documents.has(id));
    const subtreeDocuments = [...selected].filter(id => documents.has(id)).length;
    for (const id of new Set(relations.filter(edge => !documents.has(edge.to)).map(edge => edge.to))) {
        const target = await db.get(id);
        externalReferences.push({ id, schema: target?.schema || null, checksumArray: target?.checksumArray || [] });
    }
    return {
        format: FORMAT, version: 1, id: randomUUID(), exportedAt: new Date().toISOString(),
        source: { ...source, tree: { id: tree.id, name: tree.name, type: tree.type }, path },
        dependencies, nodes, documents: [...documents.values()], relations, externalReferences,
        skippedDocuments: [...skipped.values()],
        summary: { folders: nodes.length, subtreeDocuments, supportingDocuments: documents.size - subtreeDocuments, documents: documents.size, externalRelations: relations.filter(edge => !documents.has(edge.to)).length, skippedDocuments: skipped.size },
    };
}

/** Validate the entire archive before writing any destination state. */
export async function validateSubtreeArchive(archive) {
    if (!archive || archive.format !== FORMAT || archive.version !== 1 || typeof archive.id !== 'string') throw fail('Not a supported Canvas subtree export');
    if (!['context', 'directory'].includes(archive.source?.tree?.type)) throw fail('Invalid source tree type');
    if (!Array.isArray(archive.nodes) || !archive.nodes.length || archive.nodes.length > 100000
        || !Array.isArray(archive.documents) || archive.documents.length > 1000000
        || !Array.isArray(archive.relations) || !Array.isArray(archive.externalReferences)) throw fail('Invalid subtree archive collections');
    const docs = new Map();
    for (const [i, doc] of archive.documents.entries()) {
        if (!Number.isSafeInteger(doc?.id) || doc.id <= 0 || docs.has(doc.id)) throw fail('Duplicate or invalid source document ID');
        if (!Array.isArray(doc.checksumArray) || !doc.checksumArray.length || !doc.checksumArray.every(value => typeof value === 'string' && value.includes('/'))) throw fail(`Document ${doc.id} has no valid checksums`);
        try {
            const parsed = parseInitializeDocument(clone(doc));
            parsed.validate();
            parsed.validateData();
        } catch (error) { throw fail(`Document ${doc.id}: ${error.message}`); }
        docs.set(doc.id, doc);
        if (i % 100 === 0) await setImmediate();
    }
    const paths = new Set();
    for (const [i, node] of archive.nodes.entries()) {
        if (typeof node?.path !== 'string' || (i === 0 ? node.path !== '' : !node.path || node.path.startsWith('/'))
            || (node.path && subtreePath(node.path).slice(1) !== node.path) || paths.has(node.path)) throw fail('Invalid or duplicate relative folder path');
        if (i > 0 && !paths.has(node.path.split('/').slice(0, -1).join('/'))) throw fail('Folders must follow their parent');
        if (!['context', 'directory', 'canvas', 'root'].includes(node.type)) throw fail(`Unsupported node type: ${node.type}`);
        if (typeof node.name !== 'string' || (i > 0 && node.name !== node.path.split('/').pop())) throw fail('Folder name does not match its path');
        if (node.metadata != null && (typeof node.metadata !== 'object' || Array.isArray(node.metadata))) throw fail('Invalid folder metadata');
        for (const field of ['label', 'description', 'color']) {
            if (node[field] != null && typeof node[field] !== 'string') throw fail(`Invalid folder ${field}`);
        }
        if (!Array.isArray(node.documentIds) || node.documentIds.some(id => !docs.has(id))) throw fail('Folder refers to an absent document');
        paths.add(node.path);
        if (i % 100 === 0) await setImmediate();
    }
    const externalIds = new Set();
    for (const [i, ref] of archive.externalReferences.entries()) {
        if (!Number.isSafeInteger(ref?.id) || ref.id <= 0 || docs.has(ref.id) || externalIds.has(ref.id)
            || !(ref.schema === null || typeof ref.schema === 'string') || !Array.isArray(ref.checksumArray)
            || !ref.checksumArray.every(value => typeof value === 'string')) throw fail('Invalid external reference');
        externalIds.add(ref.id);
        if (i % 1000 === 0) await setImmediate();
    }
    const targets = new Set([...docs.keys(), ...archive.externalReferences.map(ref => ref.id)]);
    for (const [i, edge] of archive.relations.entries()) {
        if (!docs.has(edge.from) || !targets.has(edge.to)) throw fail('Relation refers to an unknown document');
        try { predicateId(edge.p); } catch (error) { throw fail(error.message); }
        if (edge.meta && (typeof edge.meta.src !== 'string' || !edge.meta.src || edge.meta.src === 'doc')) throw fail('Invalid derived relation provenance');
        if (i % 1000 === 0) await setImmediate();
    }
    // The graph manifest must include every asserted reference on the rows.
    const triples = new Set(archive.relations.map(edge => `${edge.from}:${edge.p}:${edge.to}`));
    for (const doc of docs.values()) for (const edge of doc.data?.relations || []) {
        if (!triples.has(`${doc.id}:${edge.p}:${edge.to}`)) throw fail(`Missing relationship for document ${doc.id}`);
    }
    return archive;
}

async function checksumMatch(db, record) {
    for (const checksum of record.checksumArray || []) {
        const existing = await db.getByChecksumString(checksum, { parse: true, schema: record.schema });
        if (existing) return existing;
    }
    return null;
}

function mergeRecord(original, existing) {
    const record = clone(original);
    delete record.id;
    delete record.data.relations; // Targets are remapped only after every insert.
    if (!existing) return record;
    return {
        ...record, id: existing.id,
        // Destination curation wins on conflicts; source-only fields survive.
        data: { ...record.data, ...existing.data }, metadata: { ...record.metadata, ...existing.metadata },
        comment: existing.comment || record.comment,
        locations: union(record.locations, existing.locations, location => location.url),
        features: union(record.features, existing.features), timelines: union(record.timelines, existing.timelines),
        checksumArray: union(record.checksumArray, existing.checksumArray),
        createdAt: existing.createdAt < record.createdAt ? existing.createdAt : record.createdAt,
    };
}

/** Import through engine writes, with automation suppressed and IDs remapped. */
export async function importSubtree(db, tree, archive, { parentPath = '/', name = null, report = null } = {}) {
    report?.phase('validating');
    await validateSubtreeArchive(archive);
    if (tree.name === 'backends') throw fail('Import into a virtual tree, not the backends mirror');
    if (tree.type !== archive.source.tree.type) throw fail(`Choose a ${archive.source.tree.type} tree to preserve this subtree's membership semantics`);
    parentPath = subtreePath(parentPath);
    name = name || (archive.nodes[0].name === '/' ? archive.source.tree.name : archive.nodes[0].name);
    if (typeof name !== 'string' || !name.trim() || subtreePath(name) !== `/${name}` || name.includes('/')) throw fail('Choose a single folder name');
    const path = join(parentPath, name);
    const prior = tree.getLayerForPath(path);
    const receipt = prior?.metadata?.subtreeImport;
    if (tree.type !== 'context' && prior && receipt?.archiveId !== archive.id) throw fail(`Destination already exists: ${path}`, 409);
    // Context layers (and their metadata) can appear at several paths. A
    // receipt for /Apps must not skip an import of the same archive at /Edu/Apps.
    if (receipt?.archiveId === archive.id && receipt.status === 'done' && (receipt.path || receipt.result?.path) === path) return receipt.result;
    const parent = tree.getLayerForPath(parentPath);
    if (!parent || parent.type === 'canvas') throw fail('Choose an existing destination folder');
    if (parent.locked || parent.isLocked) throw fail('Destination is locked', 409);

    const existingLayer = (target, type) => {
        const atPath = tree.getLayerForPath(target);
        if (atPath || tree.type !== 'context') return atPath;
        const shared = tree.getLayer(target.split('/').pop(), { type });
        return shared ? tree.getLayerById(shared.id) : null;
    };
    const reusedLayers = new Set();
    const planned = new Map();
    // Check every reused layer before creating paths or writing documents.
    // Shared memberships are additive; existing styling and saved queries win.
    for (const [i, node] of archive.nodes.entries()) {
        const target = node.path ? join(path, node.path) : path;
        const type = node.type === 'canvas' ? 'canvas' : tree.type;
        const segments = target.split('/').filter(Boolean);
        for (let j = 0; j < segments.length; j++) {
            const segmentPath = `/${segments.slice(0, j + 1).join('/')}`;
            const desiredType = j === segments.length - 1 ? type : tree.type;
            const layer = existingLayer(segmentPath, desiredType);
            const actualType = layer?.type || planned.get(segmentPath);
            if (actualType && actualType !== desiredType) throw fail(`Destination layer at ${segmentPath} is ${actualType}, expected ${desiredType}`, 409);
            if (layer?.locked || layer?.isLocked) throw fail(`Destination layer is locked: ${segmentPath}`, 409);
            if (j === segments.length - 1 && layer) reusedLayers.add(layer.id);
        }
        planned.set(target, type);
        if (i % 100 === 0) await setImmediate();
    }
    const result = { path, folders: archive.nodes.length, reusedLayers: reusedLayers.size, documents: archive.documents.length, created: 0, reused: 0, relations: 0, unresolvedRelations: 0 };
    const stamp = async status => {
        const layer = tree.getLayerForPath(path);
        await tree.updateLayer(layer.id, { metadata: { ...layer.metadata, subtreeImport: { archiveId: archive.id, path, source: archive.source, status, ...(status === 'done' ? { result } : {}) } } });
    };
    report?.phase('folders');
    for (const [i, node] of archive.nodes.entries()) {
        const target = node.path ? join(path, node.path) : path;
        const type = node.type === 'canvas' ? 'canvas' : tree.type;
        const reused = existingLayer(target, type);
        const inserted = await tree.insertPath(target, { leafType: type, querySpec: node.querySpec });
        if (inserted?.error) throw fail(inserted.error, 409);
        const layer = tree.getLayerForPath(target);
        if (!reused) {
            const { subtreeImport: _sourceReceipt, ...metadata } = node.metadata || {};
            await tree.updateLayer(layer.id, { label: i === 0 && node.label === node.name ? name : node.label, description: node.description, color: node.color, metadata, ...(node.querySpec ? { querySpec: node.querySpec } : {}) });
        }
        if (i === 0) await stamp('running');
        if (i % 100 === 0) await setImmediate();
    }
    const mapping = new Map();
    report?.phase('documents');
    for (const [i, original] of archive.documents.entries()) {
        const existing = await checksumMatch(db, original);
        const id = await db.put(mergeRecord(original, existing), { context: null, emitEvent: false });
        mapping.set(original.id, id);
        if (existing) result.reused++; else result.created++;
        report?.progress(i + 1, archive.documents.length);
        if (i % 50 === 0) await setImmediate();
    }
    for (const [i, ref] of archive.externalReferences.entries()) {
        if (!ref.schema) continue;
        const existing = await checksumMatch(db, ref);
        if (existing) mapping.set(ref.id, existing.id);
        if (i % 100 === 0) await setImmediate();
    }
    report?.phase('relations');
    const unresolved = new Map();
    const assertions = new Map();
    const external = new Map(archive.externalReferences.map(ref => [ref.id, ref]));
    for (const [i, edge] of archive.relations.entries()) {
        const from = mapping.get(edge.from), to = mapping.get(edge.to);
        if (!to) {
            const ref = external.get(edge.to);
            const list = unresolved.get(from) || [];
            list.push({ ...edge, target: ref, sourceWorkspaceId: archive.source.workspaceId });
            unresolved.set(from, list);
            result.unresolvedRelations++;
        } else if (edge.meta) {
            await db.relate(from, edge.p, to, { inheritMemberships: false, meta: edge.meta });
            result.relations++;
        } else {
            const list = assertions.get(from) || [];
            list.push({ p: edge.p, to });
            assertions.set(from, list);
            result.relations++;
        }
        if (i % 100 === 0) await setImmediate();
    }
    let written = 0;
    for (const id of new Set([...assertions.keys(), ...unresolved.keys()])) {
        const doc = await db.get(id);
        await db.put({ id, data: { ...doc.data, relations: union(doc.data.relations, assertions.get(id), edge => `${edge.p}:${edge.to}`) },
            ...(unresolved.has(id) ? { metadata: { subtreeExternalRelations: union(doc.metadata?.subtreeExternalRelations, unresolved.get(id)) } } : {}),
            checksumArray: doc.checksumArray, updatedAt: doc.updatedAt,
        }, { context: null, emitEvent: false });
        if (++written % 50 === 0) await setImmediate();
    }
    report?.phase('memberships');
    for (const node of archive.nodes) {
        const target = node.path ? join(path, node.path) : path;
        const ids = node.documentIds.map(id => mapping.get(id));
        const selector = tree.type === 'directory' ? { directory: { tree: tree.id, path: target }, context: null } : { context: { tree: tree.id, path: target } };
        // linkMany currently publishes membership events regardless of its
        // emitEvent option. Single links honour it, keeping migration out of
        // storage rules and other document automation.
        for (let i = 0; i < ids.length; i++) {
            await db.link(ids[i], { ...selector, emitEvent: false });
            if (i % 100 === 0) await setImmediate();
        }
    }
    await stamp('done');
    return result;
}
