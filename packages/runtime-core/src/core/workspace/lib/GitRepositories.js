import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function git(cwd, args, { binary = false } = {}) {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
}
export function repoName(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith('.lock')) {
        throw Object.assign(new Error('Repository name must be a single alphanumeric, dot, underscore or dash segment'), { statusCode: 400 });
    }
    return name;
}
// DirectoryTree normalizes Unicode, punctuation and case. Escape every byte
// outside lowercase ASCII so distinct Git names cannot collapse into one node.
export const gitSegment = value => [...Buffer.from(value)].map(byte => {
    const char = String.fromCharCode(byte);
    return /[a-z0-9.-]/.test(char) ? char : `+${byte.toString(16).padStart(2, '0')}`;
}).join('');
export const decodeGitSegment = value => decodeURIComponent(value.replace(/\+([a-f0-9]{2})/g, '%$1'));
export function gitTreePath(repo, branch = null, folder = '') {
    return `/workspace/git/${gitSegment(repoName(repo))}${branch === null ? '' : `/${gitSegment(branch)}`}${folder ? '/' + folder.split('/').map(gitSegment).join('/') : ''}`;
}
export function gitLocation(repo, branch, file) {
    return `canvas-git://${repoName(repo)}/${encodeURIComponent(branch)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
export function parseGitLocation(url) {
    const match = /^canvas-git:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(url || '');
    if (!match) return null;
    return { repo: repoName(match[1]), branch: decodeURIComponent(match[2]), file: match[3].split('/').map(decodeURIComponent).join('/') };
}

export default class GitRepositories {
    constructor(root) { this.root = root; }
    repoPath(name) { return path.join(this.root, repoName(name)); }
    async checkedPath(name) {
        const dir = this.repoPath(name);
        // Never follow a repository or .git symlink outside the workspace.
        for (const target of [dir, path.join(dir, '.git')]) {
            if (!(await fs.lstat(target)).isDirectory()) throw new Error('Repository and .git must be local directories');
        }
        return dir;
    }
    async list() {
        const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
        const repos = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            try {
                const dir = await this.checkedPath(entry.name);
                const remote = (await git(dir, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
                repos.push({ name: entry.name, type: remote ? 'remote' : 'local' });
            } catch { /* unrelated folders are not repositories */ }
        }
        return repos;
    }
    async create(name, { url } = {}) {
        if (name === 'internal' && url) throw new Error('internal is reserved for the local workspace repository');
        const dir = this.repoPath(name);
        await fs.mkdir(this.root, { recursive: true });
        // Exclusive reservation prevents two clone/init requests sharing a target.
        await fs.mkdir(dir);
        try {
            if (url) {
                // Support HTTPS, SSH URLs and scp-style SSH. No local-file or executable helpers.
                if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|[^\s/@:]+@[^\s/:]+:)/.test(url)) throw new Error('Use an HTTP(S), SSH or Git protocol URL');
                if (/^https?:/.test(url) && (new URL(url).password || new URL(url).username)) throw new Error('Use a credential helper rather than a password in the URL');
                await git(this.root, ['clone', '--', url, dir]);
            } else {
                await git(dir, ['init', '--initial-branch=main']);
                await git(dir, ['config', 'receive.denyCurrentBranch', 'updateInstead']);
            }
        } catch (error) {
            await fs.rm(dir, { recursive: true, force: true });
            throw error;
        }
        return { name, type: url ? 'remote' : 'local' };
    }
    async branches(name, { fetch = false } = {}) {
        const dir = await this.checkedPath(name);
        const remote = (await git(dir, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
        if (fetch && remote) await git(dir, ['fetch', '--prune', 'origin']);
        const refs = await git(dir, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', 'refs/heads/', 'refs/remotes/origin/']);
        const branches = new Map();
        for (const row of refs.trim().split('\n').filter(Boolean)) {
            const [ref, oid, symbolic] = row.split('\t');
            if (symbolic) continue;
            const branch = ref.replace(/^refs\/(heads\/|remotes\/origin\/)/, '');
            // Follow upstream only when it contains the local tip. Preserve
            // local feature commits and diverged work without checking anything out.
            const local = branches.get(branch);
            if (local && local.oid !== oid) {
                const behind = await git(dir, ['merge-base', '--is-ancestor', local.oid, oid]).then(() => true, () => false);
                if (!behind) continue;
            }
            branches.set(branch, { id: branch, name: branch, ref, oid, writable: false });
        }
        return [...branches.values()];
    }
    async entries(name, oid) {
        if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git object ID');
        const raw = await git(await this.checkedPath(name), ['ls-tree', '-rlz', oid]);
        return raw.split('\0').filter(Boolean).flatMap(row => {
            const split = row.indexOf('\t');
            const [mode, type, blob, size] = row.slice(0, split).trim().split(/\s+/);
            const file = row.slice(split + 1);
            if (file.startsWith('/') || file.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe Git tree path');
            // Symlinks and submodules are never followed or indexed as files.
            return type === 'blob' && mode !== '120000' ? [{ file, oid: blob, size: Number(size) }] : [];
        });
    }
    async readBlob(name, oid) {
        if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git blob ID');
        return git(await this.checkedPath(name), ['cat-file', 'blob', oid], { binary: true });
    }
    async read(name, branch, file) {
        const container = (await this.branches(name)).find(b => b.id === branch);
        if (!container) throw Object.assign(new Error('Git branch not found'), { statusCode: 404 });
        const entry = (await this.entries(name, container.oid)).find(e => e.file === file);
        if (!entry) throw Object.assign(new Error('Git file not found'), { statusCode: 404 });
        return this.readBlob(name, entry.oid);
    }
}
