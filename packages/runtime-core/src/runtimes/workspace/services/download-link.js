import { assertPublicUrl, guardedDispatcher } from '../../../utils/ssrf-guard.js';
import { Readable } from 'node:stream';
import { filenameFromResponse, USER_AGENT } from './fetchers/lib.js';

/** Save a link's bytes as a related file without replacing the source object. */
export async function downloadLink(workspace, doc, { fetchImpl = fetch, maxBytes = 2 * 1024 ** 3 } = {}) {
    const url = doc.data?.url || doc.data?.uri;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Document has no HTTP link');
    const signal = AbortSignal.timeout(120_000);
    let currentUrl = url;
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
        assertPublicUrl(currentUrl, { allowHttp: true });
        response = await fetchImpl(currentUrl, {
            redirect: 'manual', signal, dispatcher: guardedDispatcher, headers: { 'user-agent': USER_AGENT },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        const next = response.headers.get('location');
        if (!next || redirects === 5) throw new Error('Download redirect limit reached or missing destination');
        currentUrl = new URL(next, currentUrl).href;
    }
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const filename = filenameFromResponse(response, response.url || currentUrl, `document-${doc.id}`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    const source = Readable.fromWeb(response.body);
    const bounded = Readable.from((async function* () {
        let size = 0;
        for await (const chunk of source) {
            size += chunk.length;
            if (size > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes`);
            yield chunk;
        }
    })());
    let blob;
    try { blob = await workspace.persistBlob(bounded); }
    finally { bounded.destroy(); source.destroy(); }
    const id = await workspace.put({
        schema: 'data/schema/file', schemaVersion: '3.0',
        checksumArray: [`sha256/${blob.checksum}`],
        data: {},
        locations: [{ url: blob.url, metadata: { filename } }, { url, metadata: { filename } }],
        metadata: { filename, contentType, size: blob.size, sourceUrl: url },
    }, { context: null });
    await workspace.assertRelation(id, 'derived-from', doc.id);
    await workspace.assertRelation(doc.id, 'includes', id);
    for (const placement of await workspace.listDocumentPlacements(doc.id)) {
        if (placement.tree === 'backends' || !placement.paths.length) continue;
        const selector = { tree: placement.treeId, path: placement.paths };
        await workspace.link(id, placement.type === 'directory'
            ? { context: null, directory: selector } : { context: selector });
    }
    return { documentId: id };
}
