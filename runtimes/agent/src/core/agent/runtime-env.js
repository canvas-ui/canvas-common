'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';
import { writePrivateFile } from '../../utils/private-file.js';

// Each named connection has an independently scoped token. The JSON array is
// transported intact to local, child-process and remote agent runtimes.

const CANVAS_ENV_FILENAME = 'canvas.env';

function canvasEnvPath(rootPath) {
    return path.join(rootPath, 'runtime', CANVAS_ENV_FILENAME);
}

function serializeEnv(env) {
    return Object.entries(env)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
}

function parseEnv(content) {
    const env = {};
    for (const line of String(content).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;
        env[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim();
    }
    return env;
}

export function buildAgentRuntimeEnv({ agentId, connections, apiBaseUrl }) {
    if (!agentId || !apiBaseUrl || !connections?.length) return null;
    return { CANVAS_URL: apiBaseUrl, CANVAS_AGENT_ID: agentId, CANVAS_CONNECTIONS: JSON.stringify(connections) };
}

/**
 * Persist the env map to {rootPath}/runtime/canvas.env (0600).
 */
export async function persistAgentRuntimeEnv(rootPath, env) {
    const filePath = canvasEnvPath(rootPath);
    await writePrivateFile(filePath, serializeEnv(env));
    return filePath;
}

/**
 * Load a previously persisted env map. Returns null when absent/unreadable.
 */
export async function loadAgentRuntimeEnv(rootPath) {
    try {
        const content = await fsPromises.readFile(canvasEnvPath(rootPath), 'utf8');
        const env = parseEnv(content);
        return env.CANVAS_CONNECTIONS ? env : null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export async function removeAgentRuntimeEnv(rootPath) {
    await fsPromises.rm(canvasEnvPath(rootPath), { force: true });
}
