# @augmentd-labs/canvas-protocol

The Canvas wire contract, client side: the response envelope shape, machine
error codes, `/rest/v2` route builders and websocket (Socket.IO) event names.
No transport implementation lives here — this package is constants, path
builders and predicates with zero dependencies.

The enforcement peer is the server: `canvas-server/src/transports/ResponseObject.js`
produces the envelope this package describes, and `canvas-server/docs/API.md`
is the human-readable reference it was authored from. The server's
`src/transports/api-contract.js` is unrelated fastify plumbing and deliberately
not part of this contract.

## Coverage rule

`routes.js` covers what shipped consumers actually call (currently: the cli via
`@augmentd-labs/canvas-api-client`, plus ping and schema lookups). It is **not** a
transcription of all of API.md — routes are added when a consumer lands, so
every entry is verified by real usage.

Path builders return paths **relative to the API base** (`/rest/v2`); clients
join `baseUrl + API_BASE + path`.

Encoding parity note: builders encode exactly the segments the existing clients
encode (`driver`, `address`, tree names) and pass hierarchical paths (hook
paths, tree paths, schema ids) through raw, because the server routes them via
splats. Do not "fix" this by encoding everything.
