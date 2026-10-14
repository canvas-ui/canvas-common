import BaseConnector from '../../BaseConnector.js';
import GitRepositories, { gitTreePath, gitLocation, repoName, git } from '../../../git/GitRepositories.js';
import path from 'node:path';
import { mimeFromLocations } from '../../../../documents/classifier.js';

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
    ];
    constructor(address, config, options = {}) {
        super(address, config, options);
        repoName(address);
        if (config.branches != null && (!Array.isArray(config.branches) || config.branches.some(b => typeof b !== 'string'))) throw new Error('branches must be an array of branch names');
        // Legacy linkBranch/linkPath/target*/mounts are intentionally ignored.
        // Virtual filing is configured through the shared Auto-Link rules.
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
}
