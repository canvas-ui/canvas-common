import { gitTreePath } from '../services/git/GitRepositories.js';
import { containsSecrets } from '../security/WorkspaceCrypto.js';
import * as fsPromises from 'fs/promises';
import path from 'path';
import getFolderSize from 'get-folder-size';
import { normalizeSegment } from '../../../utils/backend-documents.js';
import { detectMountSync } from 'canvas-stored/src/utils/mount.js';
import { getBackendCapabilities } from 'canvas-stored/src/backends/BackendManager.js';
import GdriveBackend from 'canvas-stored/src/backends/gdrive/index.js';
import S3Backend from 'canvas-stored/src/backends/s3/index.js';
import { WorkspaceStoredIndex } from './WorkspaceStoredIndex.js';

import { isConnectorDriver } from '../services/connectors/index.js';
import { normalizeRemovalPolicy } from './removal-policy.js';
import { getServerDevice } from '../../device/ServerDevice.js';
import { WORKSPACE_STORAGE_BACKENDS } from '../configuration/constants.js';
import Workspace from '../Workspace.js';
import WorkspaceConfiguration from '../configuration/WorkspaceConfiguration.js';

export default class WorkspaceBackends {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    // ─────────────────────────────────────────────────────────────────────────
    // Stored home index (delegated to WorkspaceStoredIndex)
    // ─────────────────────────────────────────────────────────────────────────

    async startHomeService() {
        if (!this.#workspace.isActive) return;
        await this.#workspace.setDataBackendConfig(WorkspaceStoredIndex.HOME_STORED_BACKEND, { enabled: true });
        await this.#runtime.integrations.startStoredIndex();
    }

    async stopHomeService() {
        await this.#workspace.setDataBackendConfig(WorkspaceStoredIndex.HOME_STORED_BACKEND, { enabled: false });
        await this.#runtime.integrations.stopStoredIndex();
    }

    // Per-backend config + runtime status map — feeds the backend descriptors
    // (#listStorageBackends). Internal since the legacy /services/data-backends
    // routes were retired; clients consume /:id/backends.
    #getDataBackendStatus() {
        const dataBackends = this.#workspace.dataBackends;
        return Object.fromEntries(Object.entries(dataBackends).map(([name, config]) => {
            const runtime = this.#runtime.state.storedIndex?.getBackendStatus(name) || {};
            return [name, {
                ...config,
                capabilities: runtime.capabilities,
                root: WorkspaceConfiguration.resolveWorkspaceRoot(config.root, this.#runtime.state.rootPath),
                running: runtime.running || false,
                watching: runtime.watching || false,
                resyncing: runtime.resyncing === true,
                resyncProgress: runtime.progress || null,
                resyncStartedAt: runtime.resyncStartedAt || null,
                cancelledAt: runtime.cancelledAt || null,
                lastScanAt: runtime.lastScanAt || null,
                lastError: this.#runtime.state.withoutSecrets && containsSecrets(config) ? 'Credentials locked — start with PIN/password' : runtime.lastError || null,
                cacheStats: runtime.cacheStats || null,
                // Runtime truth (kernel mount table) beats the stored config —
                // a folder can become a mountpoint, or stop being one, between
                // restarts.
                remote: runtime.remote === true || config.remote === true,
                transport: runtime.transport || config.transport || null,
                // Full exclusion set applied to watch + resync (defaults ∪ user
                // `exclude`) so the settings UI can show both.
                effectiveExclusions: this.#runtime.state.storedIndex?.isRunning
                    ? this.#runtime.state.storedIndex.getEffectiveExclusions(name)
                    : undefined,
            }];
        }));
    }

    async #resyncDataBackend(backendName, { background = true } = {}) {
        const config = this.#workspace.dataBackends[backendName];
        if (!config) throw new Error(`Unknown data backend: ${backendName}`);
        if (!config.supported) throw new Error(`Data backend "${backendName}" is not supported yet`);
        if (!config.resync) throw new Error(`Data backend "${backendName}" does not support resync`);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        // A resync is a potentially slow full scan (large/remote backends); by
        // default it runs in the background and progress is reported via the
        // backend status. Pass { background: false } to await completion.
        return background
            ? this.#runtime.state.storedIndex.resyncInBackground(backendName)
            : this.#runtime.state.storedIndex.resync(backendName);
    }

    /**
     * Resync a backend addressed by its backends-tree mirror node path
     * (/<driver>/<address>/… in the backends tree). Dispatches by driver because
     * "backend" is overloaded: file/s3/etc. are stored data backends keyed by
     * name, while imap accounts are mailbox connectors keyed by mailbox id.
     * The context-menu resync in the tree routes through here. MVP resyncs the
     * whole backend/account; the folder segment (if any) is ignored.
     */
    // ─────────────────────────────────────────────────────────────────────────
    // Unified backend/connector facade — one surface over every "thing mounted
    // under /<driver>/<address> in the backends tree": storage backends (file/cacache/s3,
    // via WorkspaceStoredIndex) and message connectors (imap accounts, via
    // WorkspaceMailIndex). The /:id/backends routes mirror the tree; driver
    // dispatch + capabilities live here so the URL never carries an internal id.
    // Descriptor: { driver, address, kind, enabled, status, lastSyncAt,
    // lastError, capabilities, containers? }.
    // ─────────────────────────────────────────────────────────────────────────

    // Capability map the UI reads to decide which actions to expose — replaces
    // per-name special-casing. Future container mutation / object delete slot
    // onto mutableContainers / deleteObject without new URL shapes.
    #backendCapabilities(driver, config = {}) {
        if (driver === 'imap') {
            return { sync: true, test: true, containers: true, mutableContainers: false, deleteObject: true, paths: false };
        }
        const supported = config.supported !== false;
        const features = config.capabilities || getBackendCapabilities({ ...config, driver });
        return {
            ...features,
            sync: Boolean(config.resync) && supported,
            test: ['gdrive', 's3'].includes(driver) && supported,
            containers: false,
            mutableContainers: features.mutableContainers === true && config.readOnly !== true && supported,
            upload: features.upload === true && config.enabled !== false && config.readOnly !== true && supported,
            deleteObject: features.delete === true && config.readOnly !== true && supported,
            // Objects live under person-chosen paths (folder + filename on
            // transfer) — false for the content-hash keyed blob store.
            paths: features.paths === true && supported,
        };
    }

    #storageBackendDescriptor(name, status = {}) {
        const driver = status.driver || 'file';
        const state = status.resyncing
            ? 'syncing'
            : (status.lastError ? 'error' : (status.running ? (status.watching ? 'running' : 'idle') : 'stopped'));
        return {
            driver,
            address: name,
            kind: 'storage',
            enabled: status.enabled !== false,
            status: state,
            // Live resync state: clients render a spinner on the mirror node and
            // a progress readout ({scanned, total}) without polling deep status.
            resyncing: status.resyncing === true,
            progress: status.resyncProgress || null,
            resyncStartedAt: status.resyncStartedAt || null,
            resyncCancelledAt: status.cancelledAt || null,
            // Mirror node in the backends tree (/device/<device>/<mount> for
            // device-scoped mounts) so clients never re-derive path grammar.
            treePath: this.#runtime.state.storedIndex?.getBackendTreeRoot(name) || null,
            lastSyncAt: status.lastScanAt || null,
            lastError: status.lastError || null,
            // Last on-demand disk usage ({bytes, files, computedAt}) if computed
            // this runtime — see getBackendDiskUsage.
            usage: status.diskUsage || null,
            capabilities: this.#backendCapabilities(driver, status),
            config: {
                root: status.root || null,
                // Display name of a user-added mount ("Financial Reports");
                // address stays the slug.
                label: status.label || null,
                // Authoring device snapshot for device-scoped mounts.
                device: status.device || null,
                removalPolicy: normalizeRemovalPolicy(status.removalPolicy),
                propagatedRemovalSupported: ['file', 'cacache'].includes(driver),
                readOnly: status.readOnly === true,
                managed: status.managed === true,
                supported: status.supported !== false,
                watch: status.watch === true,
                scanOnStart: status.scanOnStart ?? (driver === 'file'),
                // Network mount (cifs/nfs/sshfs/…). Detected from the kernel
                // mount table by the file driver unless declared in config. The
                // UI badges these and warns before a full resync; watching them
                // needs explicit polling, since inotify never sees another
                // client's writes.
                remote: status.remote === true,
                transport: status.transport || null,
                resync: Boolean(status.resync),
                // Remote (gdrive) extras. Secrets never leave the server:
                // `credentialsConfigured` is the only trace of them.
                ...(driver === 'gdrive' ? {
                    account: status.account || null,
                    folderId: status.folderId || 'root',
                    clientId: status.clientId || null,
                    credentialsConfigured: Boolean(status.clientId && status.clientSecret && status.refreshToken),
                    pollInterval: status.pollInterval ?? 60000,
                    permanentDelete: status.permanentDelete === true,
                } : {}),
                ...(driver === 's3' ? {
                    bucket: status.bucket, prefix: status.prefix || '', endpoint: status.endpoint || '',
                    region: status.region || 'us-east-1', forcePathStyle: status.forcePathStyle ?? Boolean(status.endpoint),
                    credentialsConfigured: Boolean(status.accessKeyId && status.secretAccessKey),
                    pollInterval: status.pollInterval ?? 60000, permanentDelete: status.permanentDelete === true,
                } : {}),
                exclude: Array.isArray(status.exclude) ? status.exclude : [],
                effectiveExclusions: Array.isArray(status.effectiveExclusions) ? status.effectiveExclusions : undefined,
            },
        };
    }

    listStorageBackends() {
        return Object.entries(this.#getDataBackendStatus())
            .map(([name, status]) => this.#storageBackendDescriptor(name, status));
    }

    #imapBackendDescriptor(address, mailboxes = []) {
        const errored = mailboxes.find((m) => m.lastError);
        const anyRunning = mailboxes.some((m) => m.runtime?.active);
        const syncing = mailboxes.some((m) => m.runtime?.syncing);
        const lastSyncAt = mailboxes.map((m) => m.lastSyncAt).filter(Boolean).sort().at(-1) || null;
        const primary = mailboxes[0] || {};
        return {
            driver: 'imap',
            address,
            kind: 'messages',
            enabled: mailboxes.some((m) => m.enabled !== false),
            status: syncing ? 'syncing' : errored ? 'error' : (anyRunning ? 'running' : 'idle'),
            resyncing: syncing,
            lastSyncAt,
            lastError: errored?.lastError || null,
            capabilities: this.#backendCapabilities('imap'),
            // Connection config (from the account's primary mailbox) so the
            // settings panel can render/edit the account without a second fetch.
            config: {
                host: primary.host || '',
                port: primary.port ?? 993,
                tls: primary.tls !== false,
                allowSelfSigned: primary.allowSelfSigned !== false,
                user: primary.user || '',
                pollInterval: primary.pollInterval ?? 60000,
                initialSyncDays: primary.initialSyncDays ?? 180,
                passwordConfigured: mailboxes.some((m) => m.passwordConfigured),
                smtp: (mailboxes.find((m) => m.enabled !== false && m.smtp?.enabled && !m.readOnly) || primary).smtp || {},
                readOnly: mailboxes.every((m) => m.readOnly),
            },
            containers: mailboxes.map((m) => ({
                removalPolicy: normalizeRemovalPolicy(m.removalPolicy),
                name: m.folder || 'INBOX',
                mailboxId: m.id,
                enabled: m.enabled !== false,
                status: m.runtime?.status || (m.enabled === false ? 'stopped' : 'idle'),
                lastSyncAt: m.lastSyncAt || null,
                lastError: m.lastError || null,
            })),
        };
    }

    // Group per-folder imap mailboxes by account into one instance each. The
    // account segment matches the backends tree /imap/<account> node.
    async #listImapBackends() {
        const mailboxes = await this.#workspace.listImapMailboxes();
        const byAccount = new Map();
        for (const mb of mailboxes) {
            const address = normalizeSegment(mb.account || mb.user || '');
            if (!address) continue;
            if (!byAccount.has(address)) byAccount.set(address, []);
            byAccount.get(address).push(mb);
        }
        return [...byAccount.entries()].map(([address, mbs]) => this.#imapBackendDescriptor(address, mbs));
    }

    async listBackends() {
        return [
            ...this.listStorageBackends(),
            ...(await this.#listImapBackends()),
            ...(await this.#runtime.integrations.connectorsReadonly().listStoredBackends()),
        ];
    }

    /**
     * Documents mirrored under a backend address in the backends tree,
     * optionally filtered by linkage: linked=false → present ONLY on the
     * backend, never filed into any other tree (safe-to-purge candidates);
     * linked=true → the inverse; linked=null → everything under the address.
     */
    async listBackendDocuments(driver, address, { linked = null, limit = null, offset = 0, parse = true } = {}) {
        // Storage backends may mirror deeper than /<driver>/<address> (device
        // segment on fs mounts) — ask the index for the canonical node first.
        const path = (driver === 'git' ? gitTreePath(address) : null) || this.#runtime.state.storedIndex?.getBackendTreeRoot(address)
            || `/${normalizeSegment(driver)}/${normalizeSegment(address)}`;
        return await this.#runtime.getActiveDb().listTreeDocuments(Workspace.BACKENDS_TREE_NAME, { path, linked, limit, offset, parse });
    }

    async listBackendsByDriver(driver) {
        return (await this.#workspace.listBackends()).filter((b) => b.driver === driver);
    }

    async getBackend(driver, address) {
        const match = (await this.#workspace.listBackends()).find((b) => b.driver === driver && b.address === address);
        if (!match) throw new Error(`Backend not found: ${driver}/${address}`);
        return match;
    }

    async addBackend(driver, config = {}) {
        if (driver === 'imap') return this.#workspace.saveImapMailbox(config);
        if (isConnectorDriver(driver)) return (await this.#runtime.integrations.connectors()).saveBackend(driver, config);
        if (driver === 'fs') driver = 'file'; // UX alias for the local-folder driver
        if (driver === 'file') return this.#addFileBackend(config);
        if (driver === 'gdrive') return this.#addGdriveBackend(config);
        if (driver === 's3') return this.#addS3Backend(config);
        const name = config.name || config.address;
        if (!name) throw new Error('Storage backend name is required');
        await this.#workspace.setDataBackendConfig(name, config);
        return this.#workspace.getBackend(driver, name);
    }

    // Case- and unicode-preserving slug for a user-added backend: "Fotky" must
    // show as "Fotky" in the tree, not "fotky" (tree layer names keep case, like
    // the home mirror's real folder names). Whitespace/separators collapse to
    // '-'; the slug is the immutable backend address, the raw label stays the
    // display name. Throws on an (case-insensitive) address collision.
    #newBackendSlug(label) {
        const name = String(label).normalize('NFC')
            .replace(/[\s\\/]+/g, '-')
            .replace(/[^\p{L}\p{N}._@-]+/gu, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!name) throw new Error(`Backend name "${label}" has no usable characters`);
        const collision = Object.keys(this.#workspace.dataBackends).find((existing) => existing.toLowerCase() === name.toLowerCase());
        if (collision) throw new Error(`Backend "${collision}" already exists`);
        return name;
    }

    /**
     * Mount an arbitrary local folder as a file data backend. The mount name
     * ("Financial Reports") is the human handle: its case-preserving slug
     * becomes the backend address (/device/<device>/Financial-Reports in the
     * backends tree); documents carry file://<deviceId>/<abs-path> locations.
     * The display label and the authoring device ({id, name}) are snapshotted
     * on the config so mirror paths stay stable across device renames.
     */
    async #addFileBackend(config = {}) {
        const label = String(config.label || config.name || config.address || '').trim();
        if (!label) throw new Error('Backend name is required (e.g. "Financial Reports")');
        const name = this.#newBackendSlug(label);

        const rawRoot = String(config.root || config.path || '').trim();
        if (!rawRoot) throw new Error('Backend root path is required');
        if (!path.isAbsolute(rawRoot)) throw new Error(`Backend root must be an absolute path: ${rawRoot}`);
        let root;
        try {
            root = await fsPromises.realpath(rawRoot);
        } catch {
            throw new Error(`Backend root does not exist or is not accessible: ${rawRoot}`);
        }
        const stat = await fsPromises.stat(root);
        if (!stat.isDirectory()) throw new Error(`Backend root is not a directory: ${root}`);
        await fsPromises.access(root, fsPromises.constants.R_OK).catch(() => {
            throw new Error(`Backend root is not readable: ${root}`);
        });
        // The workspace root is already covered by the managed backends
        // (workspace:home et al.) — a nested mount would double-index it.
        const workspaceRoot = path.resolve(this.#runtime.state.rootPath);
        if (root === workspaceRoot || root.startsWith(workspaceRoot + path.sep)) {
            throw new Error(`Backend root is inside the workspace root (${workspaceRoot}) — already indexed`);
        }
        for (const [existingName, existing] of Object.entries(this.#workspace.dataBackends)) {
            if (existing?.driver !== 'file' || !existing.root || existing.root.includes('{WORKSPACE_ROOT}')) continue;
            const existingRoot = path.resolve(existing.root);
            if (root === existingRoot || root.startsWith(existingRoot + path.sep) || existingRoot.startsWith(root + path.sep)) {
                throw new Error(`Backend root overlaps existing backend "${existingName}" (${existingRoot})`);
            }
        }

        const device = getServerDevice();
        const exclude = Array.isArray(config.exclude)
            ? config.exclude.filter((p) => typeof p === 'string' && p.trim())
            : [];
        // Is this folder a network share (NFS/CIFS/sshfs/…)? Snapshotted at
        // mount time so the UI can badge it before the stored index boots; the
        // live backend re-detects on every registration, and runtime wins.
        // An explicit flag in the request always overrides detection.
        const mount = detectMountSync(root);
        const remote = config.remote ?? mount.remote;
        await this.#workspace.setDataBackendConfig(name, {
            enabled: true,
            supported: true,
            driver: 'file',
            label,
            root,
            remote,
            transport: config.transport ?? mount.transport,
            // inotify does not carry another client's writes over the wire, so
            // watching a share is opt-in polling or nothing. Never silently
            // enable a watcher that would look live and miss everything.
            watch: config.watch === true && (!remote || config.usePolling === true),
            ...(remote && config.usePolling === true
                ? { usePolling: true, pollInterval: Number(config.pollInterval) || 30000 }
                : {}),
            resync: true,
            scanOnStart: config.scanOnStart ?? true,
            exclude,
            readOnly: config.readOnly === true,
            // Authoring device snapshot: id is the file:// URL authority for
            // this mount's locations, name the mirror-path device segment.
            device: { id: device.deviceId, name: device.name },
        });
        return this.#workspace.getBackend('file', name);
    }

    static #GDRIVE_SECRETS = ['clientSecret', 'refreshToken'];

    #s3ConfigPatch(input = {}, previous = {}) {
        const patch = {};
        if ('removalPolicy' in input) patch.removalPolicy = normalizeRemovalPolicy(input.removalPolicy);
        for (const key of ['bucket', 'region', 'endpoint', 'prefix', 'label']) {
            if (key in input) patch[key] = String(input[key] ?? '').trim();
        }
        for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
            if (key in input && input[key] !== true && input[key] != null && input[key] !== '') patch[key] = String(input[key]).trim();
        }
        // An empty token explicitly clears temporary credentials; omitted keeps it.
        if (input.sessionToken === '') patch.sessionToken = '';
        for (const key of ['forcePathStyle', 'scanOnStart', 'watch', 'readOnly', 'permanentDelete', 'enabled']) {
            if (!(key in input)) continue;
            if (typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
            patch[key] = input[key];
        }
        if ('pollInterval' in input) {
            const ms = Number(input.pollInterval);
            if (!Number.isFinite(ms) || ms < 5000) throw new Error('pollInterval must be at least 5000 ms');
            patch.pollInterval = ms;
        }
        const merged = { ...previous, ...patch };
        if (!merged.bucket || !merged.accessKeyId || !merged.secretAccessKey) throw new Error('S3 bucket, accessKeyId and secretAccessKey are required');
        return patch;
    }

    async #probeS3(config) {
        const probe = new S3Backend('s3:probe', this.#runtime.config.resolveCredentials({ driver: 's3', ...config }));
        try {
            const live = await probe.verifyRoot();
            if (!live.ok) throw new Error(`S3 check failed (${live.reason}): ${live.error || 'unknown error'}`);
            if (config.readOnly !== true) await probe.verifyWrites();
            return { ok: true, bucket: config.bucket, conditionalCreate: config.readOnly !== true };
        } finally { await probe.stop(); }
    }

    async #addS3Backend(config = {}) {
        const label = String(config.label || config.name || config.address || '').trim();
        if (!label) throw new Error('Backend name is required');
        const name = this.#newBackendSlug(label);
        const patch = this.#s3ConfigPatch(config);
        await this.#probeS3(patch);
        await this.#workspace.setDataBackendConfig(name, {
            enabled: true, supported: true, driver: 's3', label, remote: true, transport: 's3',
            resync: true, scanOnStart: true, watch: false, readOnly: false, ...patch,
        });
        return this.#workspace.getBackend('s3', name);
    }

    // Normalize a gdrive config patch: required creds, folder id, poll interval.
    // `previous` supplies stored secrets when the patch carries the redacted
    // marker (`true`) or omits them — the same write-only contract connectors use.
    #gdriveConfigPatch(input = {}, previous = {}) {
        const patch = {};
        if ('removalPolicy' in input) patch.removalPolicy = normalizeRemovalPolicy(input.removalPolicy);
        for (const key of ['clientId', 'folderId', 'label', 'account']) {
            if (key in input) patch[key] = String(input[key] ?? '').trim();
        }
        for (const key of WorkspaceBackends.#GDRIVE_SECRETS) {
            if (!(key in input) || input[key] === true || input[key] === '' || input[key] == null) continue;
            patch[key] = String(input[key]).trim();
        }
        if ('scanOnStart' in input) {
            if (typeof input.scanOnStart !== 'boolean') throw new Error('scanOnStart must be a boolean');
            patch.scanOnStart = input.scanOnStart;
        }
        if ('watch' in input) patch.watch = input.watch === true;
        if ('readOnly' in input) patch.readOnly = input.readOnly === true;
        if ('permanentDelete' in input) patch.permanentDelete = input.permanentDelete === true;
        if ('pollInterval' in input) {
            const ms = Number(input.pollInterval);
            if (!Number.isFinite(ms) || ms < 5000) throw new Error('pollInterval must be at least 5000 ms');
            patch.pollInterval = ms;
        }
        const merged = { ...previous, ...patch };
        if (!merged.clientId || !merged.clientSecret || !merged.refreshToken) {
            throw new Error('Google Drive backend requires clientId, clientSecret and refreshToken');
        }
        if (!merged.folderId) patch.folderId = 'root';
        return patch;
    }

    // Probe creds + root folder with a throwaway driver instance before anything
    // is persisted — a backend that can't even list its root is a config error.
    async #probeGdrive(config) {
        const probe = new GdriveBackend('gdrive:probe', this.#runtime.config.resolveCredentials({ driver: 'gdrive', ...config }));
        const live = await probe.verifyRoot();
        if (!live.ok) throw new Error(`Google Drive check failed (${live.reason}): ${live.error || 'unknown error'}`);
        return { ok: true, folderId: probe.rootFolderId };
    }

    /**
     * Add a Google Drive folder as a remote storage backend. The label is the
     * human handle (slug → backend address → /gdrive/<address> in the backends
     * tree); `folderId` scopes the subtree (default `root` = whole My Drive).
     * Credentials are validated against the API before the config is written.
     */
    async #addGdriveBackend(config = {}) {
        const label = String(config.label || config.name || config.address || '').trim();
        if (!label) throw new Error('Backend name is required (e.g. "Work Drive")');
        const name = this.#newBackendSlug(label);
        const patch = this.#gdriveConfigPatch(config, {});
        await this.#probeGdrive(patch);
        await this.#workspace.setDataBackendConfig(name, {
            enabled: true,
            supported: true,
            driver: 'gdrive',
            label,
            account: patch.account || label,
            remote: true,
            transport: 'gdrive',
            resync: true,
            watch: config.watch === true,
            readOnly: config.readOnly === true,
            ...patch,
        });
        // applyBackendConfig registers the live driver and kicks the initial
        // scan in the background (resync:true) — nothing more to do here.
        return this.#workspace.getBackend('gdrive', name);
    }

    /** On-demand on-disk size of a local storage backend (slow walk — user-triggered). */
    async getBackendDiskUsage(driver, address) {
        if (driver === 'imap') throw new Error('IMAP backends have no local disk usage');
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return await this.#runtime.state.storedIndex.getBackendDiskUsage(address);
    }

    /**
     * On-demand on-disk size of the WHOLE workspace root with a per-top-level
     * directory breakdown (db, data, home, cache, …) — the number an export or
     * sync needs to plan around. Total is measured on the root in one pass
     * (hardlink/inode-aware via get-folder-size); the breakdown is per subtree,
     * so cross-directory hardlinks can make its sum slightly exceed the total.
     */
    async getDiskUsage() {
        const root = this.#runtime.state.rootPath;
        const [bytes, entries] = await Promise.all([
            getFolderSize.loose(root),
            fsPromises.readdir(root, { withFileTypes: true }).catch(() => []),
        ]);
        const breakdown = {};
        for (const entry of entries) {
            const target = path.join(root, entry.name);
            breakdown[entry.name] = entry.isDirectory()
                ? await getFolderSize.loose(target)
                : ((await fsPromises.stat(target).catch(() => null))?.size ?? 0);
        }
        return { workspaceId: this.#workspace.id, bytes, breakdown, computedAt: new Date().toISOString() };
    }

    async updateBackend(driver, address, patch = {}) {
        if (isConnectorDriver(driver)) return (await this.#runtime.integrations.connectors()).saveBackend(driver, { ...patch, address });
        if (driver === 'imap') {
            // Account-level settings/creds are shared across the account's folder
            // mailboxes, so apply the patch to each.
            const targets = (await this.#workspace.listImapMailboxes())
                .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
            if (!targets.length) throw new Error(`No IMAP mailbox for account "${address}"`);
            for (const m of targets) await this.#workspace.saveImapMailbox({ ...patch, id: m.id });
            return this.#workspace.getBackend('imap', address);
        }
        if (driver === 'gdrive') {
            const previous = this.#workspace.dataBackends[address];
            if (!previous || previous.driver !== 'gdrive') throw new Error(`Backend not found: gdrive/${address}`);
            const credKeys = ['clientId', 'clientSecret', 'refreshToken', 'folderId'];
            const touchesCreds = credKeys.some((k) => k in patch && patch[k] !== true && patch[k] !== '' && patch[k] != null);
            const normalized = this.#gdriveConfigPatch(patch, previous);
            if (touchesCreds) await this.#probeGdrive({ ...previous, ...normalized });
            patch = { ...normalized, ...('enabled' in patch ? { enabled: patch.enabled === true } : {}) };
        }
        if (driver === 's3') {
            const previous = this.#workspace.dataBackends[address];
            if (!previous || previous.driver !== 's3') throw new Error(`Backend not found: s3/${address}`);
            const normalized = this.#s3ConfigPatch(patch, previous);
            for (const key of ['bucket', 'endpoint', 'prefix']) {
                if (key in normalized && String(normalized[key] || '') !== String(previous[key] || '')) {
                    throw new Error(`Changing S3 ${key} requires adding a new backend; existing locations and pending operations keep their original destination`);
                }
            }
            const connectionKeys = ['bucket', 'prefix', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'forcePathStyle', 'readOnly'];
            if (connectionKeys.some(key => key in normalized)) await this.#probeS3({ ...previous, ...normalized });
            patch = normalized;
        }
        if ('exclude' in patch) {
            if (!Array.isArray(patch.exclude) || patch.exclude.some((p) => typeof p !== 'string')) {
                throw new Error('exclude must be an array of glob pattern strings');
            }
            patch = { ...patch, exclude: patch.exclude.map((p) => p.trim()).filter(Boolean).slice(0, 200) };
        }
        await this.#workspace.setDataBackendConfig(address, patch);
        // Toggling the home backend drives the stored-index lifecycle: enabling
        // it must boot the index when it isn't running (setDataBackendConfig
        // only applies config to an already-running index), disabling stops it.
        if (address === WorkspaceStoredIndex.HOME_STORED_BACKEND && typeof patch.enabled === 'boolean') {
            if (patch.enabled) await this.#runtime.integrations.startStoredIndex();
            else await this.#runtime.integrations.stopStoredIndex();
        }
        return this.#workspace.getBackend(driver, address);
    }

    async removeBackend(driver, address) {
        if (isConnectorDriver(driver)) return (await this.#runtime.integrations.connectors()).removeBackend(driver, address);
        if (driver === 'imap') {
            const targets = (await this.#workspace.listImapMailboxes())
                .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
            if (!targets.length) return false;
            for (const m of targets) await this.#workspace.removeImapMailbox(m.id);
            return true;
        }
        // Managed storage defaults can't be deleted; disabling is the remove op.
        // Disable first either way — it stops the watcher, unregisters the live
        // backend and releases the mirror-node enable-lock.
        const existing = this.#workspace.dataBackends[address];
        await this.#workspace.setDataBackendConfig(address, { enabled: false });
        if (existing && existing.managed !== true && !(address in WORKSPACE_STORAGE_BACKENDS)) {
            // User-added mount: drop the config entirely. Mirrored docs keep
            // their tree nodes until purged via tree-rm or swept as
            // dead-backend locations on the next resync.
            const dataBackends = this.#workspace.dataBackends;
            delete dataBackends[address];
            this.#runtime.config.writeStoredBackends(dataBackends);
            this.#workspace.emit('dataBackends.changed', { backend: address, config: null });
        }
        return true;
    }

    /**
     * Resync a backend. Storage resyncs run in the background by default (a full
     * scan of a large mount is slow, and progress is reported via the backend
     * status); pass `{ background: false }` to await the reconcile — what a
     * caller that needs to act on the result wants.
     */
    async syncBackend(driver, address, { background = true } = {}) {
        if (driver === 'imap') return (await this.#runtime.integrations.mail()).resyncAccount(address);
        if (isConnectorDriver(driver)) return (await this.#runtime.integrations.connectors()).resync(driver, address);
        // Storage: address is the backend name / config key verbatim
        // (workspace:home, or a user mount's case-preserving slug).
        return this.#resyncDataBackend(address, { background });
    }

    /**
     * Directory skeleton of a storage backend: `{ ok, dirs, files }` where
     * `dirs` are backend-relative folder keys ('Fotky/2019') honoring the
     * backend's exclusions and `files` is the file count. readdir only — no
     * stat, no hashing — so it is cheap even on a large mount. Backing for
     * hooks that mirror a mount's folder structure into the workspace tree
     * (ctx.backendShape). `{ ok:false, reason }` for unknown/unsupported.
     */
    async getBackendShape(backendName) {
        if (!this.#workspace.dataBackends[backendName]) throw new Error(`Unknown data backend: ${backendName}`);
        if (!this.#runtime.state.storedIndex?.isRunning) await this.#runtime.integrations.startStoredIndex();
        return this.#runtime.state.storedIndex.stored.shape(backendName);
    }

    // Mirror root of a storage backend in the backends tree (/<driver>/<address>),
    // null when the backend is not mirrored (managed blob store, unsupported).
    getBackendTreeRoot(backendName) {
        return this.#runtime.state.storedIndex?.isRunning ? this.#runtime.state.storedIndex.getBackendTreeRoot(backendName) : null;
    }

    // Cancel an in-flight storage resync. The walk stops at the next file;
    // nothing is orphaned from the partial snapshot and a later sync resumes
    // via the checksum cache (see WorkspaceStoredIndex.cancelResync).
    async cancelSyncBackend(driver, address) {
        if (driver === 'imap') throw new Error('IMAP sync does not support cancellation');
        if (!this.#runtime.state.storedIndex?.isRunning) return { backend: address, resyncing: false, cancelled: false };
        return this.#runtime.state.storedIndex.cancelResync(address);
    }

    async testBackend(driver, address) {
        if (isConnectorDriver(driver)) return (await this.#runtime.integrations.connectors()).testBackend(driver, address);
        if (driver === 'gdrive') {
            const config = this.#workspace.dataBackends[address];
            if (!config || config.driver !== 'gdrive') throw new Error(`Backend not found: gdrive/${address}`);
            return this.#probeGdrive(config);
        }
        if (driver === 's3') {
            const config = this.#workspace.dataBackends[address];
            if (!config || config.driver !== 's3') throw new Error(`Backend not found: s3/${address}`);
            return this.#probeS3(config);
        }
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" does not support test`);
        const target = (await this.#workspace.listImapMailboxes())
            .find((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
        if (!target) throw new Error(`No IMAP mailbox for account "${address}"`);
        return this.#workspace.testImapMailbox(target.id);
    }
}
