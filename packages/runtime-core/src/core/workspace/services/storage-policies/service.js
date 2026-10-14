import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { readPolicyConfig, normalizePolicy, parsePolicyPath, relativeTo, blobBackendName } from './index.js';
import { transferFilename, joinKey } from '../hook/key-utils.js';
import { expandKeyTemplate } from '../hook/rules.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpointKey = r => JSON.stringify([r.backend, r.key]);
const docOwner = id => `workspace-document:${id}`;
const glob = (pattern, value) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(value || '');
const fault = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

/** Resolves virtual policy intent into exact byte plans. The durable document
 * database is desired state; Stored owns execution and receipts. A complete
 * read is required before any removal. Events reduce latency; startup and
 * periodic passes recover missing events without depending on their ordering.
 */
export default class StoragePolicyService {
    #workspace; #stored; #state; #logger; #timer; #scheduled; #running; #stopped = false; #listener;
    #audited = new Map();
    #background = null;
    #dirty = false;
    #logicalContext = new AsyncLocalStorage();
    #logicalQueue = Promise.resolve();
    #status = { state: 'idle', lastRun: null, error: null };
    constructor({ workspace, stored, state, logger }) {
        this.#workspace = workspace; this.#stored = stored; this.#state = state; this.#logger = logger;
        for (const name of ['reconcile', 'directoryMove', 'removeFromBackend']) {
            const action = this[name].bind(this);
            this[name] = (...args) => {
                if (this.#stopped && !this.#logicalContext.getStore()?.active) return Promise.reject(fault('STOPPED', 'Storage policy service is stopping'));
                if (this.#logicalContext.getStore()?.active) return action(...args);
                const next = this.#logicalQueue.catch(() => {}).then(() => {
                    const scope = { active: true };
                    return this.#logicalContext.run(scope, async () => { try { return await action(...args); } finally { scope.active = false; } });
                });
                this.#logicalQueue = next; return next;
            };
        }
    }
    start() {
        const self = this;
        this.#listener = function () { if (/^(document\.|tree\.path\.|backend\.changed)/.test(this.event || '')) self.schedule(); };
        this.#workspace.on('**', this.#listener);
        this.#timer = setInterval(() => this.schedule(), 30000); this.#timer.unref?.();
        this.schedule();
    }
    schedule() {
        if (this.#stopped) return;
        this.#dirty = true;
        if (this.#scheduled || this.#background) return;
        this.#scheduled = setTimeout(() => {
            this.#scheduled = null;
            this.#dirty = false;
            // One queued/running background pass, plus one dirty bit. A long
            // rescan must not enqueue a full-library pass every 100 ms ahead
            // of interactive folder operations and shutdown.
            this.#background = this.#logicalContext.exit(() => this.reconcile())
                .catch(error => this.#logger.warn({ error: error.message }, 'Storage policy reconciliation blocked'))
                .finally(() => {
                    this.#background = null;
                    if (this.#dirty) this.schedule();
                });
        }, 100);
        this.#scheduled.unref?.();
    }
    async stop() {
        this.#stopped = true; clearTimeout(this.#scheduled); clearInterval(this.#timer);
        this.#workspace.off('**', this.#listener);
        await this.#running?.catch(() => {});
        await this.#logicalQueue.catch(() => {});
    }
    status() {
        const operations = this.#stored.replicas.list({ limit: 1000, active: true });
        const state = this.#status.error || operations.operations.some(o => o.state === 'blocked') ? 'blocked'
            : operations.operations.length ? 'pending' : 'idle';
        return { ...this.#status, state, operations };
    }
    async reconcile({ dryRun = false } = {}) {
        if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
        if (this.#running) { await this.#running; return this.reconcile({ dryRun }); }
        this.#running = this.#reconcile(dryRun);
        try { return await this.#running; }
        catch (error) { this.#status = { state: 'blocked', lastRun: Date.now(), error: { code: error.code || 'POLICY_ERROR', message: error.message } }; throw error; }
        finally { this.#running = null; }
    }
    async #reconcile(dryRun) {
        // list({ owner }) in older Stored releases decodes the whole receipt
        // ledger per document. Never silently restore that fallback.
        if (typeof this.#stored.replicas?.latest !== 'function') {
            throw fault('STORED_UPGRADE_REQUIRED', 'Storage-policy reconciliation requires the indexed replica lookup in canvas-stored 1.13.0 or newer; update the installed runtime dependency');
        }
        const ws = this.#workspace;
        const config = readPolicyConfig(ws);
        // Invalid or unreadable configuration blocks the pass. It is NEVER an
        // empty desired-state set (which would retire every managed replica).
        const policies = config.policies.map(p => normalizePolicy(p, ws));
        if (!dryRun) {
            const removal = this.#state.get('storage-policies:remove-intent:v1');
            if (removal) await this.#applyRemovalIntent(removal);
            await this.#recoverDirectoryMove(); await this.#consumeChanges(policies); }
        if (!policies.length && !this.#stored.replicas.owners('workspace-').length && !this.#stored.replicas.hasIngress) return { processed: 0, matched: 0, folders: 0, queued: 0, failed: 0, nextOffset: null, dryRun };
        const docs = new Map();
        for (let offset = 0;; offset += 500) {
            if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
            await yieldToIO();
            const page = await ws.list({ limit: 500, offset, order: 'asc', applyCanvasQuerySpec: false });
            if (page?.error) throw new Error(String(page.error));
            const rows = Array.isArray(page) ? page : page?.data;
            if (!Array.isArray(rows)) throw new Error('Incomplete document listing');
            for (const doc of rows) docs.set(doc.id, doc);
            if (rows.length < 500) break;
        }
        const plans = [];
        let processed = 0;
        for (const doc of docs.values()) {
            if (++processed % 32 === 0) await yieldToIO();
            if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
            if (!String(doc.schema || '').startsWith('data/schema/file')) continue;
            if (ws.isRemovalHeld?.(doc.id)) continue;
            if (!dryRun) await this.#projectUnmanagedFile(doc, policies);
            const plan = await this.#documentPlan(doc, policies, config.revision);
            if (plan) plans.push(plan);
        }
        // Deleted database rows are not permission to destroy remaining bytes.
        // The orphan/trash workflow owns those records; expose them for review.
        const missing = this.#stored.replicas.owners('workspace-document:').filter(o => !docs.has(Number(o.owner.split(':')[1])) && o.replicas.length);
        if (missing.length) throw fault('DOCUMENT_MISSING', `Storage owners have missing documents: ${missing.map(o => o.owner).join(', ')}`);
        const folders = await this.#folderPlans(policies, config.revision);
        if (readPolicyConfig(ws).revision !== config.revision) throw fault('POLICY_CHANGED', 'Policy configuration changed during planning');
        let queued = 0;
        if (!dryRun) {
            const depth = plan => Math.max(0, ...(this.#stored.replicas.owner(plan.owner)?.replicas || []).map(r => r.key.split('/').length));
            const ordered = [...folders.filter(p => p.replicas.length), ...plans,
                ...folders.filter(p => !p.replicas.length).sort((a, b) => depth(b) - depth(a))];
            // Validate the WHOLE pass before handing any of it to the executor.
            let validated = 0;
            for (const plan of ordered) {
                if (++validated % 32 === 0) await yieldToIO();
                if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
                if (!plan.finishIngress) this.#stored.replicas.validate(plan);
            }
            for (const plan of ordered) {
                if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
                if (queued % 32 === 0) await yieldToIO();
                if (plan.finishIngress) await this.#stored.replicas.finishUnmirroredIngress(plan.finishIngress);
                else if (plan.supersedes) await this.#stored.replicas.supersede(plan.supersedes, plan);
                else this.#stored.replicas.submit(plan);
                queued++;
            }
        }
        this.#status = { state: 'idle', lastRun: Date.now(), error: null };
        if (!dryRun) {
            const removal = this.#state.get('storage-policies:remove-intent:v1');
            if (removal?.applied && removal.documents.every(d => this.#latest(docOwner(d.id))?.state === 'complete')
                && !this.#stored.replicas.owners('workspace-document:').some(o => o.replicas.some(r => r.mirror !== false && r.backend === removal.backend
                    && (r.key === removal.key || (removal.directory && r.key.startsWith(`${removal.key}/`)))))) {
                await this.#state.put('storage-policies:remove-intent:v1', null);
            }
        }
        return { processed: docs.size, matched: plans.length, folders: folders.length, queued, failed: 0, nextOffset: null, dryRun };
    }
    #latest(owner) {
        return this.#stored.replicas.latest(owner);
    }
    async #audit(owner, operationId) {
        const previous = this.#audited.get(owner);
        if (previous?.operationId === operationId && Date.now() - previous.at < 15 * 60_000) return [];
        const differences = await this.#stored.replicas.audit(owner);
        if (!differences.length) this.#audited.set(owner, { operationId, at: Date.now() });
        return differences;
    }
    async #documentPlan(doc, policies, revision) {
        const ws = this.#workspace, owner = docOwner(doc.id), previous = this.#stored.replicas.owner(owner), latest = this.#latest(owner);
        const placements = await ws.listDocumentPlacements(doc.id); // must propagate lookup errors
        const endpoints = await ws.documentByteEndpoints(doc);
        const blob = blobBackendName(ws);
        const source = endpoints.find(e => e.backend === blob) || endpoints[0];
        const sha = (doc.checksumArray || []).map(s => String(s).match(/^sha256[/:]([a-f0-9]{64})$/i)?.[1]).find(Boolean);
        if (!sha) { if (previous) throw fault('CONTENT_ID_MISSING', `No content identity for document ${doc.id}`); return null; }
        const ingress = this.#stored.replicas.sourceFor(owner, `sha256:${sha}`, endpoints);
        const filename = transferFilename(doc, { sourceKey: source?.key, sourceUrl: source?.url });
        const replicas = [];
        for (const policy of policies.filter(p => p.enabled)) {
            const parsed = parsePolicyPath(policy.path);
            const tree = parsed.tree === 'context' ? ws.getContextTree() : ws.getDirectoryTree();
            const filter = policy.filter || {};
            if (filter.schema && !String(doc.schema).startsWith(`data/schema/${filter.schema.replace(/^data\/schema\//, '')}`)) continue;
            if (filter.filename && !glob(filter.filename, filename)) continue;
            const mime = doc.metadata?.contentType || doc.locations?.find(l => l.metadata?.contentType)?.metadata.contentType || '';
            if (filter.mime && !glob(filter.mime, mime)) continue;
            for (const placement of placements.filter(p => p.treeId === tree.id)) for (const virtualPath of placement.paths.filter(p =>
                placement.type !== 'context' || !placement.paths.some(child => child.startsWith(`${p === '/' ? '' : p}/`) && child !== p))) {
                const rel = relativeTo(parsed.path, virtualPath);
                if (rel == null || (!policy.recursive && rel !== '')) continue;
                for (const target of policy.targets) {
                    const scope = { doc: { ...doc, created: doc.created || doc.createdAt || '1970-01-01', metadata: { ...doc.metadata, filename } }, sourceKey: filename };
                    const key = joinKey(expandKeyTemplate(target.folder, scope), target.recursive ? rel : '', target.key ? expandKeyTemplate(target.key, scope) : filename);
                    if (key.includes('{{')) throw fault('INVALID_TEMPLATE', `Unresolved template: ${key}`);
                    replicas.push({ backend: target.backend, key, mirror: policy.kind === 'mirror', onConflict: target.onConflict,
                        // Filing an already indexed source into an explicit
                        // mirror grants ownership of that known location.
                        // Equal-but-unrelated destination files are not adopted.
                        adopt: policy.kind === 'mirror' && endpoints.some(e => e.backend === target.backend && e.key === key),
                        bindings: [{ policy: policy.id, treeId: tree.id, virtualPath, root: target.folder, virtualRoot: parsed.path, recursive: target.recursive }] });
                }
            }
        }
        // Disabling/deleting a policy stops managing its copies. It does not
        // grant permission to delete previously stored user data.
        const preserve = (previous?.replicas || []).filter(old => old.bindings?.some(b => !policies.some(p => p.id === b.policy && p.enabled)))
            .map(({ backend, key }) => ({ backend, key }));
        const combined = new Map();
        for (const r of replicas) {
            const prior = combined.get(endpointKey(r));
            if (prior && (prior.mirror !== r.mirror || prior.onConflict !== r.onConflict)) throw fault('CONFLICTING_POLICIES', `Policies disagree at ${r.backend}:${r.key}`);
            if (prior) prior.bindings.push(...r.bindings); else combined.set(endpointKey(r), r);
        }
        const desired = [...combined.values()];
        if (!desired.length && !previous?.replicas.length && !latest) return ingress ? { finishIngress: ingress } : null;
        // Preserve a durable byte location when the last mirrored placement is
        // removed. Orphan retention is a separate, explicit lifecycle.
        if (!desired.length) {
            if (!blob) throw fault('NO_STAGING_BACKEND', 'Cannot safely leave a mirror without a staging backend');
            desired.push({ backend: blob, key: `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`, mirror: false });
        }
        const desiredHash = hash([revision, `sha256:${sha}`, desired, preserve]);
        if (latest?.plan.desiredHash === desiredHash && (!ingress || (latest.plan.ingressSeq || 0) >= ingress.seq)) {
            if (latest.state === 'complete') {
                const differences = await this.#audit(owner, latest.id);
                if (differences.length) throw fault('REPLICA_DRIFT', `Replica verification failed: ${JSON.stringify(differences)}`);
            }
            return null;
        }
        // Never interleave a new desired version with an unresolved older one.
        const supersedes = latest && latest.state !== 'complete' && latest.plan.contentId !== `sha256:${sha}` ? latest.id : null;
        if (latest && latest.state !== 'complete' && !supersedes) throw fault('PREVIOUS_OPERATION_PENDING', `${owner} has an unfinished operation ${latest.id}`);
        if (!source && !ingress) throw fault('NO_SOURCE', `Document ${doc.id} has no readable byte location`);
        const release = desired.some(r => r.backend === blob) ? [] : endpoints.filter(e => e.backend === blob).map(e => ({ backend: e.backend, key: e.key, contentId: `sha256:${sha}` }));
        if (supersedes) for (const old of latest.plan.release || []) {
            if (!desired.some(r => endpointKey(r) === endpointKey(old)) && !release.some(r => endpointKey(r) === endpointKey(old))) {
                release.push({ ...old, contentId: old.contentId || latest.plan.contentId });
            }
        }
        return { id: `policy:${randomUUID()}`, owner, contentId: `sha256:${sha}`, desiredHash, ...(supersedes ? { supersedes } : {}),
            ...(ingress ? { sourceCacheKey: ingress.cacheKey, ingressSeq: ingress.seq, ingressSource: { backend: ingress.backend, key: ingress.key } } : {}),
            ...(source ? { source: { backend: source.backend, key: source.key } } : {}), replicas: desired, preserve,
            release };
    }
    async #projectUnmanagedFile(doc, policies) {
        const owner = this.#stored.replicas.owner(docOwner(doc.id));
        for (const endpoint of await this.#workspace.documentByteEndpoints(doc)) {
            if (owner?.replicas.some(r => endpointKey(r) === endpointKey(endpoint))) continue;
            const filename = path.posix.basename(endpoint.key);
            for (const policy of policies.filter(p => p.enabled && p.kind === 'mirror')) {
                const f = policy.filter || {};
                if (f.schema && f.schema !== 'file' && !String(doc.schema).startsWith(`data/schema/${f.schema.replace(/^data\/schema\//, '')}`)) continue;
                if (f.filename && !glob(f.filename, filename)) continue;
                const mime = doc.metadata?.contentType || doc.locations?.find(l => l.metadata?.contentType)?.metadata.contentType || '';
                if (f.mime && !glob(f.mime, mime)) continue;
                for (const target of policy.targets.filter(t => t.backend === endpoint.backend)) {
                    const relative = relativeTo(target.folder, endpoint.key);
                    if (relative == null || !relative) continue;
                    const parent = path.posix.dirname(relative);
                    if (parent !== '.' && (!target.recursive || !policy.recursive)) continue;
                    if (!target.recursive && parent !== '.') continue;
                    const parsed = parsePolicyPath(policy.path);
                    const tree = parsed.tree === 'context' ? this.#workspace.getContextTree() : this.#workspace.getDirectoryTree();
                    const destination = parsed.path + (parent === '.' ? '' : `/${parent}`);
                    const placements = await this.#workspace.listDocumentPlacements(doc.id);
                    if (placements.some(p => p.treeId === tree.id && p.paths.includes(destination))) continue;
                    await this.#workspace.link(doc.id, tree.type === 'context'
                        ? { context: { tree: tree.id, path: destination }, emitEvent: false }
                        : { context: null, directory: { tree: tree.id, path: destination }, emitEvent: false });
                }
            }
        }
    }
    async #folderPlans(policies, revision) {
        const wanted = new Map();
        let visited = 0;
        for (const policy of policies.filter(p => p.enabled && p.kind === 'mirror')) {
            const parsed = parsePolicyPath(policy.path);
            const tree = parsed.tree === 'context' ? this.#workspace.getContextTree() : this.#workspace.getDirectoryTree();
            if (!tree.pathExists(parsed.path)) continue;
            const walk = async virtualPath => {
                if (++visited % 32 === 0) await yieldToIO();
                if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
                const owner = `workspace-directory:${hash([tree.id, virtualPath])}`;
                const replicas = wanted.get(owner) || [];
                for (const target of policy.targets.filter(t => t.recreateDirectories)) {
                    const rel = relativeTo(parsed.path, virtualPath);
                    const key = joinKey(target.folder, target.recursive ? rel : '');
                    if (key) replicas.push({ backend: target.backend, key, kind: 'directory', bindings: [{ policy: policy.id, treeId: tree.id, virtualPath }] });
                }
                if (replicas.length) wanted.set(owner, replicas);
                if (policy.recursive) for (const name of await tree.listDirectories(virtualPath)) await walk(`${virtualPath}/${name}`);
            };
            await walk(parsed.path);
        }
        for (const old of this.#stored.replicas.owners('workspace-directory:')) if (!wanted.has(old.owner)) {
            wanted.set(old.owner, old.replicas.filter(r => r.bindings?.some(b => !policies.some(p => p.id === b.policy && p.enabled))).map(r => ({ ...r, mirror: false })));
        }
        const plans = [];
        for (const [owner, replicas] of wanted) {
            if (++visited % 32 === 0) await yieldToIO();
            if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
            const desiredHash = hash([revision, replicas]); const latest = this.#latest(owner);
            if (latest?.plan.desiredHash === desiredHash) {
                if (latest.state === 'complete' && (await this.#audit(owner, latest.id)).length) throw fault('DIRECTORY_DRIFT', 'A mirrored directory changed outside the operation journal');
                continue;
            }
            if (latest && latest.state !== 'complete') throw fault('PREVIOUS_OPERATION_PENDING', `${owner} has an unfinished operation ${latest.id}`);
            plans.push({ id: `policy:${randomUUID()}`, owner, replicas, desiredHash });
        }
        return plans;
    }
    async removeFromBackend({ backend, key, directory = false }) {
        if (this.#running) await this.#running;
        await this.#stored.replicas.drain();
        this.#stored.replicas.assertIdleEndpoint(backend, key, { directory });
        const config = readPolicyConfig(this.#workspace);
        const active = new Set(config.policies.filter(p => p.enabled !== false).map(p => p.id));
        const matches = this.#stored.replicas.owners('workspace-document:').flatMap(owner => owner.replicas
            .filter(r => r.mirror && r.backend === backend && (directory ? r.key.startsWith(`${key}/`) : r.key === key))
            .flatMap(replica => (replica.bindings || []).filter(b => active.has(b.policy)).map(binding => ({ owner, replica, binding }))));
        const directories = directory ? this.#stored.replicas.owners('workspace-directory:').flatMap(owner => owner.replicas
            .filter(r => r.backend === backend && (r.key === key || r.key.startsWith(`${key}/`)))
            .flatMap(r => (r.bindings || []).filter(b => active.has(b.policy)))) : [];
        if (!matches.length && !directories.length) return null;
        const intentKey = 'storage-policies:remove-intent:v1';
        let intent = this.#state.get(intentKey);
        if (intent && (intent.backend !== backend || intent.key !== key)) throw fault('REMOVE_PENDING', 'A previous mirrored removal is unfinished');
        if (!intent) {
            const documents = new Map();
            for (const { owner, replica, binding } of matches) {
                const id = Number(owner.owner.split(':')[1]);
                if (!documents.has(id)) documents.set(id, { id, placements: await this.#workspace.listDocumentPlacements(id), remove: [] });
                documents.get(id).remove.push(binding);
                if (!replica.managed) await this.#stored.replicas.adopt(owner.owner, replica);
            }
            intent = { backend, key, directory, documents: [...documents.values()], directories };
            await this.#state.put(intentKey, intent);
        }
        await this.#applyRemovalIntent(intent);
        await this.reconcile();
        await this.#stored.replicas.drain();
        for (const document of intent.documents) {
            const latest = this.#latest(docOwner(document.id));
            if (latest?.state !== 'complete') throw fault('REMOVE_PENDING', `Removal is waiting for ${latest?.id || 'storage planning'}`);
        }
        await this.#state.put(intentKey, null);
        this.schedule();
        return { ok: true, state: 'complete', id: matches[0]?.owner.contentId, seq: this.#stored.head() };
    }
    async #applyRemovalIntent(intent) {
        if (intent.applied) return;
        for (const document of intent.documents) {
            for (const binding of document.remove) {
                const tree = this.#workspace.getTree(binding.treeId);
                const selector = tree.type === 'context' ? { context: { tree: tree.id, path: binding.virtualPath } }
                    : { context: null, directory: { tree: tree.id, path: binding.virtualPath } };
                await this.#workspace.unlink(document.id, selector, { recursive: tree.type === 'context', emitEvent: false });
            }
            for (const placement of document.placements) {
                if (placement.type !== 'context') continue;
                const paths = placement.paths.filter(p => p !== '/' && !placement.paths.some(child => child.startsWith(`${p}/`))
                    && !document.remove.some(b => b.treeId === placement.treeId && b.virtualPath === p));
                for (const p of paths) await this.#workspace.link(document.id, { context: { tree: placement.treeId, path: p }, emitEvent: false });
            }
        }
        for (const binding of [...intent.directories].sort((a, b) => b.virtualPath.length - a.virtualPath.length)) {
            const tree = this.#workspace.getTree(binding.treeId);
            if (tree.pathExists(binding.virtualPath)) {
                const result = await tree.removePath(binding.virtualPath, true);
                if (result?.error) throw new Error(result.error);
            }
        }
        intent.applied = true;
        await this.#state.put('storage-policies:remove-intent:v1', intent);
    }
    async directoryMove(phase, input) {
        if (phase === 'create') return this.#createDirectory(input);
        const key = 'storage-policies:directory-intent:v1';
        if (phase === 'complete') {
            if (!input.result?.ok) { await this.#state.put(key, null); return; }
            await this.#recoverDirectoryMove();
            this.schedule(); return;
        }
        if (this.#running) await this.#running;
        await this.#stored.replicas.drain();
        this.#stored.replicas.assertIdleEndpoint(input.backend, input.from, { directory: true });
        const pending = this.#state.get(key);
        if (pending && pending.operationId !== input.operationId) throw fault('DIRECTORY_OPERATION_PENDING', 'Another mirrored directory operation is unfinished');
        if (pending) return pending;
        const policies = readPolicyConfig(this.#workspace).policies.map(p => normalizePolicy(p, this.#workspace));
        const moves = [];
        for (const policy of policies.filter(p => p.enabled && p.kind === 'mirror')) for (const target of policy.targets) {
            if (target.backend !== input.backend) continue;
            const fromRel = relativeTo(target.folder, input.from), toRel = relativeTo(target.folder, input.to);
            if (fromRel == null && toRel == null) continue;
            if (!fromRel || !toRel || !target.recursive) throw fault('UNSUPPORTED_DIRECTORY_MOVE', 'Move crosses a mirror root or a flat mapping; change the virtual placement first');
            const parsed = parsePolicyPath(policy.path);
            const tree = parsed.tree === 'context' ? this.#workspace.getContextTree() : this.#workspace.getDirectoryTree();
            const from = `${parsed.path}/${fromRel}`, to = `${parsed.path}/${toRel}`;
            if (!tree.pathExists(from)) continue;
            if (tree.pathExists(to)) throw fault('VIRTUAL_TARGET_EXISTS', `Virtual destination exists: ${to}`);
            if (!moves.some(m => m.treeId === tree.id && m.from === from && m.to === to)) moves.push({ treeId: tree.id, from, to });
        }
        if (!moves.length) return null;
        const intent = { ...input, moves };
        // Persist the exact user intent before any physical rename. Restart
        // repeats the same Stored receipt and the same logical projection.
        await this.#state.put(key, intent);
        return intent;
    }
    async #createDirectory(input) {
        if (this.#running) await this.#running;
        const key = 'storage-policies:directory-intent:v1';
        const pending = this.#state.get(key);
        if (pending) {
            if (pending.kind !== 'create' || pending.backend !== input.backend || pending.key !== input.key) throw fault('DIRECTORY_OPERATION_PENDING', 'Another mirrored directory operation is unfinished');
            await this.#recoverDirectoryMove(); this.schedule(); return { ok: true, key: input.key };
        }
        const policies = readPolicyConfig(this.#workspace).policies.map(p => normalizePolicy(p, this.#workspace));
        const paths = new Map();
        for (const policy of policies.filter(p => p.enabled && p.kind === 'mirror')) for (const target of policy.targets) {
            if (target.backend !== input.backend) continue;
            const rel = relativeTo(target.folder, input.key);
            if (rel == null || (rel && !policy.recursive)) continue;
            if (rel && !target.recursive) throw fault('AMBIGUOUS_BACKEND_CHANGE', 'A flat mirror cannot infer a virtual folder from a backend subdirectory');
            const parsed = parsePolicyPath(policy.path);
            const tree = parsed.tree === 'context' ? this.#workspace.getContextTree() : this.#workspace.getDirectoryTree();
            const virtualPath = parsed.path + (rel ? `/${rel}` : '');
            paths.set(`${tree.id}:${virtualPath}`, { treeId: tree.id, path: virtualPath });
        }
        if (!paths.size) return null;
        await this.#state.put(key, { ...input, kind: 'create', paths: [...paths.values()] });
        await this.#recoverDirectoryMove(); this.schedule();
        return { ok: true, key: input.key };
    }
    async #recoverDirectoryMove() {
        const key = 'storage-policies:directory-intent:v1';
        const intent = this.#state.get(key);
        if (!intent) return;
        if (intent.kind === 'create') {
            await this.#stored.ensureDirectory(intent.backend, intent.key);
            for (const item of intent.paths) await this.#workspace.getTree(item.treeId).insertPath(item.path);
            await this.#state.put(key, null);
            return;
        }
        const result = await this.#stored.renameDirectory(intent.backend, intent.from, intent.to,
            { operationId: intent.operationId, origin: `workspace-directory:${intent.operationId}` });
        if (!result.ok) throw fault('DIRECTORY_MOVE_BLOCKED', `Mirrored folder move failed: ${result.reason}`);
        await this.#stored.replicas.recordRelocation(intent.backend, intent.from, intent.to, { directory: true });
        for (const move of intent.moves) {
            const tree = this.#workspace.getTree(move.treeId);
            if (!tree.pathExists(move.from)) {
                if (!tree.pathExists(move.to)) throw fault('VIRTUAL_PATH_MISSING', 'Both virtual paths disappeared during a directory move');
                continue;
            }
            if (tree.type === 'directory') {
                const result = await tree.movePath(move.from, move.to, true);
                if (result?.error) throw new Error(result.error);
                continue;
            }
            // Context nodes share layer names. Renaming a layer would rename
            // unrelated branches too. Rebuild only the selected path, then
            // refile its documents, retaining shared labels elsewhere.
            const paths = [];
            const walk = async p => { paths.push(p); for (const name of await tree.listDirectories(p)) await walk(`${p}/${name}`); };
            await walk(move.from);
            for (const p of paths) await tree.insertPath(`${move.to}${p.slice(move.from.length)}`);
            for (let offset = 0;; offset += 500) {
                const docs = await this.#workspace.list({ limit: 500, offset, order: 'asc', applyCanvasQuerySpec: false });
                if (!Array.isArray(docs)) throw new Error('Incomplete document enumeration during directory move');
                for (const doc of docs) {
                    const placement = (await this.#workspace.listDocumentPlacements(doc.id)).find(p => p.treeId === tree.id);
                    const old = (placement?.paths || []).filter(p => relativeTo(move.from, p) != null);
                    if (!old.length) continue;
                    // Removing only the renamed segment avoids unlinking shared
                    // context ancestors and labels in other placements.
                    for (const p of old) await this.#workspace.link(doc.id, { context: { tree: tree.id, path: `${move.to}${p.slice(move.from.length)}` }, emitEvent: false });
                    await this.#workspace.unlink(doc.id, { context: { tree: tree.id, path: move.from } }, { emitEvent: false });
                }
                if (docs.length < 500) break;
            }
            const removed = await tree.removePath(move.from, true);
            if (removed?.error) throw new Error(removed.error);
        }
        await this.#state.put(key, null);
    }
    async #consumeChanges(policies) {
        const key = 'storage-policies:physical-cursor:v1';
        let cursor = this.#state.get(key)?.seq;
        if (cursor == null) {
            // No managed byte plans existed before this service started.
            cursor = this.#stored.head(); await this.#state.put(key, { seq: cursor });
        }
        for (;;) {
            const page = this.#stored.changes({ since: cursor, limit: 1000 });
            if (page.cursorTooOld) throw fault('OBSERVATION_GAP', 'Physical change history has a gap; automatic removal is paused');
            const consumed = new Set();
            for (let index = 0; index < page.changes.length; index++) {
                if (index % 32 === 0) await yieldToIO();
                if (this.#stopped) throw fault('STOPPED', 'Storage policy service is stopping');
                const change = page.changes[index];
                let effective = change;
                if (!consumed.has(change.seq) && change.op === 'rename') {
                    // A->B->C can occur before projection. Verify the final
                    // location instead of requiring the transient B to exist.
                    for (const later of page.changes.slice(index + 1)) {
                        if (later.backend !== change.backend) continue;
                        if (later.op === 'rename' && later.from === effective.key && later.id === change.id && later.origin === change.origin) {
                            effective = { ...effective, key: later.key }; consumed.add(later.seq);
                        } else if (later.key === effective.key) break;
                    }
                }
                if (!consumed.has(change.seq) && !/^(replica:|workspace-directory:)/.test(change.origin || '')) await this.#physicalChange(effective, policies);
                await this.#state.put(key, { seq: change.seq }); cursor = change.seq;
            }
            if (cursor >= page.head || !page.changes.length) break;
        }
    }
    async #physicalChange(change, policies) {
        // Explicit API/FUSE renames and confidently paired filesystem renames
        // carry a source identity in Stored's durable change feed.
        if (!['rename', 'delete', 'put'].includes(change.op)) return;
        const owners = this.#stored.replicas.ownersAt
            ? this.#stored.replicas.ownersAt(change.backend, change.from || change.key, 'workspace-document:')
            : this.#stored.replicas.owners('workspace-document:');
        for (const owner of owners) for (const replica of owner.replicas) {
            if (!replica.mirror || replica.backend !== change.backend || replica.key !== (change.from || change.key)) continue;
            if (change.op === 'put' && change.id === replica.contentId) continue;
            const docId = Number(owner.owner.split(':')[1]);
            if (this.#workspace.isRemovalHeld?.(docId)) continue;
            if (change.op === 'put') {
                const doc = await this.#workspace.get(docId);
                const current = await this.#stored.stat(`${change.backend}:${change.key}`);
                if (!current) continue; // a later rename/delete observation owns the missing key
                if (!doc?.checksumArray?.includes(current.id.replace('sha256:', 'sha256/'))) {
                    throw fault('CONTENT_PROJECTION_PENDING', `Content change at ${change.backend}:${change.key} has not been projected onto document ${docId}`);
                }
                // Indexing preserves the document ID and advances its byte
                // identity. Planning below stages that version, then updates
                // replicas conditionally against the last verified version.
                continue;
            }
            for (const binding of replica.bindings || []) {
                const policy = policies.find(p => p.id === binding.policy && p.enabled);
                if (!policy) continue;
                // A flat mapping cannot uniquely reconstruct a virtual move.
                if (!binding.recursive) throw fault('AMBIGUOUS_BACKEND_CHANGE', 'A flat target changed; resolve the virtual placement explicitly');
                const tree = this.#workspace.getTree(binding.treeId);
                const selector = p => tree.type === 'context' ? { context: { tree: tree.id, path: p } } : { context: null, directory: { tree: tree.id, path: p } };
                if (change.op === 'rename') {
                    const relative = relativeTo(binding.root, change.key);
                    if (relative == null) throw fault('BACKEND_LEFT_MIRROR', 'Backend move left its mirror root; explicit virtual destination is required');
                    const dirname = path.posix.dirname(relative);
                    const destination = `${binding.virtualRoot}${dirname === '.' ? '' : `/${dirname}`}`;
                    // Idempotent link-before-unlink: replay cannot orphan the doc.
                    await this.#workspace.link(docId, { ...selector(destination), emitEvent: false });
                    if (destination !== binding.virtualPath) await this.#workspace.unlink(docId, selector(binding.virtualPath), { emitEvent: false });
                    const doc = await this.#workspace.get(docId);
                    await this.#workspace.put({ id: docId, metadata: { ...doc.metadata, filename: path.posix.basename(change.key) } }, { context: null });
                } else {
                    // A disappearance could be an unavailable mount or a
                    // missed rename. Never cascade it into remote deletions.
                    throw fault('BACKEND_DISAPPEARED', `Replica disappeared at ${change.backend}:${change.key}; automatic deletion is paused`);
                }
            }
        }
        if (change.op === 'rename') await this.#stored.replicas.recordRelocation(change.backend, change.from, change.key);
    }
}
