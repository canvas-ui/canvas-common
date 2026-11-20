import compression from 'compression';
import { constants } from 'node:zlib';

const compress = compression({
    threshold: 1024,
    level: 4,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    filter(request, response) {
        if (request.headers.range || request.headers['x-no-compression'] !== undefined
            || response.statusCode < 200 || [204, 205, 206, 304].includes(response.statusCode)
            || response.hasHeader('Content-Range')) return false;
        const type = String(response.getHeader('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
        // Incremental events must reach the client without a compression buffer.
        if (['text/event-stream', 'application/x-ndjson', 'application/ndjson', 'application/json-seq'].includes(type)) return false;
        return compression.filter(request, response);
    },
});

/**
 * Compress at the HTTP response boundary, including raw WebDAV replies and
 * hijacked workspace proxy streams. Upstream/cache bytes remain unchanged;
 * negotiation, Vary, Content-Length and backpressure belong to this boundary.
 */
export function installResponseCompression(server) {
    server.addHook('onRequest', (request, reply, done) => {
        compress(request.raw, reply.raw, done);
    });
}
