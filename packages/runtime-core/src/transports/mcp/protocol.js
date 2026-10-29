import { createRequire } from 'node:module';

export const PROTOCOL_VERSION = '2026-07-28';
const prefix = 'io.modelcontextprotocol/';
const { version } = createRequire(import.meta.url)('../../../package.json');
const serverInfo = { name: 'canvas-server', version };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function rpcError(id, code, message, data) {
    return { jsonrpc: '2.0', ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
        error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function complete(id, value) {
    return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...value, _meta: { [`${prefix}serverInfo`]: serverInfo } } };
}

export function requestMetadata() {
    return { [`${prefix}protocolVersion`]: PROTOCOL_VERSION, [`${prefix}clientCapabilities`]: {} };
}

function encodeHeader(value) {
    return /^[\x20-\x7e]+$/.test(value) && value.trim() === value && !/^=\?base64\?.*\?=$/.test(value)
        ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Mirrors a custom-transport request into HTTP without adding protocol metadata. */
export function requestHeaders(message) {
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const version = message?.params?._meta?.[`${prefix}protocolVersion`];
    if (typeof version === 'string') headers['mcp-protocol-version'] = encodeHeader(version);
    if (typeof message?.method === 'string') headers['mcp-method'] = encodeHeader(message.method);
    const name = message?.method === 'resources/read' ? message.params?.uri : message?.params?.name;
    if (['tools/call', 'resources/read', 'prompts/get'].includes(message?.method) && typeof name === 'string') headers['mcp-name'] = encodeHeader(name);
    return headers;
}

function decodeHeader(value) {
    if (typeof value !== 'string' || [...value].some(char => char !== '\t' && (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126))) return undefined;
    if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
    const encoded = value.slice(9, -2);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return undefined;
    const decoded = bytes.toString('utf8');
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : undefined;
}

/** Return a transport error before any tool dispatch can occur. */
export function validateRequest(message, headers) {
    const error = (code, text, data, status = 400) => ({ status, body: rpcError(message?.id, code, text, data) });
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || (message.id !== undefined && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) {
        return error(-32600, 'Invalid Request');
    }
    if (message.params !== undefined && !isObject(message.params)) return error(-32602, 'Invalid params');
    if (message.id === undefined) return error(-32601, 'Client notifications are not supported');
    const meta = message.params?._meta;
    if (!isObject(meta) || typeof meta[`${prefix}protocolVersion`] !== 'string' || !isObject(meta[`${prefix}clientCapabilities`])) {
        return error(-32602, `Required metadata: ${prefix}protocolVersion and ${prefix}clientCapabilities`);
    }
    const version = meta[`${prefix}protocolVersion`];
    if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== message.method) return error(-32020, 'Header mismatch: MCP-Protocol-Version or Mcp-Method');
    if (version !== PROTOCOL_VERSION) return error(-32022, 'Unsupported protocol version', { supported: [PROTOCOL_VERSION], requested: version });
    if (['tools/call', 'resources/read', 'prompts/get'].includes(message.method)) {
        const name = message.method === 'resources/read' ? message.params?.uri : message.params?.name;
        if (typeof name !== 'string') return error(-32602, 'Missing name or uri');
        if (decodeHeader(headers['mcp-name']) !== name) return error(-32020, 'Header mismatch: Mcp-Name');
    }
    const accept = String(headers.accept || '').split(',').map(part => part.split(';')[0].trim());
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return error(-32600, 'Accept must include application/json and text/event-stream', undefined, 406);
    return null;
}
