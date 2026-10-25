'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';

import { WORKSPACE_CONFIG_FILENAME, WORKSPACE_INTERNAL_DIRNAME, WORKSPACE_LAYOUTS } from './constants.js';

/**
 * Where a workspace's config file lives for a given layout:
 *   full — <dir>/workspace.json
 *   home — <dir>/.workspace/workspace.json  (the root belongs to the user)
 */
function workspaceConfigPathFor(dir, layout) {
    return layout === WORKSPACE_LAYOUTS.HOME
        ? path.join(dir, WORKSPACE_INTERNAL_DIRNAME, WORKSPACE_CONFIG_FILENAME)
        : path.join(dir, WORKSPACE_CONFIG_FILENAME);
}

// Where a folder can declare itself a workspace, in precedence order. Only a
// bare `<dir>/workspace.json` means the `full` layout; every other location
// keeps the root as the user's own folder (`home` layout).
const WORKSPACE_CONFIG_LOCATIONS = [
    [WORKSPACE_INTERNAL_DIRNAME, 'config', WORKSPACE_CONFIG_FILENAME],
    [WORKSPACE_INTERNAL_DIRNAME, WORKSPACE_CONFIG_FILENAME],
    [`.${WORKSPACE_CONFIG_FILENAME}`],
    [WORKSPACE_CONFIG_FILENAME],
];

/** Absolute path of the workspace config in `dir`, or null. */
function findWorkspaceConfigPath(dir) {
    for (const parts of WORKSPACE_CONFIG_LOCATIONS) {
        const candidate = path.join(dir, ...parts);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function layoutForConfigPath(dir, configPath) {
    return path.resolve(configPath) === path.join(path.resolve(dir), WORKSPACE_CONFIG_FILENAME)
        ? WORKSPACE_LAYOUTS.FULL
        : WORKSPACE_LAYOUTS.HOME;
}

/**
 * Workspace discovery — filesystem side only. Walks the immediate
 * subdirectories of the given roots and returns every directory holding a
 * parseable workspace config, whatever the folder is called. Adoption, collision handling and index writes
 * happen in WorkspaceManager; this module never mutates anything.
 */

// Minimum to count as a workspace: an object carrying an id or a name.
// Registration assigns a fresh id and falls back to the folder name.
function validateWorkspaceConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'not an object';
    for (const key of ['id', 'name']) {
        if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key])) return `invalid ${key}`;
    }
    if (!config.id && !config.name) return 'missing id and name';
    return null;
}

/**
 * @param {string[]} roots - directories whose children are workspace candidates
 * @returns {Promise<{candidates: Array<{dir, configPath, config}>, skipped: Array<{dir, reason}>}>}
 */
async function discoverWorkspaceCandidates(roots) {
    const candidates = [];
    const skipped = [];
    const seenDirs = new Set();

    for (const root of roots) {
        if (!root || !existsSync(root)) continue;

        let dirents;
        let realRoot;
        try {
            realRoot = await fsPromises.realpath(root);
            dirents = await fsPromises.readdir(root, { withFileTypes: true });
        } catch (err) {
            skipped.push({ dir: root, reason: `unreadable root: ${err.message}` });
            continue;
        }

        for (const dirent of dirents) {
            if (dirent.name.startsWith('.')) continue; // import staging / runtime directories
            if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;

            const dir = path.join(root, dirent.name);
            let realDir;
            try {
                realDir = await fsPromises.realpath(dir);
            } catch {
                continue; // broken symlink
            }
            if (seenDirs.has(realDir)) continue;
            // A symlink to somebody else's workspace is not an ownership transfer.
            if (path.dirname(realDir) !== realRoot) continue;

            const configPath = findWorkspaceConfigPath(dir);
            if (!configPath) continue;

            let config;
            try {
                config = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
            } catch (err) {
                skipped.push({ dir, reason: `invalid ${path.basename(configPath)}: ${err.message}` });
                continue;
            }

            const invalid = validateWorkspaceConfig(config);
            if (invalid) {
                skipped.push({ dir, reason: `invalid ${path.basename(configPath)}: ${invalid}` });
                continue;
            }

            seenDirs.add(realDir);
            candidates.push({ dir, configPath, config });
        }
    }

    return { candidates, skipped };
}

export { discoverWorkspaceCandidates, layoutForConfigPath, validateWorkspaceConfig, findWorkspaceConfigPath, workspaceConfigPathFor };
