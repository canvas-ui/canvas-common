'use strict';

const DEVICE_SCHEMA = 'data/schema/device';
const LIST_LIMIT = 500;
const TOUCH_MS = 60_000;

function pickDefined(data = {}) {
    return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

/**
 * The devices of a workspace: one `data/schema/device` document per device
 * that works with it, filed at the context root. It names the device for
 * `file://<deviceId>/…` locations, and synapsd derives its `device/*` bitmaps
 * from it (so "apps on work-laptop" is a bitmap op over Application
 * documents). `data.mirror` holds what the device last reported about its
 * mirror of this workspace.
 *
 * Which account a device belongs to, its tokens and revocation are identity:
 * the hub's device registry, never this.
 */
export default class WorkspaceDevices {
    #workspace;
    #touched = new Map();

    constructor(workspace) { this.#workspace = workspace; }

    #rootContext() { return this.#workspace.getContextTreeSelector('/'); }

    async list({ limit = LIST_LIMIT, offset, page } = {}) {
        return this.#workspace.list({ context: this.#rootContext(), attributes: { allOf: [DEVICE_SCHEMA] }, limit, offset, page });
    }

    async find(deviceId) {
        const docs = await this.list();
        return Array.isArray(docs) ? docs.find((document) => document?.data?.deviceId === deviceId) || null : null;
    }

    /**
     * Create or refresh a device's document from what is known about it
     * (`deviceId` required; name, platform, os, arch, hostname … optional).
     * @returns {Promise<{ id: number, created: boolean, data: Object }>}
     */
    async ensure(device = {}) {
        const deviceId = String(device.deviceId || '').trim();
        if (!deviceId) throw new Error('deviceId is required');
        const now = new Date().toISOString();
        const existing = await this.find(deviceId);
        const prior = existing?.data || {};
        const username = device.username ?? prior.username;
        const hostname = device.hostname ?? prior.hostname;
        const data = pickDefined({
            ...prior,
            deviceId,
            name: device.name || prior.name || hostname || deviceId,
            description: device.description ?? prior.description,
            platform: device.platform ?? prior.platform,
            osDistro: device.osDistro ?? prior.osDistro,
            osVersion: device.osVersion ?? prior.osVersion,
            arch: device.arch ?? prior.arch,
            type: device.type ?? prior.type,
            username,
            hostname,
            fqdn: device.fqdn ?? prior.fqdn,
            alias: device.alias ?? (username && hostname ? `${username}@${hostname}` : prior.alias),
            createdAt: prior.createdAt || device.createdAt || now,
            lastSeen: device.lastSeen || now,
        });
        return this.#write(existing, data);
    }

    /** `ensure`, at most once a minute per device: devices touch a workspace on every request. */
    async touch(device = {}) {
        const last = this.#touched.get(device.deviceId);
        if (last && Date.now() - last < TOUCH_MS) return null;
        this.#touched.set(device.deviceId, Date.now());
        return this.ensure(device);
    }

    /** Delete a device's document(s); returns how many were removed. */
    async remove(deviceId) {
        const docs = await this.list();
        const matches = (Array.isArray(docs) ? docs : []).filter((document) => document?.data?.deviceId === deviceId);
        if (!matches.length) return 0;
        const result = await this.#workspace.deleteMany(matches.map((document) => document.id));
        return result?.successful?.length ?? matches.length;
    }

    /** Record a device's report about its mirror of this workspace. */
    async reportMirror(deviceId, patch = {}) {
        let existing = await this.find(deviceId);
        if (!existing) {
            await this.ensure({ deviceId });
            existing = await this.find(deviceId);
        }
        const now = new Date().toISOString();
        const prior = existing.data.mirror || {};
        const mirror = pickDefined({ ...prior, ...patch, backend: patch.backend || prior.backend || 'workspace:home', firstSeen: prior.firstSeen || now, lastSeen: now });
        await this.#write(existing, { ...existing.data, lastSeen: now, mirror });
        return mirror;
    }

    async forgetMirror(deviceId) {
        const existing = await this.find(deviceId);
        if (!existing?.data?.mirror) return false;
        const { mirror: _mirror, ...data } = existing.data;
        await this.#write(existing, data);
        return true;
    }

    /** `[{ deviceId, name, platform, type, lastSeen, mirror }]` for devices that mirror this workspace. */
    async listMirrors() {
        const docs = await this.list();
        return (Array.isArray(docs) ? docs : [])
            .filter((document) => document?.data?.mirror)
            .map(({ data }) => ({ deviceId: data.deviceId, name: data.name, platform: data.platform, type: data.type, lastSeen: data.lastSeen, mirror: data.mirror }));
    }

    async #write(existing, data) {
        // No device/* asserted here: synapsd derives a Device document's own
        // id/os/arch/type keys from this row (Device.getFeatureBitmapArray), which
        // is what makes them survive a rebuild and untick on an OS upgrade.
        const options = { context: this.#rootContext(), attributes: { allOf: [DEVICE_SCHEMA] } };
        if (existing?.id) {
            await this.#workspace.put({ id: existing.id, data }, options);
            return { id: existing.id, created: false, data };
        }
        const id = await this.#workspace.put({ schema: DEVICE_SCHEMA, data }, options);
        return { id, created: true, data };
    }
}
