'use strict';

import path from 'path';
import { requiredPermission } from '../../runtimes/workspace/security/access.js';
import { createLogger } from '../../utils/log.js';
import ResponseObject from '../ResponseObject.js';

const logger = createLogger('canvas-server:middleware:agent-acl');

/**
 * Agent binding enforcement
 *
 * Agent tokens (canvas-agent-*) authenticate as the agent's owner but carry a
 * resource binding: { workspaceId, basePath, permissions }. This middleware is
 * the data-plane clamp:
 *  - the addressed workspace must be the bound workspace
 *  - the runtime permission classifier distinguishes read queries from writes
 *  - filing/navigation paths are clamped to basePath
 *  - native document search uses an independent mandatory candidate scope
 *
 * Non-data-plane routes (agents CRUD, admin, users, roles) reject agent
 * tokens outright via rejectAgentTokens.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Clamp a requested context path to a base path.
 * @param {string} basePath - normalized binding base ('/' = unrestricted)
 * @param {string|null|undefined} requested
 * @returns {string|null} normalized path within base, or null when it escapes
 */
export function clampPathToBase(basePath, requested) {
    const base = basePath || '/';

    if (requested === undefined || requested === null || String(requested).trim() === '') {
        return base;
    }

    const raw = String(requested).trim();
    const withRoot = raw.startsWith('/') ? raw : `/${raw}`;
    const normalized = path.posix.normalize(withRoot);
    if (normalized === '..' || normalized.startsWith('/..') || normalized.includes('/../') || normalized.endsWith('/..')) {
        return null;
    }

    const clean = normalized !== '/' && normalized.endsWith('/')
        ? normalized.slice(0, -1)
        : normalized;

    if (base === '/') return clean;
    // '/' means "everything I can see" — route schemas default missing context
    // to '/', so root aliases to the binding base rather than escaping it.
    if (clean === '/') return base;
    if (clean === base || clean.startsWith(`${base}/`)) return clean;
    return null;
}

function forbidden(reply, message) {
    const response = new ResponseObject().forbidden(message);
    return reply.code(response.statusCode).send(response.getResponse());
}

// Resolve the addressed workspace (route param) to an id for binding compare.
function resolveAddressedWorkspaceId(request) {
    const identifier = request.params?.id;
    if (!identifier) return null;
    if (UUID_REGEX.test(identifier)) return identifier;
    try {
        return request.server.workspaceManager?.resolveWorkspaceId(request.user?.id, identifier) || null;
    } catch (error) {
        logger.debug(`Workspace resolution failed for agent binding check: ${error.message}`);
        return null;
    }
}

/**
 * preHandler for workspace data-plane routes.
 */
export async function enforceAgentBinding(request, reply) {
    const binding = request.resourceToken;
    if (binding?.type !== 'agent') return;

    // 1. Workspace lock — global bindings ('*') may address any workspace
    // the owner can access; owner ACLs downstream are the backstop.
    if (binding.workspaceId !== '*' && request.params?.id) {
        const addressedWorkspaceId = resolveAddressedWorkspaceId(request);
        if (addressedWorkspaceId !== binding.workspaceId) {
            logger.debug(`Agent ${binding.agentId} denied: workspace ${request.params.id} outside binding`);
            return forbidden(reply, 'Agent token is not bound to this workspace');
        }
    }

    // 2. Runtime operation permission
    const needed = requiredPermission(request.method, request.url);
    if (!binding.permissions?.includes(needed)) {
        return forbidden(reply, `Agent token lacks required permission: ${needed}`);
    }

    // Native search preserves independent path/feature OR groups. Its handler
    // supplies a separate mandatory candidate scope before ranking and paging.
    if (request.method === 'POST' && /\/documents\/search\/?(?:\?|$)/.test(request.url || '')) return;

    // Tree handlers validate their own tree identity, paths and shared-layer scope.
    if (/\/workspaces\/[^/]+\/trees?(?:\/|$)/.test((request.url || '').split('?')[0])) return;

    // 3. Path clamp
    const basePath = binding.basePath || '/';
    if (basePath === '/') return;

    if (request.query && typeof request.query === 'object') {
        // Whole-workspace listing would bypass the path bucket entirely.
        if (request.query.scope === 'workspace') request.query.scope = 'path';

        if ('context' in request.query || needed === 'read') {
            const clamped = clampPathToBase(basePath, request.query.context);
            if (clamped === null) {
                return forbidden(reply, `Path is outside the agent's bound scope (${basePath})`);
            }
            request.query.context = clamped;
        }
    }

    if (request.body !== undefined && request.body !== null) {
        if (Array.isArray(request.body) && !(request.method === 'DELETE' && /\/documents\/remove(?:\?|$)/.test(request.url || ''))) {
            // Top-level id arrays insert at '/', which a path-bound agent may not do.
            return forbidden(reply, 'Path-bound agent tokens must use the object body form with an explicit context');
        }
        if (typeof request.body === 'object' && !Array.isArray(request.body)) {
            const contexts = Array.isArray(request.body.context) ? request.body.context : [request.body.context];
            const clamped = contexts.map((entry) => clampPathToBase(basePath, entry));
            if (clamped.some((entry) => entry === null)) {
                return forbidden(reply, `Path is outside the agent's bound scope (${basePath})`);
            }
            request.body.context = Array.isArray(request.body.context) ? clamped : clamped[0];
        }
    }


}

/**
 * preHandler for routes agent tokens must never reach (control plane).
 */
export async function rejectAgentTokens(request, reply) {
    if (request.resourceToken?.type === 'agent') {
        return forbidden(reply, 'Agent tokens cannot access this resource');
    }
}

export default { enforceAgentBinding, rejectAgentTokens, clampPathToBase };
