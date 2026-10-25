'use strict';

import path from 'node:path';
import { readFileSync } from 'node:fs';
import EventEmitter from 'eventemitter2';
import Conf from 'conf';
import { v4 as uuidv4 } from 'uuid';

import Workspace from '../Workspace.js';
import { accessDenied, workspaceNotFound } from './errors.js';
import { enableService, disableService, getServicesStatus } from './services-control.js';
import { OWNER_PERMISSIONS, shareTokenGrant } from '../security/access.js';
import { findWorkspaceConfigPath, layoutForConfigPath, validateWorkspaceConfig } from '../config/discovery.js';
import { portableWorkspaceConfig } from '../config/portable-config.js';
import { initializeWorkspaceFolder, constructWorkspaceReference, sanitizeWorkspaceName } from '../config/init.js';
import { WORKSPACE_DEFAULT_HOST, WORKSPACE_LAYOUTS, normalizeWorkspaceLayout } from '../config/constants.js';

const COLLECTION_ONLY = 'This runtime hosts one workspace; initialize another folder for another runtime';

/**
 * The workspace-manager surface the routes use (see transports/api-contract.js),
 * for a runtime that hosts exactly one workspace. The runtime's user owns it;
 * anyone else arrives with a share token, or through a hub that resolved their
 * principal against the workspace ACL (the host checks both).
 *
 * Events of the workspace are re-emitted here with `workspaceId` filled in,
 * like the hub's WorkspaceManager does for each workspace it loads.
 */
export default class SingleWorkspaceManager extends EventEmitter {
    #rootPath;
    #name;
    #owner;
    #users;
    #inferd;
    #host = { agents: null, messaging: null };
    #config = null;
    #configPath = null;
    #workspace = null;

    /**
     * @param {Object} options
     * @param {string} options.rootPath - the workspace folder (either layout)
     * @param {string} options.owner - the runtime user's id
     * @param {Object} options.users - the host's users surface (one user)
     * @param {string} [options.name] - name for a folder that is not a workspace yet
     * @param {Object} [options.inferd] - started InferdClient for embeddings
     */
    constructor({ rootPath, owner, users, name, inferd = null }) {
        super({ wildcard: true, delimiter: '.', newListener: false, maxListeners: 100 });
        if (!rootPath || !owner) throw new Error('rootPath and owner are required');
        this.#rootPath = rootPath;
        this.#owner = owner;
        this.#users = users;
        this.#inferd = inferd;
        this.#name = name;
    }

    get users() { return this.#users; }
    get inferd() { return this.#inferd; }
    get workspaceId() { return this.#config.id; }
    setAgents(agents) { this.#host.agents = agents; }
    setMessaging(messaging) { this.#host.messaging = messaging; }

    /** Adopt the folder's workspace.json, or make the folder a workspace. */
    async initialize() {
        this.#configPath = findWorkspaceConfigPath(this.#rootPath);
        if (!this.#configPath) {
            const created = await initializeWorkspaceFolder(this.#rootPath, { name: this.#name || path.basename(this.#rootPath), owner: this.#owner, layout: WORKSPACE_LAYOUTS.HOME });
            this.#configPath = created.configPath;
        }
        const config = JSON.parse(readFileSync(this.#configPath, 'utf8'));
        const invalid = validateWorkspaceConfig(config);
        if (invalid) throw new Error(`Invalid workspace config at ${this.#configPath}: ${invalid}`);
        // A hand-built config may carry only an id or a name; the config's
        // location decides the layout (see discovery.js).
        const layout = layoutForConfigPath(this.#rootPath, this.#configPath);
        const fixed = { ...config, id: config.id || uuidv4(), name: sanitizeWorkspaceName(config.name || path.basename(this.#rootPath)) || 'workspace' };
        if (normalizeWorkspaceLayout(config.layout) !== layout || !config.layout) fixed.layout = layout;
        if (fixed.id !== config.id || fixed.name !== config.name || fixed.layout !== config.layout) this.#conf().store = portableWorkspaceConfig(fixed);
        // Location and ownership are bindings of this runtime, never portable config.
        this.#config = { ...fixed, owner: this.#owner, rootPath: this.#rootPath, configPath: this.#configPath,
            reference: constructWorkspaceReference(this.#owner, fixed.name, WORKSPACE_DEFAULT_HOST) };
        return this;
    }

    #conf() {
        return new Conf({ configFileMode: 0o600, configName: path.basename(this.#configPath, '.json'), cwd: path.dirname(this.#configPath), accessPropertiesByDotNotation: false });
    }

    #isOurs(workspaceId) {
        return workspaceId === this.#config.id || sanitizeWorkspaceName(workspaceId) === this.#config.name || workspaceId === this.#config.reference;
    }

    #instance() {
        if (this.#workspace) return this.#workspace;
        this.#workspace = new Workspace({ rootPath: this.#rootPath, owner: this.#owner, configStore: this.#conf(), inferd: this.#inferd, host: this.#host });
        const manager = this;
        this.#workspace.on('**', function (payload = {}) {
            if (!this.event) return;
            const eventPayload = payload && typeof payload === 'object' ? { ...payload } : { value: payload };
            if (!eventPayload.workspaceId) eventPayload.workspaceId = manager.#config.id;
            manager.emit(this.event, eventPayload);
        });
        return this.#workspace;
    }

    // ── lookup ────────────────────────────────────────────────────────────

    resolveWorkspaceId(_userId, identifier) { return this.#isOurs(identifier) ? this.#config.id : null; }

    async resolveWorkspaceIdFromSimpleIdentifier(identifier) {
        const name = String(identifier || '').split('/').pop();
        return this.resolveWorkspaceId(null, name);
    }

    getWorkspaceIndexEntry(workspaceId, userId = null) {
        if (!this.#isOurs(workspaceId) || (userId && userId !== this.#owner)) return null;
        return { ...this.#config, acl: this.#workspace?.acl ?? this.#conf().get('acl') ?? null };
    }

    async hasWorkspace(workspaceId, userId) { return this.#isOurs(workspaceId) && (!userId || userId === this.#owner); }

    async getWorkspaceOrThrow(workspaceId, userId) {
        if (!this.#isOurs(workspaceId)) throw workspaceNotFound(`Workspace not found: ${workspaceId}`);
        if (userId && userId !== this.#owner) throw accessDenied(`Access denied to workspace ${workspaceId}`);
        return this.#instance();
    }

    async getWorkspace(workspaceId, userId) {
        try { return await this.getWorkspaceOrThrow(workspaceId, userId); } catch (err) {
            if (err?.code === 'WORKSPACE_NOT_FOUND' || err?.code === 'ACCESS_DENIED') return null;
            throw err;
        }
    }

    async listWorkspaces(userId) {
        if (userId && userId !== this.#owner) return [];
        const ws = this.#instance();
        return [{ folderName: path.basename(this.#rootPath), ...this.#config, ...ws.toJSON(), status: ws.status, isActive: ws.isActive, protection: ws.protection }];
    }

    // ── access ────────────────────────────────────────────────────────────

    /** Owner only: other principals are resolved by the host (share tokens, hub context). */
    async resolveWorkspaceAccess(workspaceId, userId) {
        if (!this.#isOurs(workspaceId) || userId !== this.#owner) return null;
        return { isOwner: true, owner: this.#owner, permissions: [...OWNER_PERMISSIONS], via: 'owner', principal: null, description: 'Workspace owner' };
    }

    resolveWorkspaceShareToken(tokenValue) {
        const grant = shareTokenGrant(this.#workspace?.acl ?? this.#conf().get('acl'), tokenValue);
        return grant ? { workspaceId: this.#config.id, workspaceName: this.#config.name, owner: this.#owner, ...grant } : null;
    }

    async grantWorkspaceMember(workspaceId, userId, type, principal, options = {}) {
        const ws = await this.getWorkspaceOrThrow(workspaceId, userId);
        if (ws.isUniverse) throw accessDenied('The universe workspace cannot be shared');
        const member = ws.grantMember(type, principal, { ...options, grantedBy: userId });
        this.emit('workspace.member.granted', { workspaceId: ws.id, owner: ws.owner, member });
        return member;
    }

    async revokeWorkspaceMember(workspaceId, userId, type, principal) {
        const ws = await this.getWorkspaceOrThrow(workspaceId, userId);
        const removed = ws.revokeMember(type, principal);
        if (removed) this.emit('workspace.member.revoked', { workspaceId: ws.id, owner: ws.owner, type, principal });
        return removed;
    }

    // ── config and lifecycle ──────────────────────────────────────────────

    /** Merge `updates` into workspace.json; the ACL changes only when `updates.acl` is given. */
    async updateWorkspaceConfig(ownerUserId, workspaceId, _requestingUserId, updates = {}) {
        if (ownerUserId !== this.#owner || !this.#isOurs(workspaceId) || !updates || typeof updates !== 'object') return false;
        const conf = this.#conf();
        conf.store = portableWorkspaceConfig({ ...conf.store, ...updates, updatedAt: new Date().toISOString() });
        this.#config = { ...this.#config, ...portableWorkspaceConfig(updates) };
        return true;
    }

    async startWorkspace(workspaceId, userId, options = {}) {
        const ws = await this.getWorkspaceOrThrow(workspaceId, userId);
        await ws.start(options);
        return ws;
    }

    async stopWorkspace(workspaceId, userId, { reason } = {}) {
        const ws = await this.getWorkspace(workspaceId, userId);
        return ws ? ws.stop(reason) : true;
    }

    async configureWorkspaceProtection(workspaceId, userId, options) {
        const ws = await this.getWorkspaceOrThrow(workspaceId, userId);
        return ws.configureProtection(options);
    }

    async enableService(workspaceId, userId, serviceName) { return enableService(await this.getWorkspaceOrThrow(workspaceId, userId), serviceName); }
    async disableService(workspaceId, userId, serviceName) { return disableService(await this.getWorkspaceOrThrow(workspaceId, userId), serviceName); }
    async getServicesStatus(workspaceId, userId) { return getServicesStatus(await this.getWorkspaceOrThrow(workspaceId, userId)); }

    // ── collection operations: a hub's, not a runtime's ───────────────────

    async createWorkspace() { throw Object.assign(new Error(COLLECTION_ONLY), { statusCode: 409 }); }
    async removeWorkspace() { throw Object.assign(new Error(COLLECTION_ONLY), { statusCode: 409 }); }
    async registerWorkspacePath() { throw Object.assign(new Error(COLLECTION_ONLY), { statusCode: 409 }); }
    async scanUserWorkspaces() { return { discovered: [], adopted: [], updated: [], skipped: [], missing: [] }; }
}
