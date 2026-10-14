import { setImmediate } from 'node:timers/promises';

// Commit bounded writes and yield to HTTP/socket work between them. Awaiting
// LMDB promises alone can keep a large purge on the microtask queue for minutes.
export async function deleteDocumentsInBatches(workspace, ids, options = {}) {
    const result = { successful: [], failed: [], count: ids.length };
    for (let offset = 0; offset < ids.length; offset += 100) {
        await setImmediate();
        const batch = await workspace.deleteMany(ids.slice(offset, offset + 100), options);
        for (const key of ['successful', 'failed']) {
            for (const entry of batch[key] || []) {
                result[key].push({ ...entry, index: entry.index + offset });
            }
        }
        // Leave the remaining folder membership intact for a retry.
        if (batch.failed?.length) break;
    }
    return result;
}
