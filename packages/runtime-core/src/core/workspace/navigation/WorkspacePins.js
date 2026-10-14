import { randomUUID } from 'node:crypto';

import Workspace from '../Workspace.js';

// Workspace delegates this domain to a collaborator. Runtime dependencies stay
// private to the local host; the public Workspace API is the transport boundary.
export default class WorkspacePins {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }

    // ─────────────────────────────────────────────────────────────────────────
    // Pins — per-workspace list of tree paths the user is actively working in
    // (task containers). Stored in workspace.json `pins`, ordered; the order IS
    // the arrangement (tiles render in array order). Every client (webui,
    // desktop overlay, agents) reads the same list, so this is the one home.
    //
    // A pin is keyed on tree + path. The layer id captured at pin time is a
    // self-heal hint: when the path no longer resolves (folder moved/renamed)
    // the pin is re-pointed at the layer's current path on read; when the
    // layer is gone the pin stays, flagged `resolvable:false` — never dropped
    // behind the user's back.
    // ─────────────────────────────────────────────────────────────────────────

    get pins() {
        const raw = this.#runtime.state.configStore.get('pins', []);
        return Array.isArray(raw) ? raw.filter((p) => p && typeof p === 'object' && typeof p.path === 'string') : [];
    }

    static normalizePinPath(path) {
        const cleaned = `/${String(path ?? '').trim()}`.replace(/\/+/g, '/').replace(/\/$/, '');
        return cleaned || '/';
    }

    #pinKey(tree, path) {
        return `${tree || Workspace.CONTEXT_TREE_NAME}\0${Workspace.normalizePinPath(path)}`;
    }

    #savePins(pins, action, detail = {}) {
        this.#runtime.state.configStore.set('pins', pins);
        this.#workspace.emit('pins.changed', { id: this.#workspace.id, action, pins, ...detail });
        return pins;
    }

    /**
     * Pin a tree path. Idempotent on (tree, path): re-pinning an existing pin
     * returns it unchanged.
     * @returns {{ pin: object, created: boolean }}
     */
    addPin({ tree = Workspace.CONTEXT_TREE_NAME, path, label = null } = {}) {
        const normalizedPath = Workspace.normalizePinPath(path);
        if (normalizedPath === '/') throw new Error('The tree root cannot be pinned');
        const treeName = typeof tree === 'string' && tree.trim() ? tree.trim() : Workspace.CONTEXT_TREE_NAME;
        const pins = this.#workspace.pins;
        const key = this.#pinKey(treeName, normalizedPath);
        const existing = pins.find((p) => this.#pinKey(p.tree, p.path) === key);
        if (existing) return { pin: existing, created: false };

        // A pin on a path that does not exist would dangle from the start —
        // refuse it (getTree throws on an unknown tree, that bubbles up too).
        let layerId = null;
        if (this.#workspace.isActive) {
            const layer = this.#workspace.getTree(treeName)?.getLayerForPath(normalizedPath);
            if (!layer) throw new Error(`Path not found in tree "${treeName}": ${normalizedPath}`);
            layerId = layer.id || null;
        }
        const pin = {
            id: randomUUID(),
            tree: treeName,
            path: normalizedPath,
            layerId,
            label: typeof label === 'string' && label.trim() ? label.trim() : null,
            createdAt: new Date().toISOString(),
        };
        this.#savePins([...pins, pin], 'add', { pin });
        return { pin, created: true };
    }

    /**
     * Unpin by pin id, or by (tree, path).
     * @returns {boolean} true when a pin was removed
     */
    removePin(idOrPath, tree = null) {
        const pins = this.#workspace.pins;
        const key = tree ? this.#pinKey(tree, idOrPath) : null;
        const remaining = pins.filter((p) => p.id !== idOrPath && (!key || this.#pinKey(p.tree, p.path) !== key));
        if (remaining.length === pins.length) return false;
        const removed = pins.filter((p) => !remaining.includes(p));
        this.#savePins(remaining, 'remove', { removed });
        return true;
    }

    /**
     * Reorder pins. `order` is a list of pin ids; ids not mentioned keep
     * their relative order after the listed ones, unknown ids are ignored.
     */
    reorderPins(order = []) {
        const pins = this.#workspace.pins;
        const byId = new Map(pins.map((p) => [p.id, p]));
        const ordered = [];
        for (const id of Array.isArray(order) ? order : []) {
            const pin = byId.get(id);
            if (pin && !ordered.includes(pin)) ordered.push(pin);
        }
        for (const pin of pins) if (!ordered.includes(pin)) ordered.push(pin);
        const changed = ordered.some((p, i) => p !== pins[i]);
        return changed ? this.#savePins(ordered, 'reorder') : pins;
    }

    /**
     * Pins resolved against the live trees: each entry carries the layer's
     * current presentation (label, description, color, icon, metadata) plus
     * `resolvable`. On a stopped workspace nothing can be resolved and
     * `resolvable` is null. Self-heals moved/renamed pins via their layer id.
     */
    listPins() {
        const pins = this.#workspace.pins;
        if (!this.#workspace.isActive) return pins.map((pin) => ({ ...pin, name: pin.path.split('/').pop(), resolvable: null }));

        let healed = false;
        const resolved = pins.map((pin) => {
            const name = pin.path.split('/').pop();
            let tree;
            try { tree = this.#workspace.getTree(pin.tree || Workspace.CONTEXT_TREE_NAME); } catch { tree = null; }
            if (!tree) return { ...pin, name, resolvable: false };

            let layer = tree.getLayerForPath(pin.path);
            let path = pin.path;
            // Path gone but the layer is still around → follow it.
            if (!layer && pin.layerId && typeof tree.getPathByLayerId === 'function') {
                const current = tree.getPathByLayerId(pin.layerId);
                if (current && current !== '/') {
                    layer = tree.getLayerForPath(current);
                    if (layer) { path = Workspace.normalizePinPath(current); pin.path = path; healed = true; }
                }
            }
            if (!layer) return { ...pin, name, resolvable: false };
            const json = typeof layer.toJSON === 'function' ? layer.toJSON() : layer;
            const metadata = json.metadata && typeof json.metadata === 'object' ? json.metadata : {};
            const ui = metadata.ui && typeof metadata.ui === 'object' ? metadata.ui : {};
            if (json.id && pin.layerId !== json.id) { pin.layerId = json.id; healed = true; }
            return {
                ...pin,
                path,
                name: json.name || name,
                label: pin.label || json.label || json.name || name,
                description: json.description || null,
                type: json.type || null,
                color: typeof ui.color === 'string' ? ui.color : (json.color || null),
                icon: typeof ui.icon === 'string' ? ui.icon : null,
                metadata,
                locked: !!json.locked,
                resolvable: true,
            };
        });
        // Persist heals silently (no event: nothing the user did changed).
        if (healed) this.#runtime.state.configStore.set('pins', pins);
        return resolved;
    }
}
