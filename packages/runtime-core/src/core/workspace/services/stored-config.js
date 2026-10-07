import fs from 'node:fs/promises';
import path from 'node:path';

/** The workspace's mail + connector accounts (`<configDir>/stored.json`). */
export async function readStoredConfig(configDir) {
    try {
        return JSON.parse(await fs.readFile(path.join(configDir, 'stored.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { backends: {} };
        throw error;
    }
}
