'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes for files that hold credentials or other secrets: the directory is
 * created 0700, the bytes go to a 0600 temp file that is renamed over the
 * target, so the result is 0600 whatever mode an earlier file had.
 */

let sequence = 0;
const tempFor = (file) => `${file}.${process.pid}.${sequence++}.tmp`;

function writePrivateFileSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = tempFor(file);
    try {
        fs.writeFileSync(temp, data, { mode: 0o600 });
        fs.renameSync(temp, file);
    } catch (err) {
        fs.rmSync(temp, { force: true });
        throw err;
    }
}

export async function writePrivateFile(file, data) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = tempFor(file);
    try {
        await fs.promises.writeFile(temp, data, { mode: 0o600 });
        await fs.promises.rename(temp, file);
    } catch (err) {
        await fs.promises.rm(temp, { force: true });
        throw err;
    }
}

export const writePrivateJsonSync = (file, value) => writePrivateFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const writePrivateJson = (file, value) => writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
