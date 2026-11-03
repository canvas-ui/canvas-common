# @augmentd-labs/canvas-api-client

Fetch-based Canvas REST client built on `@augmentd-labs/canvas-protocol`. Consolidates the
REST access every client was reimplementing; scope grows client-by-client
(the cli's surface came first).

```js
import { CanvasApiClient } from '@augmentd-labs/canvas-api-client';

const api = new CanvasApiClient({
    baseUrl: 'https://canvas.example.com:8001',
    getToken: () => tokenStore.current(), // called per request
    userAgent: 'canvas-cli'
});

const workspaces = await api.workspaces.list(); // unwrapped payload
```

## Behavior notes

- **Envelope handling is centralized**: success envelopes resolve to their
  `payload`; error envelopes throw `CanvasError` with the machine `code`
  string (e.g. `WORKSPACE_NOT_ACTIVE`) and numeric `statusCode` — regardless
  of the HTTP status they rode in on.
- **Policy stays with the caller.** No auto-redirect on 401, no workspace
  autostart; the client surfaces typed errors and callers decide
  (`isWorkspaceNotActive` from `@augmentd-labs/canvas-protocol`, `isNetworkError` from
  here).
- **`isNetworkError`** matches both undici/node codes (`ECONNREFUSED`, …) and
  Bun's fetch codes (`ConnectionRefused`, …) — the same code runs under node
  and inside bun-compiled binaries.
- **Bodies**: plain objects/arrays are JSON-encoded (Content-Type set for you);
  `Buffer`/`Blob`/`Uint8Array`/strings pass through; web `ReadableStream` and
  Node `Readable` upload as streams (`duplex: 'half'`). No body-size caps.
- **Timeouts** use `AbortSignal.timeout` (default 30 s, same as the historical
  clients); per-request `timeout: 0` disables.
- Query serialization is axios-parity: `null`/`undefined` skipped, arrays as
  repeated keys, booleans stringified (`recursive=false` reaches the wire).

### Native client certificates

The native-only `@augmentd-labs/canvas-api-client/tls` entry point provides
`normalizeTls`, `loadTls`, `resolveTls`, and `createTlsTransport(baseUrl, tls)`.
The browser entry point remains filesystem-free.

```js
import { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
import { createTlsTransport } from '@augmentd-labs/canvas-api-client/tls';
const transport = createTlsTransport('https://canvas.example.org', {
  certFile: '/absolute/path/client-chain.crt',
  keyFile: '/absolute/path/client.key',
});
const client = new CanvasApiClient({ baseUrl: 'https://canvas.example.org', fetch: transport.fetch });
// Socket.IO: spread transport.socketOptions last, so its native transport is retained.
// io(baseUrl, { auth: { token }, ...transport.socketOptions });
try { await client.ping(); } finally { await transport.dispose(); }
```

The PEM chain starts with the client certificate, followed by its issuing
intermediates. RSA and EC keys must be unencrypted; protect the private key with
user-only filesystem permissions. Private-key contents never enter remote JSON.
System trust still verifies the server. A private client CA belongs in nginx's
`ssl_client_certificate`; it is not the client's server trust bundle.

TLS requests stay on the configured HTTPS origin. Cross-origin redirects are
rejected, and consumed streaming uploads cannot be replayed through redirects.
Abort signals and streaming bodies pass through. `socketOptions` contains secret
key material: pass it directly to Socket.IO, never persist or log it. Both Node
and Bun use an explicit native WebSocket transport and HTTPS agent.

Run the nginx integration test with `CANVAS_TEST_BUN=/path/to/bun node --test
packages/api-client/tests/tls.test.js` from canvas-common. It requires nginx and
OpenSSL and uses generated test certificates and isolated loopback ports.
