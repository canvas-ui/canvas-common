import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Atomic, serialized session snapshots. Keep auth separate from conversation
// documents and never expose it via the connector config API.
export async function openAuthState(root, lib, secrets = null) {
    const file = path.join(root, 'session.json');
    let stored;
    try {
        const raw = await fs.readFile(file, 'utf8');
        const envelope = JSON.parse(raw);
        if (envelope.secretRef && !secrets) throw new Error('Workspace secrets must be unlocked for this session');
        stored = JSON.parse(envelope.secretRef ? secrets.open(envelope.secretRef) : raw, lib.BufferJSON.reviver);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const creds = stored?.creds || lib.initAuthCreds();
    const keys = stored?.keys || {};
    let pending = Promise.resolve();
    const save = () => {
        const json = JSON.stringify({ creds, keys }, lib.BufferJSON.replacer);
        const task = pending.then(async () => {
            const sealed = secrets ? secrets.seal(json, path.basename(root)) : json;
            const serialized = sealed.startsWith('secret://') ? JSON.stringify({ secretRef: sealed }) : sealed;
            const temp = `${file}.${crypto.randomUUID()}.tmp`;
            const handle = await fs.open(temp, 'wx', 0o600);
            try { await handle.writeFile(serialized); await handle.sync(); }
            finally { await handle.close(); }
            await fs.rename(temp, file);
        });
        pending = task.catch(() => {});
        return task;
    };
    return {
        state: { creds, keys: {
            async get(type, ids) {
                const result = {};
                for (const id of ids) {
                    let value = keys[type]?.[id];
                    if (type === 'app-state-sync-key' && value) value = lib.proto.Message.AppStateSyncKeyData.fromObject(value);
                    if (value) result[id] = value;
                }
                return result;
            },
            async set(updates) {
                for (const [type, entries] of Object.entries(updates)) {
                    keys[type] ||= {};
                    for (const [id, value] of Object.entries(entries)) {
                        if (value == null) delete keys[type][id]; else keys[type][id] = value;
                    }
                }
                await save();
            },
        } },
        saveCreds: save,
        flush: () => pending,
    };
}
