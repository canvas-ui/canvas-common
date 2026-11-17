'use strict';

import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { EDGE_PATHS, STATE_ROOT, daemonMirrors, deviceIdentity, edgeShares, ensureDeviceToken, ensureEnvConfig, ensureEnvShare, fuseMirrors, hubFor } from './env.js';
import { MirrorRuntime } from './mirror-runtime.js';
import { FuseRuntime } from './fuse-runtime.js';
import { ShareRuntime } from './share-runtime.js';
import { startControl } from './control.js';

const START_RETRY_MS = 60_000;

/*
 * canvas-edge: the device-side daemon for real-folder mirrors (the non-FUSE
 * client of the sync protocol, for macOS/Windows and anyone who wants a plain
 * folder). One process per device runs every `client: 'daemon'` mirror from
 * ~/.canvas/config/mirrors.json; the CLI (`canvas mirror`) writes that file and
 * talks to this process over the control socket. The same process serves the
 * shares of ~/.canvas/config/shares.json (`canvas workspace <ws> share`): local
 * folders a workspace lists and reads in place.
 */
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info ', 40: 'warn ', 50: 'error', 60: 'fatal' };

// One pino JSON line as `HH:MM:SS level message  key=value …`.
function readable(line) {
    let entry;
    try { entry = JSON.parse(line); } catch { return line; }
    const { level, time, msg, pid, hostname, ...fields } = entry;
    const rest = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' ');
    return `${new Date(time).toTimeString().slice(0, 8)} ${LEVELS[level] || level} ${msg || ''}${rest ? `  ${rest}` : ''}\n`;
}

export async function main(argv = process.argv.slice(2)) {
    const foreground = argv.includes('--foreground') || argv.includes('-f');
    fs.mkdirSync(path.dirname(EDGE_PATHS.log), { recursive: true });
    const flag = argv.indexOf('--log-level');
    const level = argv.includes('--debug') ? 'debug' : (flag >= 0 && argv[flag + 1]) || process.env.LOG_LEVEL || 'info';
    // A terminal gets readable lines; a pipe (pm2, docker) and the log file get JSON.
    const logger = !foreground
        ? pino({ level }, pino.destination({ dest: EDGE_PATHS.log, sync: false }))
        : process.stdout.isTTY ? pino({ level }, { write: (line) => process.stdout.write(readable(line)) }) : pino({ level });

    const runtimes = new Map();

    // Container / env-driven setup: one remote + one mirror from the environment.
    try {
        const seeded = ensureEnvConfig();
        if (seeded) logger.info({ mirror: seeded.id, folder: seeded.mountpoint, direction: seeded.direction, stateRoot: STATE_ROOT }, 'mirror configured from environment');
    } catch (err) {
        logger.error({ err: err?.message }, 'env-driven mirror config failed');
    }
    try {
        const seeded = ensureEnvShare();
        if (seeded) logger.info({ share: seeded.id, folder: seeded.path, watch: seeded.watch }, 'share configured from environment');
    } catch (err) {
        logger.error({ err: err?.message }, 'env-driven share config failed');
    }

    // A mirror that cannot start (its drive is not mounted yet) is tried again.
    let retry = null;
    let stopping = false;
    const load = async () => {
        clearTimeout(retry);
        retry = null;
        let failed = false;
        const wanted = daemonMirrors();
        const fuse = fuseMirrors();
        const shares = edgeShares();
        const wantedIds = new Set([...wanted, ...fuse, ...shares].map((m) => m.id));
        for (const [id, rt] of runtimes) {
            if (!wantedIds.has(id)) { await rt.stop().catch(() => {}); runtimes.delete(id); logger.info({ unit: id }, 'unit stopped (removed from config)'); }
        }
        for (const mirror of wanted) {
            if (runtimes.has(mirror.id)) continue;
            let hub = hubFor(mirror.remote);
            if (!hub?.token) { logger.warn({ mirror: mirror.id, remote: mirror.remote }, 'no credentials for hub — skipped'); continue; }
            if (!hub.deviceId) {
                try { hub = await ensureDeviceToken(mirror.remote, { logger }); }
                catch (err) { logger.warn({ mirror: mirror.id, remote: mirror.remote, err: err?.message }, 'device registration failed — reporting under the user token'); }
            }
            const identity = deviceIdentity(hub);
            const rt = new MirrorRuntime({ mirror, hub, identity, logger });
            try {
                await rt.start();
                runtimes.set(mirror.id, rt);
            } catch (err) {
                failed = true;
                await rt.stop().catch(() => {});
                logger.error({ mirror: mirror.id, err: err?.message }, 'mirror failed to start');
            }
        }
        // fuse units: canvas-fuse mounts this daemon supervises (one process per workspace).
        for (const mirror of fuse) {
            if (runtimes.has(mirror.id)) continue;
            const rt = new FuseRuntime({ mirror, logger });
            try {
                await rt.start();
                runtimes.set(mirror.id, rt);
            } catch (err) {
                logger.error({ unit: mirror.id, err: err?.message }, 'fuse unit failed to start');
            }
        }
        // share units: local folders served to a workspace. One whose drive is
        // not plugged in yet has nothing to bind to and is tried again.
        for (const share of shares) {
            if (runtimes.has(share.id)) continue;
            let hub = hubFor(share.remote);
            if (!hub?.token) { logger.warn({ share: share.id, remote: share.remote }, 'no credentials for hub — skipped'); continue; }
            if (!hub.deviceId) {
                try { hub = await ensureDeviceToken(share.remote, { logger }); }
                catch (err) { logger.warn({ share: share.id, remote: share.remote, err: err?.message }, 'device registration failed — serving under the user token'); }
            }
            const refresh = () => { const current = hubFor(share.remote); return { hub: current, identity: deviceIdentity(current) }; };
            const rt = new ShareRuntime({ share, hub, identity: deviceIdentity(hub), logger, refresh });
            try {
                await rt.start();
                runtimes.set(share.id, rt);
            } catch (err) {
                failed = true;
                await rt.stop().catch(() => {});
                logger.error({ share: share.id, err: err?.message }, 'share failed to start');
            }
        }
        if (failed && !stopping) {
            retry = setTimeout(() => load().catch((err) => logger.error({ err: err?.message }, 'reload failed')), START_RETRY_MS);
            retry.unref?.();
        }
    };

    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        logger.info('shutting down');
        for (const rt of runtimes.values()) await rt.stop().catch(() => {});
        await control?.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', () => load().catch((err) => logger.error({ err: err?.message }, 'reload failed')));

    const control = await startControl({ runtimes, reload: load, shutdown, logger });
    await load();
    const count = (unit) => [...runtimes.values()].filter((r) => r.unit === unit).length;
    logger.info({ device: deviceIdentity().deviceId, mirrors: runtimes.size - count('fuse') - count('share'), fuse: count('fuse'), shares: count('share') }, 'canvas-edge running');
}
