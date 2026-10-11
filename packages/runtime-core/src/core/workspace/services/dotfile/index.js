'use strict';

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import EventEmitter from 'eventemitter2';
import { createLogger } from '../../../../utils/log.js';
import WorkspaceGitRepo from '../../lib/WorkspaceGitRepo.js';
import { enabledName } from '../hook/naming.js';

const logger = createLogger('dotfile-manager');
const TEMPLATE_DIRNAME = 'files';
const SEED_PATHSPECS = ['hooks/', 'scripts/'];
// Seed files that are documentation: backfill refreshes these in place when
// the shipped copy changed (unlike hooks/scripts, which are never overwritten).
const DOC_SEED_FILES = new Set([path.join('hooks', 'README.md')]);

function getModuleDir() {
    // fileURLToPath, not URL.pathname: the latter leaves percent-encoding in
    // place, breaking installs whose path contains spaces.
    return path.dirname(fileURLToPath(import.meta.url));
}

async function copyTemplateInto(targetDir) {
    const templateRoot = path.resolve(getModuleDir(), TEMPLATE_DIRNAME);
    await fsPromises.mkdir(targetDir, { recursive: true });
    const gitignoreSrc = path.join(templateRoot, '.gitignore');
    if (existsSync(gitignoreSrc)) {
        await fsPromises.copyFile(gitignoreSrc, path.join(targetDir, '.gitignore'));
    }
    const dotDirSrc = path.join(templateRoot, '.dot');
    if (existsSync(dotDirSrc)) {
        await fsPromises.cp(dotDirSrc, path.join(targetDir, '.dot'), { recursive: true, force: true });
    }
}

function getSeedRoot() {
    return path.resolve(getModuleDir(), TEMPLATE_DIRNAME, 'seed');
}

async function chmodSeedScripts(workDir) {
    const scriptsDir = path.join(workDir, 'scripts');
    if (!existsSync(scriptsDir)) return;
    for (const entry of await fsPromises.readdir(scriptsDir)) {
        if (!entry.endsWith('.sh')) continue;
        try { await fsPromises.chmod(path.join(scriptsDir, entry), 0o755); } catch (_) { /* intentionally ignored */ }
    }
}

// Copies the seed `hooks/` and `scripts/` into a fresh repo work tree.
async function copySeedInto(workDir) {
    const seedRoot = getSeedRoot();
    if (!existsSync(seedRoot)) return;
    await fsPromises.cp(seedRoot, workDir, { recursive: true, force: true });
    await chmodSeedScripts(workDir);
}

async function listFilesRecursive(root, base = root) {
    const out = [];
    for (const entry of await fsPromises.readdir(root, { withFileTypes: true })) {
        const abs = path.join(root, entry.name);
        if (entry.isDirectory()) { out.push(...await listFilesRecursive(abs, base)); }
        else if (entry.isFile()) { out.push(path.relative(base, abs)); }
    }
    return out;
}

/**
 * DotfileManager
 *
 * Owns the internal Git repository service: seeding and the public API.
 * All Git mechanics live in
 * WorkspaceGitRepo; this class only orchestrates and emits service events.
 */
class DotfileManager extends EventEmitter {
    #backfilledWorkspaces = new Set();

    constructor(options = {}) {
        super();
        this.workspaceManager = options.workspaceManager;
        if (!this.workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
        logger.debug('DotfileManager initialized');
    }

    async initialize() {
        return this;
    }

    #getGitDir(workspace) {
        // Layout-aware (Git/internal or .workspace/Git/internal), honours a remapped
        // services.git.root.
        return workspace.gitInternalPath;
    }

    #repo(workspace) {
        return new WorkspaceGitRepo({ repoPath: this.#getGitDir(workspace), logger });
    }

    async #resolveWorkspace(workspaceIdOrObject, requestingUserId) {
        if (typeof workspaceIdOrObject === 'object' && workspaceIdOrObject.id) {
            return workspaceIdOrObject;
        }
        const workspace = await this.workspaceManager.getWorkspace(workspaceIdOrObject, requestingUserId);
        if (!workspace) {
            throw new Error(`Workspace ${workspaceIdOrObject} not found or access denied`);
        }
        return workspace;
    }

    async hasRepository(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        return this.#repo(workspace).exists();
    }

    async enable(workspace, userId) {
        if (!workspace?.id) throw new Error('Invalid workspace');

        const repoPath = this.#repo(workspace).gitDir;
        const hasRepo = existsSync(repoPath);

        if (!hasRepo) {
            await this.initializeRepository(userId, workspace, userId);
        } else {
            await this.backfillSeed(workspace, userId).catch((err) =>
                logger.debug(`Seed backfill failed for workspace ${workspace.id}: ${err.message}`));
        }

        this.emit('dotfiles.enabled', { workspaceId: workspace.id, path: repoPath });
        logger.debug(`Git service enabled for workspace ${workspace.id}`);
        return { success: true, path: repoPath, initialized: !hasRepo };
    }

    async disable(workspace) {
        if (!workspace?.id) return { success: true };
        this.emit('dotfiles.disabled', { workspaceId: workspace.id });
        return { success: true };
    }

    isEnabled(workspace) {
        if (!workspace?.rootPath) return false;
        return existsSync(this.#repo(workspace).gitDir);
    }

    async initializeRepository(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        const repo = this.#repo(workspace);
        const repoPath = repo.gitDir;

        await fsPromises.mkdir(workspace.hooksPath, { recursive: true });

        const { created } = await repo.init();
        if (!created && await repo.hasCommits()) {
            this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
            return { success: true, message: 'Repository already initialized', path: repoPath };
        }

        const tmpWorkDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'canvas-git-'));
        try {
            const dotfilesDir = path.join(tmpWorkDir, 'dotfiles');
            await copyTemplateInto(dotfilesDir);

            const encIndexPath = path.join(dotfilesDir, '.dot', 'encrypted.index');
            await fsPromises.mkdir(path.dirname(encIndexPath), { recursive: true });
            if (!existsSync(encIndexPath)) {
                await fsPromises.writeFile(encIndexPath, '');
            }

            await copySeedInto(tmpWorkDir);
            await repo.pushSeed(tmpWorkDir, 'Initialize Canvas workspace git repository');
        } finally {
            try { await fsPromises.rm(tmpWorkDir, { recursive: true, force: true }); } catch (_) { /* intentionally ignored */ }
        }

        if (workspace.addBackend) await workspace.addBackend('git', { address: 'internal' });
        this.emit('repository.initialized', { userId, workspace: workspace.id, path: repoPath });
        return { success: true, message: 'Repository initialized successfully', path: repoPath };
    }

    // Copy seed example hooks/scripts a workspace is missing into its work
    // tree. Seeding normally happens only when the git repo is first
    // initialized, so workspaces created before an example existed never get
    // it — this backfills them, never overwriting anything: a seed file is
    // skipped when its directory already holds a file with the same enabled
    // name (so a user's renamed/enabled `youtube.js` blocks
    // `example-youtube.js` from reappearing). Runs once per workspace per
    // process; called lazily from the hooks REST listing and from enable().
    async backfillSeed(workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        if (this.#backfilledWorkspaces.has(workspace.id)) {
            return { success: true, added: [] };
        }
        this.#backfilledWorkspaces.add(workspace.id);

        const seedRoot = getSeedRoot();
        if (!existsSync(seedRoot)) { return { success: true, added: [] }; }

        const gitDir = this.#getGitDir(workspace);
        const added = [];
        for (const relPath of await listFilesRecursive(seedRoot)) {
            const targetDir = path.join(gitDir, path.dirname(relPath));
            const seedBase = path.basename(relPath);
            const seedName = enabledName(seedBase);

            let blocked = false;
            if (existsSync(targetDir)) {
                const existing = await fsPromises.readdir(targetDir);
                blocked = existing.some((name) => enabledName(name) === seedName);
            }
            // Documentation files are refreshed in place when the shipped copy
            // changed — the README documents the hook/rules/context API and
            // must not go stale in long-lived workspaces. The overwrite is a
            // committed git change, so a user edit stays recoverable.
            if (blocked && DOC_SEED_FILES.has(relPath)) {
                const target = path.join(targetDir, seedBase);
                if (existsSync(target)) {
                    const [seedContent, targetContent] = await Promise.all([
                        fsPromises.readFile(path.join(seedRoot, relPath), 'utf8'),
                        fsPromises.readFile(target, 'utf8'),
                    ]);
                    if (seedContent !== targetContent) {
                        await fsPromises.writeFile(target, seedContent, 'utf8');
                        added.push(relPath);
                    }
                }
                continue;
            }
            if (blocked) { continue; }

            await fsPromises.mkdir(targetDir, { recursive: true });
            await fsPromises.copyFile(path.join(seedRoot, relPath), path.join(targetDir, seedBase));
            added.push(relPath);
        }

        if (added.length > 0) {
            await chmodSeedScripts(gitDir);
            await this.#repo(workspace).commitWorkTree(SEED_PATHSPECS, `Backfill ${added.length} seed example file(s)`);
            logger.debug(`Backfilled ${added.length} seed file(s) into workspace ${workspace.id}`);
        }
        return { success: true, added };
    }

    // Commit web UI hook edits so Git clients receive them on clone or pull.
    // No-op when Git is not enabled for the workspace.
    async commitHooks(workspaceIdOrObject, message = 'Update workspace hooks', requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        return this.#repo(workspace).commitWorkTree('hooks/', message);
    }

    // Same persistence contract for Git/internal/scripts (the helpers hooks spawn).
    async commitScripts(workspaceIdOrObject, message = 'Update workspace scripts', requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        return this.#repo(workspace).commitWorkTree('scripts/', message);
    }

    async getRepositoryStatus(userId, workspaceIdOrObject, requestingUserId) {
        const workspace = await this.#resolveWorkspace(workspaceIdOrObject, requestingUserId);
        const repo = this.#repo(workspace);

        if (!repo.exists()) {
            return { initialized: false, path: repo.gitDir };
        }

        const { branches, currentBranch } = await repo.status();
        return { initialized: true, path: repo.gitDir, branches, currentBranch, bare: false };
    }
}

export default DotfileManager;
