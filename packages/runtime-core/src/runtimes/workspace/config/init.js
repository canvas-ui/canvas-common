'use strict';

import path from 'node:path';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import Conf from 'conf';
import randomcolor from 'randomcolor';
import { v4 as uuidv4 } from 'uuid';

import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DEFAULT_HOST,
    WORKSPACE_LAYOUTS,
    normalizeWorkspaceLayout,
    workspaceDirectories,
    workspaceInternals,
    workspaceServices,
    workspaceStoredDefault,
} from './constants.js';
import { findWorkspaceConfigPath, workspaceConfigPathFor } from './discovery.js';
import { portableWorkspaceConfig } from './portable-config.js';

/** `<owner>@<host>:<name><path>`, the address a workspace is known by. */
export function constructWorkspaceReference(userIdentifier, workspaceSlug, host = WORKSPACE_DEFAULT_HOST, path = '') {
    if (!userIdentifier || !workspaceSlug) {
        throw new Error('userIdentifier and workspaceSlug are required to construct a workspace reference.');
    }
    return `${userIdentifier}@${host}:${workspaceSlug}${path}`;
}

/** The lowercase identity form of a workspace name. */
export function sanitizeWorkspaceName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9-_]/g, '');
}

/**
 * Make `workspaceDir` a workspace: its layout directories and workspace.json.
 * A `home`-layout workspace may wrap a folder the user already has (only a
 * `.workspace/` dir is added); `full` would scatter home/, db/, data/ … through
 * existing files, so it requires a new folder.
 * @returns {Promise<Object>} the workspace config (with rootPath/configPath)
 */
export async function initializeWorkspaceFolder(workspaceDir, { name, owner, host = WORKSPACE_DEFAULT_HOST, ...options } = {}) {
    if (!workspaceDir || !name || !owner) throw new Error('A folder, name and owner are required');
    const sanitizedName = sanitizeWorkspaceName(name);
    const layout = normalizeWorkspaceLayout(options.layout);

    if (existsSync(workspaceDir)) {
        if (findWorkspaceConfigPath(workspaceDir)) throw new Error(`Directory is already a workspace: ${workspaceDir}`);
        if (layout !== WORKSPACE_LAYOUTS.HOME) throw new Error(`Workspace directory already exists: ${workspaceDir}`);
    }
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    const directories = workspaceDirectories(layout);
    for (const key in directories) {
        await fsPromises.mkdir(path.join(workspaceDir, directories[key]), { recursive: true });
    }

    const configPath = workspaceConfigPathFor(workspaceDir, layout);
    const now = new Date().toISOString();
    const config = {
        id: uuidv4(),
        name: sanitizedName,
        label: options.label || sanitizedName,
        // Folder structure: fixed at creation, drives the internals/services
        // defaults below and where workspace.json itself lives.
        layout,
        description: options.description || '',
        owner,
        color: options.color || randomcolor(),
        icon: options.icon || null,
        order: Number.isFinite(options.order) ? options.order : null,
        homeScreen: options.homeScreen || {},
        type: options.type || 'workspace',
        status: WORKSPACE_STATUS_CODES.AVAILABLE,
        rootPath: workspaceDir,
        configPath,
        host,
        reference: constructWorkspaceReference(owner, sanitizedName, host),
        createdAt: now,
        updatedAt: now,
        metadata: options.metadata || {},
        acl: options.acl || { tokens: {}, users: {} },
        internals: { ...workspaceInternals(layout) },
        // services.stored carries the storage config (root/cache/sync/backends);
        // the layout builders already return fresh (deep-cloned) objects.
        services: options.services || {
            ...workspaceServices(layout),
            stored: {
                ...workspaceStoredDefault(layout),
                ...(options.dataBackends ? { backends: options.dataBackends } : {}),
            },
        },
        links: options.links || {},
    };

    // In `.workspace/` for the home layout, hence dirname, not workspaceDir.
    const conf = new Conf({ configFileMode: 0o600, configName: path.basename(configPath, '.json'), cwd: path.dirname(configPath), accessPropertiesByDotNotation: false });
    conf.store = portableWorkspaceConfig(config);
    return config;
}
