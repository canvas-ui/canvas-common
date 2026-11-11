'use strict';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Where the binding id lives inside a mirrored folder. */
export const BINDING_FILE = '.workspace/binding';

/**
 * The id shared by a mirrored folder and its sync history (`stateDir`),
 * created on first start. History is refused for a folder that does not carry
 * the id, and for an empty folder when history exists but predates bindings:
 * both are what an unmounted drive looks like.
 */
export function bindFolder(folder, stateDir, hadHistory) {
    const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; } };
    const marker = path.join(folder, BINDING_FILE);
    const record = path.join(stateDir, 'binding');
    const known = read(record);
    if (known) {
        if (read(marker) !== known) throw new Error(`${folder} is not the folder this mirror's sync history belongs to (drive not mounted, or the folder was replaced); nothing was synced. Mount it, or remove ${stateDir} to start the mirror from scratch`);
        return known;
    }
    const empty = !fs.existsSync(folder) || fs.readdirSync(folder).every((name) => name.startsWith('.'));
    if (hadHistory && empty) throw new Error(`${folder} is empty but ${stateDir} holds sync history for it (drive not mounted?); nothing was synced. Mount it, or remove ${stateDir} to start the mirror from scratch`);
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, `${id}\n`);
    fs.writeFileSync(record, `${id}\n`);
    return id;
}
