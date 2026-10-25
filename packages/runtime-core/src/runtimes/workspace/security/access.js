'use strict';

/**
 * Workspace access resolution — pure helpers, no I/O.
 *
 * A workspace ACL (workspace.json `acl`) carries three principal kinds:
 *
 *   acl.tokens["sha256:…"]   = { permissions, description, expiresAt, … }  (share tokens)
 *   acl.users["a@corp.tld"]  = { permissions, description, grantedAt, grantedBy }
 *   acl.groups["team-a"]     = { permissions, description, grantedAt, grantedBy }
 *
 * Users are keyed by e-mail so a grant can precede the teammate's first
 * (LDAP auto-creating) login. Groups are keyed by whatever the directory
 * calls them — a full DN (`cn=team-a,ou=groups,dc=corp,dc=tld`) or just the
 * CN (`team-a`). A user's `groups` (from LDAP `memberOf`, or set by an admin)
 * match a grant when either the full value or the CN is equal,
 * case-insensitively. Owners always hold every permission.
 */

import { createHash } from 'node:crypto';

export const WORKSPACE_PERMISSIONS = Object.freeze(['read', 'write', 'admin']);
export const OWNER_PERMISSIONS = Object.freeze(['read', 'write', 'admin']);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND']);

/** The workspace permission an HTTP method implies (read for safe methods, write otherwise). */
export function permissionForMethod(method) {
    return READ_METHODS.has(String(method || '').toUpperCase()) ? 'read' : 'write';
}

// POST routes that only read (search, previews, export tickets, copying out).
const READ_POSTS = /\/(search(\/image)?|query|resolve|preview|exports\/ticket|copy-to-workspace|subtree\/export)(\/|$)/;

/** Permission a workspace request needs, from its method and path. */
export function requiredPermission(method, url) {
    const pathname = String(url || '').split('?')[0];
    return String(method || '').toUpperCase() === 'POST' && READ_POSTS.test(pathname) ? 'read' : permissionForMethod(method);
}

export function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

/**
 * Canonical comparison forms of a group name: the full value and, for a DN,
 * its first RDN value (the CN). Both lower-cased and trimmed.
 * @returns {string[]}
 */
function groupAliases(group) {
    const full = String(group || '').trim().toLowerCase();
    if (!full) return [];
    const aliases = [full];
    const rdn = full.match(/^\s*(?:cn|ou|uid)\s*=\s*([^,]+)/i);
    if (rdn) aliases.push(rdn[1].trim());
    return aliases;
}

/** True when a granted group name and a user's group membership denote the same group. */
export function groupMatches(grantedGroup, userGroup) {
    const a = groupAliases(grantedGroup);
    const b = groupAliases(userGroup);
    if (!a.length || !b.length) return false;
    // Exact full match, or CN-to-CN / CN-to-full match in either direction.
    return a.some((x) => b.includes(x));
}

export function normalizePermissions(permissions) {
    const list = Array.isArray(permissions) ? permissions : [permissions];
    const out = list.map((p) => String(p || '').trim().toLowerCase()).filter((p) => WORKSPACE_PERMISSIONS.includes(p));
    // write implies read; admin implies both (keeps grants self-consistent).
    if (out.includes('admin')) { out.push('read', 'write'); }
    if (out.includes('write')) { out.push('read'); }
    return [...new Set(out)].sort((x, y) => WORKSPACE_PERMISSIONS.indexOf(x) - WORKSPACE_PERMISSIONS.indexOf(y));
}

/**
 * Resolve what an ACL grants a principal. Owner checks happen outside (the
 * ACL does not know the owner). Returns null when nothing applies.
 * @param {Object} acl - workspace.json `acl`
 * @param {{ email?: string, groups?: string[] }} principal
 * @returns {{ permissions: string[], via: 'user'|'group', principal: string, grant: Object }|null}
 */
export function resolveAclAccess(acl, principal) {
    if (!acl || !principal) return null;
    const email = normalizeEmail(principal.email);
    if (email && acl.users) {
        for (const [key, grant] of Object.entries(acl.users)) {
            if (normalizeEmail(key) === email && grant) {
                return { permissions: normalizePermissions(grant.permissions), via: 'user', principal: key, grant };
            }
        }
    }
    const groups = Array.isArray(principal.groups) ? principal.groups : [];
    if (groups.length && acl.groups) {
        let best = null;
        for (const [key, grant] of Object.entries(acl.groups)) {
            if (!grant || !groups.some((g) => groupMatches(key, g))) continue;
            const permissions = normalizePermissions(grant.permissions);
            // Several matching groups: the widest grant wins.
            if (!best || permissions.length > best.permissions.length) {
                best = { permissions, via: 'group', principal: key, grant };
            }
        }
        if (best) return best;
    }
    return null;
}

/** Key of a share token (canvas-workspace-…) in `acl.tokens`: tokens are stored hashed. */
export function shareTokenKey(tokenValue) {
    return `sha256:${createHash('sha256').update(tokenValue).digest('hex')}`;
}

/**
 * What a share token grants in an ACL. Null when the token is unknown or expired.
 * @returns {{ permissions: string[], tokenData: Object }|null}
 */
export function shareTokenGrant(acl, tokenValue) {
    if (!tokenValue || typeof tokenValue !== 'string') return null;
    return shareKeyGrant(acl, shareTokenKey(tokenValue));
}

/** As shareTokenGrant, by the token's key (`sha256:…`): what a hub credential carries instead of the token. */
export function shareKeyGrant(acl, key) {
    const tokenData = typeof key === 'string' && acl?.tokens && Object.hasOwn(acl.tokens, key) ? acl.tokens[key] : null;
    if (!tokenData || (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date())) return null;
    return { permissions: tokenData.permissions || ['read'], tokenData };
}
