'use strict';

import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { spawn } from 'child_process';
import { createLogger } from '../../../utils/log.js';

const defaultLogger = createLogger('workspace-git-repo');

const COMMIT_IDENTITY = ['-c', 'user.name=canvas-server', '-c', 'user.email=noreply@canvas.local'];

function spawnPromise(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
        let stdout = '';
        let stderr = '';
        if (child.stdout) child.stdout.on('data', (d) => (stdout += d.toString()));
        if (child.stderr) child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        });
        child.on('error', reject);
    });
}

/**
 * Smart HTTP and hook commits for a checked-out workspace repository.
 * Git's updateInstead receive policy updates the work tree only when clean.
 */
export class WorkspaceGitRepo {
    #gitDir;
    #repoPath;
    #logger;

    constructor({ repoPath, logger } = {}) {
        if (!repoPath) throw new Error('repoPath is required');
        this.#repoPath = repoPath;
        this.#gitDir = path.join(repoPath, '.git');
        this.#logger = logger || defaultLogger;
    }

    get gitDir() { return this.#gitDir; }

    exists() {
        return existsSync(this.#gitDir);
    }

    // True once the repo carries at least one ref (i.e. has been seeded).
    async hasCommits() {
        try {
            const { stdout } = await spawnPromise('git', ['show-ref'], { cwd: this.#gitDir });
            return Boolean(stdout?.trim());
        } catch {
            return false;
        }
    }

    async init() {
        if (existsSync(this.#gitDir)) return { created: false };
        await fsPromises.mkdir(this.#repoPath, { recursive: true });
        await spawnPromise('git', ['init', '--initial-branch=main'], { cwd: this.#repoPath });
        await spawnPromise('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: this.#repoPath });
        return { created: true };
    }

    // Commit an already-populated work directory and push it to the repository as
    // the initial `main`. The caller owns what goes into `workDir`.
    async pushSeed(workDir, message) {
        await spawnPromise('git', ['init', '--initial-branch=main'], { cwd: workDir });
        await spawnPromise('git', ['add', '.'], { cwd: workDir });
        await spawnPromise('git', ['config', 'user.name', 'canvas-server'], { cwd: workDir });
        await spawnPromise('git', ['config', 'user.email', 'noreply@canvas.local'], { cwd: workDir });
        await spawnPromise('git', ['commit', '-m', message], { cwd: workDir });
        await spawnPromise('git', ['remote', 'add', 'origin', this.#gitDir], { cwd: workDir });
        await spawnPromise('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });
    }

    // Commit hook/script edits made in the work tree so clones receive them.
    // No-op when the repo does not exist.
    async commitWorkTree(pathspec, message) {
        if (!existsSync(this.#gitDir)) return { success: false, skipped: true };

        const pathspecs = Array.isArray(pathspec) ? pathspec : [pathspec];
        const repoArgs = this.#repoArgs();
        try {
            await spawnPromise('git', [...repoArgs, 'read-tree', 'HEAD']);
            await spawnPromise('git', [...repoArgs, 'add', '-A', '--', ...pathspecs]);

            // `diff --cached --quiet` exits non-zero when there are staged
            // changes; a zero exit means nothing to commit.
            try {
                await spawnPromise('git', [...repoArgs, 'diff', '--cached', '--quiet']);
                return { success: true, committed: false };
            } catch { /* staged changes present, fall through to commit */ }

            await spawnPromise('git', [...COMMIT_IDENTITY, ...repoArgs, 'commit', '-m', message]);
            return { success: true, committed: true };
        } catch (err) {
            this.#logger.debug(`commitWorkTree(${pathspec}) failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    async status() {
        let branches = [];
        let currentBranch = null;
        try {
            const { stdout } = await spawnPromise('git', [...this.#repoArgs(), 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
            branches = stdout.trim().split('\n').filter(Boolean);
            currentBranch = (await spawnPromise('git', [...this.#repoArgs(), 'symbolic-ref', '--short', 'HEAD'])).stdout.trim();
        } catch { /* no refs yet */ }
        return { branches, currentBranch };
    }

    // ── Smart-HTTP backend ──────────────────────────────────────────────────
    // Dispatch a Git smart-HTTP request; receive-pack updates the checkout.
    async serveHttp(service, request, reply) {
        if (!existsSync(this.#gitDir)) {
            // Typed so the transport can answer 404 with something actionable:
            // an uninitialized repo is a normal state (nobody has run init on
            // this workspace yet), not a server fault.
            const err = new Error('Repository not initialized');
            err.code = 'EGITNOREPO';
            throw err;
        }
        switch (service) {
            case 'info/refs':
                return this.#handleInfoRefs(request, reply);
            case 'git-upload-pack':
                return this.#handleUploadPack(request, reply);
            case 'git-receive-pack':
                return this.#streamPack('receive-pack', request, reply);
            default:
                throw new Error(`Unsupported Git service: ${service}`);
        }
    }

    #repoArgs() {
        return [`--git-dir=${this.#gitDir}`, `--work-tree=${this.#repoPath}`];
    }

    #childEnv(request, extra = {}) {
        const env = { ...process.env, GIT_HTTP_EXPORT_ALL: '1', ...extra };
        const gitProtocol = request.headers['git-protocol'];
        if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
        return env;
    }

    async #handleInfoRefs(request, reply) {
        const service = request.query.service;
        if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
            return reply.code(400).send('Invalid service');
        }

        reply.type(`application/x-${service}-advertisement`)
            .header('cache-control', 'no-cache, max-age=0, must-revalidate');

        const serviceName = service.replace('git-', '');
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', '--advertise-refs', this.#gitDir], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.#childEnv(request),
        });

        return new Promise((resolve, reject) => {
            const chunks = [];
            let totalSize = 0;
            gitProcess.stdout.on('data', (chunk) => { chunks.push(chunk); totalSize += chunk.length; });
            gitProcess.stderr.on('data', (data) => this.#logger.debug(`Git ${serviceName}: ${data.toString().trim()}`));
            gitProcess.on('error', reject);
            gitProcess.on('close', (code) => {
                if (code !== 0) { reply.code(500).send('Git process failed'); resolve(); return; }
                const refs = Buffer.concat(chunks, totalSize);
                const serviceHeader = `# service=${service}\n`;
                const headerLength = (serviceHeader.length + 4).toString(16).padStart(4, '0');
                reply.send(Buffer.concat([
                    Buffer.from(headerLength + serviceHeader),
                    Buffer.from('0000'),
                    refs,
                ]));
                resolve();
            });
            gitProcess.stdin.end();
        });
    }

    #handleUploadPack(request, reply) {
        return this.#streamPack('upload-pack', request, reply);
    }

    // Shared stateless-rpc streaming for upload-pack / receive-pack.
    #streamPack(serviceName, request, reply) {
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': `application/x-git-${serviceName}-result`,
            'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        });

        const env = this.#childEnv(request, { SSH_ORIGINAL_COMMAND: serviceName });
        const gitProcess = spawn('git', [serviceName, '--stateless-rpc', this.#gitDir], { stdio: ['pipe', 'pipe', 'pipe'], env });
        gitProcess.stdout.pipe(reply.raw, { end: false });
        gitProcess.stderr.on('data', (data) => this.#logger.debug(`Git ${serviceName}: ${data.toString().trim()}`));

        if (request.body) {
            gitProcess.stdin.write(Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body));
            gitProcess.stdin.end();
        } else {
            request.raw.pipe(gitProcess.stdin);
        }

        return new Promise((resolve, reject) => {
            gitProcess.on('error', (error) => { reply.raw.end(); reject(error); });
            gitProcess.on('close', (code) => {
                reply.raw.end();
                code !== 0 ? reject(new Error(`Git ${serviceName} failed with code ${code}`)) : resolve();
            });
        });
    }
}

export default WorkspaceGitRepo;
