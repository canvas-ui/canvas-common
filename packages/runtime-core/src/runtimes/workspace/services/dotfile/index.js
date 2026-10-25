'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { createLogger } from '../../../../utils/log.js';
import WorkspaceGitRepo from '../git/WorkspaceGitRepo.js';
import { enabledName } from '../hooks/naming.js';

const logger = createLogger('workspace-dotfiles');
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

// Never overwrites: files already in the work tree win.
async function copyTemplateInto(targetDir) {
    const templateRoot = path.resolve(getModuleDir(), TEMPLATE_DIRNAME);
    await fsPromises.mkdir(targetDir, { recursive: true });
    const gitignoreSrc = path.join(templateRoot, '.gitignore');
    const gitignoreDst = path.join(targetDir, '.gitignore');
    if (existsSync(gitignoreSrc) && !existsSync(gitignoreDst)) {
        await fsPromises.copyFile(gitignoreSrc, gitignoreDst);
    }
    const dotDirSrc = path.join(templateRoot, '.dot');
    if (existsSync(dotDirSrc)) {
        await fsPromises.cp(dotDirSrc, path.join(targetDir, '.dot'), { recursive: true, force: false });
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
 * The workspace's internal Git repository (Git/internal): seeding, seed
 * backfill, commits of web-edited hooks/scripts, and status. Git mechanics live
 * in WorkspaceGitRepo.
 */
export default class WorkspaceDotfiles {
    #workspace;
    #backfilled = false;

    constructor(workspace) {
        this.#workspace = workspace;
    }

    // Layout-aware (Git/internal or .workspace/Git/internal), honours a remapped
    // services.git.root.
    get #repo() {
        return new WorkspaceGitRepo({ repoPath: this.#workspace.gitInternalPath, logger });
    }

    get enabled() {
        return Boolean(this.#workspace.rootPath) && existsSync(this.#repo.gitDir);
    }

    async enable() {
        const repoPath = this.#repo.gitDir;
        const hasRepo = existsSync(repoPath);
        if (!hasRepo) {
            await this.initialize();
        } else {
            await this.backfillSeed().catch((err) =>
                logger.debug(`Seed backfill failed for workspace ${this.#workspace.id}: ${err.message}`));
        }
        return { success: true, path: repoPath, initialized: !hasRepo };
    }

    async initialize() {
        const workspace = this.#workspace;
        const repo = this.#repo;
        const repoPath = repo.gitDir;

        await fsPromises.mkdir(workspace.hooksPath, { recursive: true });

        const { created } = await repo.init();
        if (!created && await repo.hasCommits()) {
            return { success: true, message: 'Repository already initialized', path: repoPath };
        }

        // Hooks and scripts written before Git was enabled stay as they are;
        // the template and the seed only fill gaps. Then commit the work tree.
        const dotfilesDir = path.join(workspace.gitInternalPath, 'dotfiles');
        await copyTemplateInto(dotfilesDir);
        const encIndexPath = path.join(dotfilesDir, '.dot', 'encrypted.index');
        await fsPromises.mkdir(path.dirname(encIndexPath), { recursive: true });
        if (!existsSync(encIndexPath)) {
            await fsPromises.writeFile(encIndexPath, '');
        }
        await this.#copyMissingSeed();
        await repo.commitAll('Initialize Canvas workspace git repository');

        if (workspace.addBackend) await workspace.addBackend('git', { address: 'internal' });
        return { success: true, message: 'Repository initialized successfully', path: repoPath };
    }

    // Copy seed example hooks/scripts the workspace is missing into its work
    // tree, so examples shipped after the repo was initialized arrive too.
    // Never overwrites anything: a seed file is skipped when its directory
    // already holds a file with the same enabled name (so a user's
    // renamed/enabled `youtube.js` blocks `example-youtube.js` from
    // reappearing). Runs once per workspace instance; called lazily from the
    // hooks REST listing and from enable().
    async backfillSeed() {
        if (this.#backfilled) { return { success: true, added: [] }; }
        this.#backfilled = true;

        const added = await this.#copyMissingSeed();
        if (added.length > 0) {
            await this.#repo.commitWorkTree(SEED_PATHSPECS, `Backfill ${added.length} seed example file(s)`);
            logger.debug(`Backfilled ${added.length} seed file(s) into workspace ${this.#workspace.id}`);
        }
        return { success: true, added };
    }

    async #copyMissingSeed() {
        const seedRoot = getSeedRoot();
        if (!existsSync(seedRoot)) { return []; }

        const gitDir = this.#workspace.gitInternalPath;
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

        if (added.length > 0) await chmodSeedScripts(gitDir);
        return added;
    }

    // Commit web UI hook edits so Git clients receive them on clone or pull.
    // No-op when Git is not enabled for the workspace.
    async commitHooks(message = 'Update workspace hooks') {
        return this.#repo.commitWorkTree('hooks/', message);
    }

    // Same persistence contract for Git/internal/scripts (the helpers hooks spawn).
    async commitScripts(message = 'Update workspace scripts') {
        return this.#repo.commitWorkTree('scripts/', message);
    }

    async status() {
        const repo = this.#repo;
        if (!repo.exists()) {
            return { initialized: false, path: repo.gitDir };
        }
        const { branches, currentBranch } = await repo.status();
        return { initialized: true, path: repo.gitDir, branches, currentBranch, bare: false };
    }
}
