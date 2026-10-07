'use strict';

import fs from 'fs';
import path from 'path';
import { env } from '../../env.js';

/**
 * Admin-facing view of `<server home>/config/auth.json` — the auth backends
 * (local passwords, IMAP, LDAP) as one server-scoped document.
 *
 * The file holds secrets (LDAP bind passwords, the JWT secret), so:
 *  - reads are REDACTED: bind passwords come back as `bindPasswordSet`, and
 *    the `jwt` block is never sent at all;
 *  - writes MERGE: a bind password left out keeps the stored one, `null`
 *    clears it, a string replaces it; `jwt`, `rateLimiting` and any key this
 *    module does not know about are carried over untouched;
 *  - the file is replaced atomically with mode 0600.
 *
 * Domain/server maps are replaced as a whole — an entry missing from the
 * update is removed — but each surviving entry is overlaid on its stored
 * self, so hand-written extras (IMAP `tlsOptions`, …) survive a UI save.
 */

export const AUTH_USER_TYPES = ['user', 'admin'];
export const AUTH_USER_STATUSES = ['active', 'pending', 'inactive'];

const POLICY_BOOLS = ['requireUppercase', 'requireLowercase', 'requireNumbers', 'requireSpecialChars'];

export function authConfigPath() {
  return path.join(env.server.home, 'config', 'auth.json');
}

export function readAuthConfigFile(file = authConfigPath()) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Atomic replace — a crash mid-write must never leave a half-written auth file. */
export function writeAuthConfigFile(config, file = authConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The editable shape, secrets replaced by `*Set` flags. */
export function redactAuthConfig(config) {
  const c = obj(config);
  const s = obj(c.strategies);
  const local = obj(s.local);
  const imap = obj(s.imap);
  const ldap = obj(s.ldap);
  return {
    allowUserRegistrations: c.allowUserRegistrations !== false,
    strategies: {
      local: {
        enabled: local.enabled !== false,
        requireEmailVerification: !!local.requireEmailVerification,
        passwordPolicy: {
          minLength: obj(local.passwordPolicy).minLength ?? 6,
          maxLength: obj(local.passwordPolicy).maxLength ?? 128,
          ...Object.fromEntries(POLICY_BOOLS.map((k) => [k, obj(local.passwordPolicy)[k] ?? (k === 'requireNumbers' || k === 'requireSpecialChars')])),
        },
      },
      imap: {
        enabled: !!imap.enabled,
        defaultUserType: imap.defaultUserType || 'user',
        defaultStatus: imap.defaultStatus || 'active',
        domains: Object.fromEntries(Object.entries(obj(imap.domains)).map(([domain, d]) => [domain, {
          name: d.name || '',
          host: d.host || '',
          port: Number(d.port) || 993,
          secure: d.secure !== false,
          startTLS: !!d.startTLS,
          requireAppPassword: !!d.requireAppPassword,
        }])),
      },
      ldap: {
        enabled: !!ldap.enabled,
        defaultUserType: ldap.defaultUserType || 'user',
        defaultStatus: ldap.defaultStatus || 'active',
        servers: Object.fromEntries(Object.entries(obj(ldap.servers)).map(([name, sv]) => [name, {
          url: sv.url || '',
          bindDN: sv.bindDN || '',
          bindPasswordSet: !!sv.bindPassword,
          searchBase: sv.searchBase || '',
          searchFilter: sv.searchFilter || '(mail={{email}})',
          attributes: Array.isArray(sv.attributes) ? sv.attributes : ['mail', 'cn', 'displayName', 'memberOf'],
          groupAttribute: sv.groupAttribute || 'memberOf',
          tls: !!sv.tls,
        }])),
      },
    },
  };
}

export class AuthConfigValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'AuthConfigValidationError';
    this.errors = errors;
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Apply an update (the redacted shape, with optional `bindPassword`) to the
 * stored config. Returns the full config to write; throws
 * AuthConfigValidationError listing every problem at once.
 */
export function mergeAuthConfig(current, update) {
  const cur = obj(current);
  const up = obj(update);
  const curS = obj(cur.strategies);
  const upS = obj(up.strategies);
  const errors = [];

  const next = { ...cur, strategies: { ...curS } };
  if (typeof up.allowUserRegistrations === 'boolean') next.allowUserRegistrations = up.allowUserRegistrations;

  // ── local ──
  if (upS.local) {
    const l = obj(upS.local);
    const curL = obj(curS.local);
    const pp = { ...obj(curL.passwordPolicy) };
    const upP = obj(l.passwordPolicy);
    for (const k of ['minLength', 'maxLength']) {
      if (upP[k] === undefined) continue;
      const n = Number(upP[k]);
      if (!Number.isInteger(n) || n < 1 || n > 1024) errors.push(`local.passwordPolicy.${k} must be an integer between 1 and 1024`);
      else pp[k] = n;
    }
    if ((pp.minLength ?? 6) > (pp.maxLength ?? 128)) errors.push('local.passwordPolicy.minLength cannot exceed maxLength');
    for (const k of POLICY_BOOLS) if (typeof upP[k] === 'boolean') pp[k] = upP[k];
    next.strategies.local = {
      ...curL,
      ...(typeof l.enabled === 'boolean' ? { enabled: l.enabled } : {}),
      ...(typeof l.requireEmailVerification === 'boolean' ? { requireEmailVerification: l.requireEmailVerification } : {}),
      passwordPolicy: pp,
    };
  }

  const defaults = (key, u, c) => {
    const out = {};
    if (u.defaultUserType !== undefined) {
      if (!AUTH_USER_TYPES.includes(u.defaultUserType)) errors.push(`${key}.defaultUserType must be one of ${AUTH_USER_TYPES.join(', ')}`);
      else out.defaultUserType = u.defaultUserType;
    }
    if (u.defaultStatus !== undefined) {
      if (!AUTH_USER_STATUSES.includes(u.defaultStatus)) errors.push(`${key}.defaultStatus must be one of ${AUTH_USER_STATUSES.join(', ')}`);
      else out.defaultStatus = u.defaultStatus;
    }
    return { ...c, ...(typeof u.enabled === 'boolean' ? { enabled: u.enabled } : {}), ...out };
  };

  // ── imap ──
  if (upS.imap) {
    const u = obj(upS.imap);
    const c = obj(curS.imap);
    const imap = defaults('imap', u, c);
    if (u.domains !== undefined) {
      const curD = obj(c.domains);
      const domains = {};
      for (const [rawDomain, rawEntry] of Object.entries(obj(u.domains))) {
        const domain = rawDomain.trim().toLowerCase();
        const e = obj(rawEntry);
        if (!DOMAIN_RE.test(domain)) { errors.push(`imap: "${rawDomain}" is not a valid e-mail domain`); continue; }
        const host = str(e.host);
        const port = Number(e.port);
        if (!host) errors.push(`imap.${domain}: host is required`);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`imap.${domain}: port must be 1–65535`);
        domains[domain] = {
          ...obj(curD[domain]),
          host,
          port,
          secure: e.secure !== false,
          startTLS: !!e.startTLS,
          requireAppPassword: !!e.requireAppPassword,
          ...(str(e.name) ? { name: str(e.name) } : {}),
        };
        if (!str(e.name)) delete domains[domain].name;
      }
      imap.domains = domains;
    }
    if (imap.enabled && !Object.keys(obj(imap.domains)).length) errors.push('imap: add at least one domain before enabling IMAP sign-in');
    next.strategies.imap = imap;
  }

  // ── ldap ──
  if (upS.ldap) {
    const u = obj(upS.ldap);
    const c = obj(curS.ldap);
    const ldap = defaults('ldap', u, c);
    if (u.servers !== undefined) {
      const curSv = obj(c.servers);
      const servers = {};
      for (const [name, rawEntry] of Object.entries(obj(u.servers))) {
        const e = obj(rawEntry);
        if (!NAME_RE.test(name)) { errors.push(`ldap: server name "${name}" may only contain letters, digits, - and _`); continue; }
        const url = str(e.url);
        if (!/^ldaps?:\/\/[^\s/]+/i.test(url)) errors.push(`ldap.${name}: url must start with ldap:// or ldaps://`);
        if (!str(e.searchBase)) errors.push(`ldap.${name}: searchBase is required`);
        const filter = str(e.searchFilter) || '(mail={{email}})';
        if (!filter.includes('{{email}}')) errors.push(`ldap.${name}: searchFilter must contain {{email}}`);
        // A rename in the UI carries `previousName`, so the stored secret follows it.
        const prev = obj(curSv[typeof e.previousName === 'string' && e.previousName ? e.previousName : name]);
        const { previousName: _previousName, ...prevRest } = prev;
        const entry = {
          ...prevRest,
          url,
          bindDN: str(e.bindDN),
          searchBase: str(e.searchBase),
          searchFilter: filter,
          attributes: Array.isArray(e.attributes) ? e.attributes.map(str).filter(Boolean) : (prev.attributes || ['mail', 'cn', 'displayName', 'memberOf']),
          groupAttribute: str(e.groupAttribute) || 'memberOf',
          tls: !!e.tls,
        };
        // undefined = keep, null = clear, string = replace
        if (e.bindPassword === null) entry.bindPassword = '';
        else if (typeof e.bindPassword === 'string') entry.bindPassword = e.bindPassword;
        else entry.bindPassword = prev.bindPassword || '';
        servers[name] = entry;
      }
      ldap.servers = servers;
    }
    if (ldap.enabled && !Object.keys(obj(ldap.servers)).length) errors.push('ldap: add at least one server before enabling LDAP sign-in');
    next.strategies.ldap = ldap;
  }

  if (errors.length) throw new AuthConfigValidationError(errors);
  return next;
}

/** Resolve a server entry for testing: an omitted bind password falls back to the stored one. */
export function resolveLdapTestServer(current, name, entry) {
  const e = obj(entry);
  const servers = obj(obj(obj(obj(current).strategies).ldap).servers);
  const stored = servers[typeof e.previousName === 'string' && e.previousName ? e.previousName : name] || {};
  return {
    url: str(e.url) || stored.url,
    bindDN: e.bindDN !== undefined ? str(e.bindDN) : stored.bindDN,
    bindPassword: e.bindPassword === null ? '' : typeof e.bindPassword === 'string' ? e.bindPassword : (stored.bindPassword || ''),
    searchBase: e.searchBase !== undefined ? str(e.searchBase) : stored.searchBase,
    searchFilter: str(e.searchFilter) || stored.searchFilter || '(mail={{email}})',
    groupAttribute: str(e.groupAttribute) || stored.groupAttribute || 'memberOf',
    tls: e.tls !== undefined ? !!e.tls : !!stored.tls,
  };
}

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
]);

/** LDAP escape for a filter value (RFC 4515). */
const escapeFilter = (v) => String(v).replace(/[\\*()\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);

/**
 * Bind with the service account and, given `email`, look the user up —
 * proves URL, bind DN/password, base and filter without a user password.
 */
export async function testLdapServer(server, { email } = {}) {
  const mod = await import('ldapjs').catch(() => null);
  if (!mod) return { ok: false, message: 'ldapjs is not installed on the server.' };
  const ldap = mod.default || mod;
  const client = ldap.createClient({
    url: server.url,
    connectTimeout: 8000,
    timeout: 8000,
    tlsOptions: server.tls ? { rejectUnauthorized: false } : undefined,
  });
  client.on('error', () => {}); // surfaced through the callbacks below
  const close = () => { try { client.unbind(); } catch { /* ignore */ } };
  try {
    if (server.bindDN) {
      await withTimeout(new Promise((resolve, reject) => client.bind(server.bindDN, server.bindPassword || '', (err) => err ? reject(err) : resolve())), 10000, 'Bind');
    }
    if (!email) {
      return { ok: true, message: server.bindDN ? `Connected and bound as ${server.bindDN}.` : 'Connected (anonymous — no bind DN set).' };
    }
    const filter = server.searchFilter.replaceAll('{{email}}', escapeFilter(email));
    const entries = await withTimeout(new Promise((resolve, reject) => {
      client.search(server.searchBase, { scope: 'sub', filter, sizeLimit: 2, attributes: ['dn', 'mail', 'cn', 'displayName', server.groupAttribute] }, (err, res) => {
        if (err) return reject(err);
        const found = [];
        res.on('searchEntry', (entry) => {
          const o = entry.pojo ? Object.fromEntries(entry.pojo.attributes.map((a) => [a.type, a.values.length > 1 ? a.values : a.values[0]])) : (entry.object || {});
          found.push({ dn: entry.pojo?.objectName || entry.dn?.toString?.() || o.dn, ...o });
        });
        res.on('error', reject);
        res.on('end', () => resolve(found));
      });
    }), 10000, 'Search');
    if (!entries.length) return { ok: false, message: `Bound fine, but ${filter} found nobody under ${server.searchBase}.` };
    const hit = entries[0];
    const raw = hit[server.groupAttribute];
    const groups = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return {
      ok: true,
      message: `Found ${hit.displayName || hit.cn || email}${entries.length > 1 ? ' (filter matches more than one entry — the first one would be used)' : ''}.`,
      user: { dn: hit.dn, name: hit.displayName || hit.cn || null, email: hit.mail || null, groups },
    };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  } finally {
    close();
  }
}

/** Log in to an IMAP server with real credentials, then log straight out. */
export async function testImapDomain(domainConfig, { email, password }) {
  if (!email || !password) return { ok: false, message: 'An e-mail address and password on that domain are needed to test IMAP sign-in.' };
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: domainConfig.host,
    port: Number(domainConfig.port),
    secure: domainConfig.secure !== false,
    ...(domainConfig.startTLS ? { requireTLS: true } : {}),
    ...(domainConfig.tlsOptions ? { tls: domainConfig.tlsOptions } : {}),
    auth: { user: email, pass: password },
    logger: false,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
  });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 15000, 'IMAP login');
    return { ok: true, message: `Signed in to ${domainConfig.host} as ${email}.` };
  } catch (err) {
    const msg = err?.authenticationFailed ? 'The server rejected those credentials.' : (err?.responseText || err?.message || String(err));
    return { ok: false, message: msg };
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}
