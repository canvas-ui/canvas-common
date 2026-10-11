import BaseConnector from '../../BaseConnector.js';
import GitRepositories, { gitTreePath, gitLocation, repoName, git } from '../../../../lib/GitRepositories.js';
import path from 'node:path';
import { mimeFromLocations } from '../../../../lib/classifier.js';

/** Metadata-only branch mirror. Blob bytes are read only by resolveDocument. */
export default class GitConnector extends BaseConnector {
    static driver = 'git';
    static label = 'Git repository';
    static icon = 'mdi:git';
    static blurb = 'Clone a remote repository or create a local one. Browse branches without extracting or embedding unfiled files.';
    static provenanceScheme = 'canvas-git';
    static supports = { prune: true, create: false, update: false, delete: false };
    static configFields = [
        { key: 'url', label: 'Remote URL (leave empty for a local repository)', placeholder: 'git@github.com:company/repo.git' },
        { key: 'branches', label: 'Branches (empty means all)', list: true, placeholder: 'main, jira-1234/myusername-int-qf' },
        { key: 'linkBranch', label: 'Branch to link into a virtual tree', placeholder: 'main' },
        { key: 'linkPath', label: 'Source folder (empty means entire branch)', placeholder: 'docs/UI' },
        { key: 'targetTree', label: 'Destination tree', placeholder: 'context' },
        { key: 'targetPath', label: 'Destination path (empty disables the link)', placeholder: '/company/Branding/UI' },
    ];
    constructor(address, config, options = {}) {
        super(address, config, options);
        repoName(address);
        if (config.branches != null && (!Array.isArray(config.branches) || config.branches.some(b => typeof b !== 'string'))) throw new Error('branches must be an array of branch names');
        if (config.mounts != null && !Array.isArray(config.mounts)) throw new Error('mounts must be an array');
        const mappings = [...(config.mounts || [])];
        if (config.targetPath) mappings.push({ branch: config.linkBranch, sourcePath: config.linkPath, tree: config.targetTree || 'context', path: config.targetPath });
        for (const m of mappings) {
            if (!m || typeof m.branch !== 'string' || !m.branch || typeof m.path !== 'string' || !m.path.startsWith('/') ||
                m.path.split('/').some(p => p === '..' || p === '.trash') || m.tree === 'backends' ||
                String(m.sourcePath || '').split('/').includes('..')) throw new Error('Git link requires a branch, virtual tree and absolute destination path');
        }
        this.repositories = new GitRepositories(options.gitPath || path.join(options.rootPath, 'Git'));
        this.onContainer = options.onContainer;
    }
    async prepare() {
        try {
            const dir = await this.repositories.checkedPath(this.address);
            if (this.config.url) {
                const origin = (await git(dir, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
                if (origin !== this.config.url) throw new Error('This repository already exists with a different origin; choose a new repository name');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await this.repositories.create(this.address, this.config);
        }
    }
    async test() { await this.prepare(); await this.repositories.branches(this.address, { fetch: true }); }
    async listContainers() {
        await this.prepare();
        const all = await this.repositories.branches(this.address, { fetch: true });
        return all.filter(b => !this.config.branches?.length || this.config.branches.includes(b.id));
    }
    treePath(container, spec = {}) {
        const folder = spec.metadata?.git?.path ? path.posix.dirname(spec.metadata.git.path) : '';
        return gitTreePath(this.address, container?.id ?? null, folder === '.' ? '' : folder);
    }
    async fetchChanges(container, cursor) {
        if (cursor === container.oid) return { documents: [], nextCursor: cursor, done: true };
        const entries = await this.repositories.entries(this.address, container.oid);
        const previous = typeof cursor === 'string' && /^[a-f0-9]{40,64}$/.test(cursor)
            ? new Map((await this.repositories.entries(this.address, cursor)).map(e => [e.file, e.oid])) : new Map();
        const documents = entries.filter(entry => previous.get(entry.file) !== entry.oid).map(entry => ({
            schema: 'data/schema/file', data: {},
            metadata: {
                // No content, extraction, hashing or embeddings at discovery time.
                contentType: /\.(md|txt|rst|js|ts|tsx|jsx|py|sh|css|html|yaml|yml|toml|json|xml|rs|go|c|h|cpp)$/i.test(entry.file) ? 'text/plain' : (mimeFromLocations([{ metadata: { filename: entry.file } }]) || 'application/octet-stream'),
                size: entry.size,
                text: null, exif: null, dimensions: null, media: null, summary: null,
                git: { repo: this.address, branch: container.id, path: entry.file, oid: entry.oid, commit: container.oid },
            },
            locations: [{ url: gitLocation(this.address, container.id, entry.file), metadata: { provenance: true, filename: path.posix.basename(entry.file) } }],
        }));
        return { documents, nextCursor: container.oid, done: true };
    }
    async listIdentities(container) {
        if (container.deleted) return [];
        return (await this.repositories.entries(this.address, container.oid)).map(e => gitLocation(this.address, container.id, e.file));
    }
    containerIdFromProvenance(url) {
        const prefix = `canvas-git://${this.address}/`;
        return url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length).split('/')[0]) : null;
    }
    /** Live filing rules; each mapping follows a branch and optionally a subtree. */
    placements(spec) {
        const mappings = [...(this.config.mounts || [])];
        if (this.config.targetPath) mappings.push({ branch: this.config.linkBranch, sourcePath: this.config.linkPath || '', tree: this.config.targetTree || 'context', path: this.config.targetPath });
        return mappings.flatMap(mapping => {
            const { branch, path: file } = spec.metadata.git;
            if (mapping.branch !== branch) return [];
            const source = String(mapping.sourcePath || '').replace(/^\/+|\/+$/g, '');
            if (source && !file.startsWith(source + '/')) return [];
            const relative = source ? file.slice(source.length + 1) : file;
            const folder = path.posix.dirname(relative);
            const tree = mapping.tree || 'context';
            const target = String(mapping.path || '');
            if (tree === 'backends' || !target.startsWith('/') || target.split('/').includes('..') || source.split('/').includes('..')) throw new Error('Git link requires a virtual tree and an absolute destination path');
            return [{ tree, path: path.posix.join(target, folder) }];
        });
    }
}
