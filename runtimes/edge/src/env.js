'use strict';

import { resolveTls } from '@augmentd-labs/canvas-api-client/tls';
import fs from 'fs';
import os from 'os';
import path from 'path';
import EdgeClient from './EdgeClient.js';

/*
 * The daemon's own home. Deliberately NOT src/env.js: there CANVAS_USER_HOME
 * means the server's users root, while for every client (cli, canvas-fuse,
 * desktop) it is the per-user config home (~/.canvas). The daemon is a client.
 */
export const EDGE_HOME = process.env.CANVAS_EDGE_HOME
    || process.env.CANVAS_USER_HOME
    || (process.platform === 'win32' ? path.join(os.homedir(), 'Canvas') : path.join(os.homedir(), '.canvas'));

export const EDGE_PATHS = Object.freeze({
    home: EDGE_HOME,
    mirrors: path.join(EDGE_HOME, 'config', 'mirrors.json'),
    remotes: path.join(EDGE_HOME, 'config', 'remotes.json'),
    device: process.env.CANVAS_DEVICE_FILE || (process.platform === 'win32'
        ? path.join(os.homedir(), 'Canvas', 'device.json')
        : path.join(os.homedir(), '.canvas', 'device.json')),
    run: path.join(EDGE_HOME, 'run'),
    socket: process.platform === 'win32' ? null : path.join(EDGE_HOME, 'run', 'edge.sock'),
    port: Number(process.env.CANVAS_EDGE_PORT) || 8802,
    log: path.join(EDGE_HOME, 'var', 'log', 'canvas-edge.log'),
});

export function readJson(file, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/*
 * External state (docs/durable-workspaces.md, step 4). A mirror keeps its
 * ledger, queue, cache, trash and conflicts under `<folder>/.workspace/` by
 * default. A backup target (a NAS share) should hold user files only, so a
 * mirror may name a `stateDir`, or the daemon may be given a root under
 * which every mirror gets `<root>/<mirror id>` (the container sets
 * CANVAS_EDGE_STATE_ROOT=/state).
 */
export const STATE_ROOT = process.env.CANVAS_EDGE_STATE_ROOT ? path.resolve(process.env.CANVAS_EDGE_STATE_ROOT) : null;

export function resolveStateDir(mirror, stateRoot = STATE_ROOT) {
    if (mirror?.stateDir) return path.resolve(String(mirror.stateDir));
    if (stateRoot && mirror?.id) return path.join(stateRoot, String(mirror.id).replace(/[^a-zA-Z0-9._@-]+/g, '_'));
    return null;   // null = inside the folder (`<folder>/.workspace`)
}

/*
 * Env-driven single-mirror setup (the container's way in): with
 * CANVAS_HUB_URL + CANVAS_HUB_TOKEN + CANVAS_WORKSPACE set, the daemon writes
 * (or refreshes) one remote and one daemon mirror in its own config files
 * before loading them. Idempotent: matched by id, only env-driven fields are
 * overwritten, everything else the files carry is kept.
 *
 *   CANVAS_HUB_URL         https://canvas.example.org
 *   CANVAS_HUB_TOKEN       user/API, device or workspace token
 *   CANVAS_HUB_ID          remote id (default "hub")
 *   CANVAS_WORKSPACE       workspace name (as in the hub URL)
 *   CANVAS_MIRROR_PATH     folder to mirror (default /data)
 *   CANVAS_DIRECTION       bi | pull | push (default bi)
 *   CANVAS_CONFLICTS       prompt | rename        CANVAS_DELETES  propagate | keep
 *   CANVAS_PINS / CANVAS_IGNORE   comma-separated globs
 */
export function ensureEnvConfig(env = process.env) {
    const url = env.CANVAS_HUB_URL && String(env.CANVAS_HUB_URL).trim().replace(/\/+$/, '');
    const token = env.CANVAS_HUB_TOKEN && String(env.CANVAS_HUB_TOKEN).trim();
    const workspace = env.CANVAS_WORKSPACE && String(env.CANVAS_WORKSPACE).trim();
    if (!url || !token || !workspace) return null;
    const hubId = (env.CANVAS_HUB_ID && String(env.CANVAS_HUB_ID).trim()) || 'hub';
    const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const oneOf = (v, allowed, fallback) => (allowed.includes(String(v ?? '').trim()) ? String(v).trim() : fallback);

    const remotes = readJson(EDGE_PATHS.remotes, {}) || {};
    const prior = remotes[hubId] || {};
    // A device token minted for this remote stays authoritative; env only
    // seeds the user/API token it started from.
    remotes[hubId] = { ...prior, url, apiBase: prior.apiBase || '/rest/v2', auth: { ...(prior.auth || {}), token }, source: 'env', ...(resolveTls(prior.url && new URL(prior.url).origin !== new URL(url).origin ? undefined : prior.tls, env) ? { tls: resolveTls(prior.url && new URL(prior.url).origin !== new URL(url).origin ? undefined : prior.tls, env) } : { tls: undefined }) };
    writeJson(EDGE_PATHS.remotes, remotes);

    const cfg = readJson(EDGE_PATHS.mirrors, { version: 1, mirrors: [] }) || { version: 1, mirrors: [] };
    const mirrors = Array.isArray(cfg.mirrors) ? cfg.mirrors : [];
    const id = `${hubId}/${workspace.toLowerCase()}`;
    const existing = mirrors.find((m) => m?.id === id) || {};
    const mirror = {
        ...existing,
        id,
        remote: hubId,
        workspaceId: existing.workspaceId || null,
        workspaceName: workspace.toLowerCase(),
        folderName: existing.folderName || workspace,
        mountpoint: path.resolve(env.CANVAS_MIRROR_PATH ? String(env.CANVAS_MIRROR_PATH) : (existing.mountpoint || '/data')),
        pins: env.CANVAS_PINS != null ? list(env.CANVAS_PINS) : (existing.pins || []),
        ignore: env.CANVAS_IGNORE != null ? list(env.CANVAS_IGNORE) : (existing.ignore || []),
        conflicts: oneOf(env.CANVAS_CONFLICTS, ['prompt', 'rename'], existing.conflicts || 'prompt'),
        deletes: oneOf(env.CANVAS_DELETES, ['propagate', 'keep'], existing.deletes || 'propagate'),
        direction: oneOf(env.CANVAS_DIRECTION, ['bi', 'pull', 'push'], existing.direction || 'bi'),
        client: 'daemon',
        managed: existing.managed || 'container',
        paused: false,
        createdAt: existing.createdAt || new Date().toISOString(),
        source: 'env',
    };
    cfg.mirrors = [...mirrors.filter((m) => m?.id !== id), mirror];
    writeJson(EDGE_PATHS.mirrors, { version: cfg.version || 1, ...cfg, mirrors: cfg.mirrors });
    return mirror;
}

/**
 * Who this daemon is towards a hub. A device token is minted for one device
 * id, so when remotes.json holds one, THAT id is the identity (the hub rejects
 * status reports under any other); device.json is the fallback for
 * user/API tokens, then a stable host-derived id.
 */
export function deviceIdentity(hub = null) {
    const rec = readJson(EDGE_PATHS.device, null);
    const name = process.env.CANVAS_DEVICE_NAME || rec?.hostname || os.hostname();
    if (hub?.deviceId) return { deviceId: String(hub.deviceId), deviceName: name };
    // A container's hostname is random per run: pin the identity explicitly.
    if (process.env.CANVAS_DEVICE_ID) return { deviceId: String(process.env.CANVAS_DEVICE_ID).replace(/[^a-zA-Z0-9._-]+/g, '-'), deviceName: name };
    if (rec?.deviceId) return { deviceId: String(rec.deviceId), deviceName: name };
    return { deviceId: `host-${os.hostname()}-${os.userInfo().username}`.replace(/[^a-zA-Z0-9._-]+/g, '-'), deviceName: name };
}

/*
 * An env-seeded remote starts with a user/API token. The hub keys mirror
 * status (and replica protection) by DEVICE, so on first contact the daemon
 * registers itself (`POST /auth/devices/register`) under its CANVAS_DEVICE_ID
 * and keeps the device token in remotes.json; from then on hubFor() presents
 * that token and the hub sees one stable device. CLI-managed remotes already
 * carry a device token and are left alone.
 */
export async function ensureDeviceToken(remoteId, { logger = null } = {}) {
    const remotes = readJson(EDGE_PATHS.remotes, {}) || {};
    const r = remotes[remoteId];
    if (!r?.url || r.source !== 'env' || r.device?.token || !r.auth?.token) return hubFor(remoteId);
    const identity = deviceIdentity(null);
    const paired = await EdgeClient.pair({
        serverUrl: r.url, tls: resolveTls(r.tls), userToken: r.auth.token, name: identity.deviceName, type: 'edge',
        deviceId: identity.deviceId, hostname: os.hostname(), platform: process.platform, arch: process.arch,
    });
    remotes[remoteId] = { ...r, device: { deviceId: paired.deviceId || identity.deviceId, token: paired.token, registeredAt: new Date().toISOString() } };
    writeJson(EDGE_PATHS.remotes, remotes);
    logger?.info?.({ remote: remoteId, deviceId: remotes[remoteId].device.deviceId }, 'registered as a device on the hub');
    return hubFor(remoteId);
}

/** Hub url + token (+ the device id the token belongs to) for a remote id. */
export function hubFor(remoteId) {
    const remotes = readJson(EDGE_PATHS.remotes, {}) || {};
    const r = remotes[remoteId];
    if (!r?.url) return null;
    const deviceToken = r.device?.token || null;
    const token = deviceToken || r.auth?.token || null;
    return {
        id: remoteId,
        url: String(r.url).replace(/\/+$/, ''),
        tls: resolveTls(r.tls),
        apiBase: r.apiBase || '/rest/v2',
        token,
        deviceId: deviceToken && r.device?.deviceId ? String(r.device.deviceId) : null,
    };
}

/** FUSE mounts this daemon supervises: `client: 'fuse', managed: 'edge'` entries (docs/durable-workspaces.md step 5). */
export function fuseMirrors() {
    const cfg = readJson(EDGE_PATHS.mirrors, { mirrors: [] }) || {};
    return (Array.isArray(cfg.mirrors) ? cfg.mirrors : []).filter((m) => m && m.client === 'fuse' && m.managed === 'edge' && !m.paused);
}

/** Mirrors this daemon owns: `client: 'daemon'` entries of the CLI's mirrors.json. */
export function daemonMirrors() {
    const cfg = readJson(EDGE_PATHS.mirrors, { mirrors: [] }) || {};
    return (Array.isArray(cfg.mirrors) ? cfg.mirrors : [])
        .filter((m) => m && m.client === 'daemon' && !m.paused)
        .map((m) => ({ ...m, stateDir: resolveStateDir(m) }));
}
