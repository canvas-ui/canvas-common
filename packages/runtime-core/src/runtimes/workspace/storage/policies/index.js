/** Workspace policy configuration. Byte execution belongs to Stored. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const POLICY_FILE = 'storage-policies.json';
const CONTAINER_DRIVERS = new Set(['file']);
const ON_CONFLICT = new Set(['error', 'rename', 'overwrite']);

// filePath -> { mtimeMs, policies }
const writes = new Map();

function policyFilePath(workspace) {
    return path.join(workspace.configDir, POLICY_FILE);
}

/** 'ctx:/a/b' | 'dir:/a' | '/a' → { tree: 'context'|'directory', path: '/a/b', qualified: 'ctx:/a/b' } */
export function parsePolicyPath(raw) {
    const value = String(raw || '').trim();
    const qualifier = value.match(/^([A-Za-z][\w-]*):(?=\/|$)/);
    const tree = qualifier ? ({ ctx: 'context', context: 'context', dir: 'directory', directory: 'directory' })[qualifier[1]] : 'context';
    if (!tree) throw badRequest(`Policy path must start with ctx:/ or dir:/ (got "${value}")`);
    let p = (qualifier ? value.slice(qualifier[0].length) : value).replace(/\/+$/, '');
    if (!p.startsWith('/')) p = `/${p}`;
    if (p === '/' || p.split('/').some((seg) => seg === '.' || seg === '..') || p.includes('{{')) {
        throw badRequest(`Policy path must name a folder below the tree root (got "${value}")`);
    }
    return { tree, path: p, qualified: `${tree === 'context' ? 'ctx' : 'dir'}:${p}` };
}

/** Remainder of `candidate` below `root` ('' = same path; null = not under). */
export function relativeTo(root, candidate) {
    const base = String(root).replace(/\/+$/, '');
    const p = String(candidate || '').replace(/\/+$/, '') || '/';
    if (p === base) return '';
    if (p.startsWith(`${base}/`)) return p.slice(base.length + 1);
    return null;
}

function badRequest(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

function cleanFolder(value) {
    return String(value ?? '').split('\\').join('/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/** Validate + normalize one policy against the workspace's data backends. */
export function normalizePolicy(input, workspace) {
    if (!input || typeof input !== 'object') throw badRequest('Policy must be an object');
    const id = String(input.id || '').trim();
    if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(id)) throw badRequest(`Policy id "${id}" must be a short slug (letters, digits, . _ -)`);
    const parsed = parsePolicyPath(input.path);
    const kind = input.kind || 'mirror';
    if (!['mirror', 'filing'].includes(kind)) throw badRequest('kind must be mirror or filing');
    const targets = Array.isArray(input.targets) ? input.targets : [];
    if (!targets.length) throw badRequest(`Policy "${id}" needs at least one target`);
    const backends = workspace?.dataBackends || {};
    const normalizedTargets = targets.map((t, index) => {
        const backend = String(t?.backend || '').trim();
        const config = backends[backend];
        if (!config) throw badRequest(`Policy "${id}" target ${index + 1}: unknown backend "${backend}"`);
        if (config.readOnly === true) throw badRequest(`Policy "${id}" target ${index + 1}: backend "${backend}" is read-only`);
        if (config.driver === 'cacache') throw badRequest(`Policy "${id}" target ${index + 1}: the blob store is the staging area, not a target`);
        if (!workspace.backendKeepsPaths(backend)) throw badRequest(`Policy "${id}" target ${index + 1}: backend "${backend}" does not keep folder paths`);
        const folder = cleanFolder(t.folder);
        if (folder.split('/').some((seg) => seg === '.' || seg === '..')) throw badRequest(`Policy "${id}" target ${index + 1}: invalid folder "${t.folder}"`);
        const key = t.key != null && String(t.key).trim() !== '' ? String(t.key).trim() : undefined;
        if (key && key.includes('/')) throw badRequest(`Policy "${id}" target ${index + 1}: key is a file name template, folders go in "folder"`);
        const onConflict = t.onConflict ? String(t.onConflict) : 'error';
        if (!ON_CONFLICT.has(onConflict)) throw badRequest(`Policy "${id}" target ${index + 1}: onConflict must be error, rename or overwrite`);
        const canFolders = CONTAINER_DRIVERS.has(config.driver || 'file');
        const cap = workspace.storageOperations?.capabilities(backend);
        if (cap && !cap.create) throw badRequest(`Backend "${backend}" cannot safely create replicas`);
        if (kind === 'mirror' && !(cap ? cap.retire : config.driver === 'file')) throw badRequest(`Backend "${backend}" does not support recoverable mirroring; use a filing policy`);
        if (t.recreateDirectories && !canFolders) throw badRequest(`Backend "${backend}" cannot safely mirror directories`);
        if (onConflict === 'overwrite' && !(cap ? cap.overwrite : config.driver === 'file')) throw badRequest(`Backend "${backend}" does not support recoverable overwrite`);
        const templated = Boolean(key) || folder.includes('{{');
        if (kind === 'mirror' && templated) throw badRequest('Templates require a separate filing policy');
        return {
            backend,
            folder,
            recursive: t.recursive !== false,
            // Mirroring folders needs a backend with real directories; a
            // templated (filing) target has no stable folder to mirror.
            recreateDirectories: t.recreateDirectories === true && canFolders && !templated,
            ...(key ? { key } : {}),
            onConflict,
        };
    });
    const filter = {};
    if (input.filter && typeof input.filter === 'object') {
        if (input.filter.schema) filter.schema = String(input.filter.schema).trim();
        if (input.filter.mime) filter.mime = String(input.filter.mime).trim();
        if (input.filter.filename) filter.filename = String(input.filter.filename).trim();
    }
    return {
        id,
        kind,
        enabled: input.enabled !== false,
        ...(input.description ? { description: String(input.description).slice(0, 500) } : {}),
        path: parsed.qualified,
        recursive: input.recursive !== false,
        ...(Object.keys(filter).length ? { filter } : {}),
        targets: normalizedTargets,
    };
}

const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex');
export function readPolicyConfig(workspace) {
    let bytes;
    try { bytes = fs.readFileSync(policyFilePath(workspace), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; bytes = ''; }
    const parsed = bytes ? JSON.parse(bytes) : { policies: [] };
    const policies = Array.isArray(parsed) ? parsed : parsed.policies;
    if (!Array.isArray(policies)) throw new Error('Invalid storage-policies.json: policies must be an array');
    return { policies, revision: revisionOf(bytes) };
}
export function readPoliciesSync(workspace) { return readPolicyConfig(workspace).policies; }

export async function writePolicies(workspace, list, expectedRevision) {
    const file = policyFilePath(workspace);
    const task = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
        if (expectedRevision == null) throw Object.assign(new Error('Policy revision is required; reload before saving'), { statusCode: 428 });
        if (readPolicyConfig(workspace).revision !== expectedRevision) throw Object.assign(new Error('Policies changed; reload before saving'), { statusCode: 409 });
        if (!Array.isArray(list)) throw badRequest('policies must be an array');
        const policies = list.map(p => normalizePolicy(p, workspace));
        if (new Set(policies.map(p => p.id)).size !== policies.length) throw badRequest('Duplicate policy id');
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        const handle = await fs.promises.open(tmp, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify({ policies }, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        try {
            // Also detect edits made by an external config editor while writing.
            if (readPolicyConfig(workspace).revision !== expectedRevision) throw Object.assign(new Error('Policies changed; reload before saving'), { statusCode: 409 });
            await fs.promises.rename(tmp, file);
            const dir = await fs.promises.open(path.dirname(file), 'r');
            try { await dir.sync(); } finally { await dir.close(); }
        } finally { await fs.promises.rm(tmp, { force: true }); }
        return policies;
    });
    writes.set(file, task);
    try { return await task; } finally { if (writes.get(file) === task) writes.delete(file); }
}

/** The local content-addressed staging store every upload lands in first. */
export function blobBackendName(workspace) {
    const backends = workspace?.dataBackends || {};
    if (backends['workspace:data']?.driver === 'cacache') return 'workspace:data';
    return Object.keys(backends).find((name) => backends[name]?.driver === 'cacache') || null;
}

