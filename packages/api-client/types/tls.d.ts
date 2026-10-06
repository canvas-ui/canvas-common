export interface ClientTls { certFile: string; keyFile: string }
export class ClientTlsError extends Error { code: string }
export function normalizeTls(tls?: ClientTls | null): ClientTls | undefined;
export function resolveTls(tls?: ClientTls | null, env?: Record<string, string | undefined>): ClientTls | undefined;
export function loadTls(baseUrl: string, tls?: ClientTls): (ClientTls & { origin: string; cert: string; key: string; fingerprint: string }) | undefined;
export function createTlsTransport(baseUrl: string, tls?: ClientTls, options?: { fetch?: typeof fetch }): {
    fetch: typeof fetch; socketOptions: { cert?: string; key?: string; rejectUnauthorized?: boolean; agent?: unknown; transports?: unknown[] }; dispose(): Promise<void>;
};
