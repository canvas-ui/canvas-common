import fs from 'node:fs/promises';
import path from 'node:path';
import { writePrivateJson } from '../security/WorkspaceCrypto.js';

const writes = new Map();

// Mailboxes and other connectors share one file. Lock the whole read/modify/
// write, across service instances, so concurrent checkpoints cannot lose UIDs.
export function updateStoredConfig(configDir, update, protect = value => value) {
    const key = path.resolve(configDir);
    const pending = (writes.get(key) || Promise.resolve()).then(async () => {
        const config = await readStoredConfig(key);
        config.backends ||= {};
        const result = await update(config);
        await fs.mkdir(key, { recursive: true });
        writePrivateJson(path.join(key, 'stored.json'), protect(config));
        return result;
    });
    const tail = pending.catch(() => {}).finally(() => { if (writes.get(key) === tail) writes.delete(key); });
    writes.set(key, tail);
    return pending;
}

/** The workspace's mail + connector accounts (`<configDir>/stored.json`). */
export async function readStoredConfig(configDir) {
    try {
        return JSON.parse(await fs.readFile(path.join(configDir, 'stored.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { backends: {} };
        throw error;
    }
}
