import { availableLocations } from 'canvas-synapsd/src/utils/document-locations.js';
import { randomUUID } from 'node:crypto';
import { backendIdentity, normalizeRemovalPolicy } from '../removal-policy.js';

const PREFIX = 'workspace/removals/v1/';
const BLOCK = 'workspace/removal-hold/';
const fail = message => Object.assign(new Error(message), { statusCode: 409 });
const identity = doc => JSON.stringify([doc.id, doc.checksumArray?.[0], doc.createdAt ?? doc.created]);
const address = endpoint => JSON.stringify([endpoint.backend, endpoint.key]);

/** Durable removal intent. Backend observations are persisted BEFORE updating
 * locations. Approval/execution is separate and replayable; ordinary discovery
 * cannot turn a removal decision into a new filing instruction.
 */
export default class WorkspaceTrashOperations {
    #ws; #state; #queue = Promise.resolve(); #timer; #stopped = false;
    constructor({ workspace, state }) { this.#ws = workspace; this.#state = state; }
    held(id) { return Boolean(this.#state.get(`${BLOCK}${id}`)); }
    #ownsHold(op) {
        const hold = this.#state.get(`${BLOCK}${op.documentId}`);
        return hold?.operationId === op.id && hold.identity === op.identity;
    }
    async release(id) { await this.#state.remove(`${BLOCK}${id}`); }
    async #save(op) {
        op.updatedAt = new Date().toISOString();
        await this.#state.put(`${PREFIX}${op.id}`, op);
        this.#ws.emit?.('trash.changed', { operationId: op.id, documentId: op.documentId });
        return op;
    }
    async list({ view = 'pending', backend, search = '', limit = 200, offset = 0 } = {}) {
        const rows = [];
        for await (const key of this.#state.getKeys({ start: PREFIX, end: `${PREFIX}\uffff` })) {
            const op = this.#state.get(key);
            if (!op || (backend && op.source.backend !== backend && op.source.account !== backend && !op.targets.some(t => t.backend === backend))) continue;
            if (view === 'pending' && !['observed', 'pending', 'queued', 'running', 'failed'].includes(op.state)) continue;
            if (view === 'trashed' && !op.targets.some(t => t.trashId && !['restored', 'purged'].includes(t.state))) continue;
            if (search && !JSON.stringify([op.title, op.source, op.targets]).toLowerCase().includes(search.toLowerCase())) continue;
            rows.push(op);
        }
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return { operations: rows.slice(offset, offset + limit), total: rows.length };
    }
    async observe({ document, removedLocations, remainingLocations, source, suppressPolicy = false, manualRemoval = false, keepDocument = false }) {
        const policy = normalizeRemovalPolicy(source.policy);
        // A same-backend move is only a location update; it is not loss of the source.
        const sourceStillPresent = source.survives === true;
        const placements = (await this.#ws.listDocumentPlacements(document.id))
            .filter(p => p.tree !== 'backends')
            .map(p => ({ ...p, paths: p.paths.filter(path => path !== '/.trash' && !(p.type === 'context' && path === '/')) }))
            .filter(p => p.paths.length);
        const orphan = remainingLocations.length === 0;
        const membership = orphan && !keepDocument ? 'trash' : suppressPolicy || sourceStillPresent || !placements.length ? 'keep' : policy.membership;
        const owner = this.#ws.storageOperations?.owner(`workspace-document:${document.id}`);
        const endpoints = await this.#ws.documentByteEndpoints({ ...document, locations: remainingLocations });
        const targets = endpoints.filter(e => e.backend !== source.backend && (policy.targets === 'all' || policy.targets.includes(e.backend)))
            .filter(e => ['file', 'cacache'].includes(this.#ws.dataBackends[e.backend]?.driver))
            .filter(e => e.backend === 'workspace:data' || owner?.replicas.some(r => r.managed && address(r) === address(e)))
            .map(e => ({ backend: e.backend, key: e.key, backendIdentity: backendIdentity(this.#ws.dataBackends[e.backend]), state: 'pending' }));
        const propagate = !suppressPolicy && !sourceStillPresent && policy.propagation !== 'never';
        const op = {
            id: randomUUID(), kind: 'removal', documentId: document.id, identity: identity(document),
            title: document.data?.title || document.data?.subject || document.metadata?.filename || document.data?.filename
                || removedLocations.find(l => l.metadata?.filename)?.metadata.filename || removedLocations[0]?.url.split('/').at(-1) || `Document ${document.id}`,
            checksum: document.checksumArray?.find(s => /^sha256[/:]/.test(s))?.replace(/^sha256[/:]/, '') || null,
            source: { ...source, policy: undefined }, removedLocations, remainingLocations, placements,
            membership, targets: propagate ? targets : [], state: 'observed',
            automaticMembership: membership === 'trash', automaticTargets: propagate && policy.propagation === 'automatic',
            createdAt: new Date().toISOString(), orphan,
        };
        op.updatedAt = op.createdAt;
        this.#state.transactionSync(() => {
            this.#state.putSync(`${PREFIX}${op.id}`, op);
            if (membership !== 'keep' || op.targets.length || (owner && (manualRemoval || (!suppressPolicy && !sourceStillPresent)))) {
                this.#state.putSync(`${BLOCK}${document.id}`, { operationId: op.id, identity: op.identity });
            }
        });
        this.#ws.emit?.('trash.changed', { operationId: op.id, documentId: op.documentId });
        return op.id;
    }
    async ready(ids) {
        for (const id of ids) {
            const op = this.#state.get(`${PREFIX}${id}`);
            if (!op || op.state !== 'observed') continue;
            op.state = op.automaticMembership || op.automaticTargets ? 'queued'
                : op.membership === 'review' || op.targets.length ? 'pending' : 'complete';
            if (op.automaticMembership) op.approvedMembership = true;
            if (op.automaticTargets) op.approvedTargets = op.targets.map(address);
            if (op.orphan && op.approvedMembership && !op.membershipApplied) {
                const doc = await this.#ws.get(op.documentId);
                if (!doc || identity(doc) !== op.identity || !this.#ownsHold(op) || availableLocations(doc).length) {
                    op.state = 'failed'; op.error = 'The item changed before removal completed; review the current item';
                    await this.#save(op); continue;
                }
                await this.#ws.trashFromSourceLoss(op.documentId, op.placements, op.id);
                op.membershipApplied = true;
                if (!op.targets.length) op.state = 'complete';
            }
            await this.#save(op);
        }
        this.schedule();
    }
    schedule() {
        if (this.#stopped || this.#timer) return;
        this.#timer = setTimeout(() => { this.#timer = null; void this.drain().catch(() => {}); }, 50);
        this.#timer.unref?.();
    }
    async stop() { this.#stopped = true; clearTimeout(this.#timer); await this.#queue.catch(() => {}); }
    async #serialized(fn) {
        const task = this.#queue.catch(() => {}).then(fn); this.#queue = task; return task;
    }
    async act(ids, action, { targets, membership = true } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string')) throw Object.assign(new Error('Select 1–200 operations'), { statusCode: 400 });
        if (!['approve', 'keep', 'retry', 'restore', 'purge'].includes(action)) throw Object.assign(new Error('Invalid Trash action'), { statusCode: 400 });
        return this.#serialized(async () => {
            const results = [];
            for (const id of [...new Set(ids)]) {
                try {
                    const op = this.#state.get(`${PREFIX}${id}`);
                    if (!op) throw fail('Removal operation not found');
                    if (['restore', 'purge'].includes(action)) {
                        const errors = [];
                        for (const target of op.targets.filter(t => t.trashId && !['restored', 'purged'].includes(t.state) && (!targets || targets.includes(address(t))))) {
                            try {
                                const result = await this.#ws.actOnRemovalCopy(target, action);
                                if (!result.ok) throw fail(result.reason || 'Copy action failed');
                                target.state = action === 'restore' ? 'restored' : 'purged'; target.error = null;
                            } catch (error) { target.error = error.message; errors.push(`${target.backend}: ${error.message}`); }
                            await this.#save(op);
                        }
                        if (errors.length) throw fail(errors.join('; '));
                    } else if (action === 'keep') {
                        if (!['pending', 'failed', 'observed'].includes(op.state)) throw fail('Only pending removals can be kept');
                        for (const target of op.targets) if (!target.trashId && target.state !== 'missing') { target.state = 'kept'; target.error = null; }
                        op.state = 'dismissed'; await this.#save(op);
                    } else {
                        if (!['pending', 'failed'].includes(op.state)) throw fail('This removal is no longer pending');
                        if (action === 'approve') {
                            op.approvedMembership = membership && op.membership !== 'keep';
                            const allowed = new Set(op.targets.map(address));
                            if (targets && (!Array.isArray(targets) || targets.some(t => !allowed.has(t)))) throw fail('Select targets from this operation');
                            op.approvedTargets = targets ?? op.targets.map(address);
                            for (const target of op.targets) if (!op.approvedTargets.includes(address(target)) && !target.trashId) target.state = 'kept';
                            if (!op.approvedMembership) op.membership = 'keep';
                        }
                        op.state = 'queued'; await this.#save(op); await this.#execute(op);
                    }
                    results.push({ id, ok: true, operation: this.#state.get(`${PREFIX}${id}`) });
                } catch (error) { results.push({ id, ok: false, error: error.message }); }
            }
            return { results };
        });
    }
    async drain() {
        return this.#serialized(async () => {
            const { operations } = await this.list({ view: 'pending', limit: Number.MAX_SAFE_INTEGER });
            for (const op of operations) {
                if (this.#stopped) break;
                if (op.state === 'observed') {
                    try {
                        const doc = await this.#ws.get(op.documentId);
                        if (!doc || identity(doc) !== op.identity) throw fail('Document identity changed; review the current item');
                        if ((op.membership !== 'keep' || op.targets.length) && !this.#ownsHold(op)) throw fail('A newer filing decision superseded this removal');
                        if (availableLocations(doc).some(l => op.removedLocations.some(old => old.url === l.url))) {
                            await this.#ws.verifyRemovalSource(op);
                            await this.#ws.finishRemovalObservation(op, doc);
                        }
                        await this.ready([op.id]);
                    } catch (error) { op.state = 'failed'; op.error = error.message; await this.#save(op); }
                }
                const live = this.#state.get(`${PREFIX}${op.id}`);
                if (['queued', 'running'].includes(live.state)) await this.#execute(live);
            }
        });
    }
    async #execute(op) {
        try {
            const doc = await this.#ws.get(op.documentId);
            if (!doc || identity(doc) !== op.identity) throw fail('Document identity changed; review the current item');
            if (!this.#ownsHold(op)) throw fail('The item was explicitly restored, refiled or has a newer removal; this older removal is paused');
            if (availableLocations(doc).some(l => op.removedLocations.some(old => old.url === l.url))) throw fail('Source location has returned; review the current item');
            if (this.#ws.verifyRemovalSource && (!op.orphan || op.approvedTargets?.length)) await this.#ws.verifyRemovalSource(op);
            op.state = 'running'; op.error = null; await this.#save(op);
            if (op.approvedMembership && !op.membershipApplied) {
                await this.#ws.trashFromSourceLoss(op.documentId, op.placements, op.id);
                op.membershipApplied = true; await this.#save(op);
            }
            for (const target of op.targets) {
                if (!op.approvedTargets?.includes(address(target)) || ['trashed', 'restored', 'purged', 'missing'].includes(target.state)) continue;
                try {
                    if (!this.#ownsHold(op)) throw fail('The item was restored or refiled during removal');
                    const result = await this.#ws.removeTrackedCopy(op, target);
                    target.state = result.state === 'restored' ? 'restored' : result.state === 'discarded' ? 'purged' : result.trashId ? 'trashed' : 'missing'; target.trashId = result.trashId || null; target.error = null;
                } catch (error) { target.state = 'failed'; target.error = error.message; }
                await this.#save(op);
            }
            const remaining = await this.#ws.get(op.documentId);
            if (remaining && !availableLocations(remaining).length && !op.membershipApplied && this.#ownsHold(op)) {
                await this.#ws.trashFromSourceLoss(op.documentId, op.placements, op.id);
                op.membershipApplied = true; op.orphan = true;
            }
            op.state = op.targets.some(t => t.state === 'failed') ? 'failed'
                : (op.membership === 'review' && !op.membershipApplied) || op.targets.some(t => t.state === 'pending') ? 'pending' : 'complete';
            await this.#save(op);
        } catch (error) { op.state = 'failed'; op.error = error.message; await this.#save(op); }
    }
}
