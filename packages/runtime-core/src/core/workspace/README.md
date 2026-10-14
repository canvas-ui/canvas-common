# Workspace runtime

`Workspace.js` owns lifecycle and the public API. It delegates to collaborators
by responsibility; transports should depend on that facade, not on collaborators
or their mutable state. This keeps the existing local/remote host boundary usable
when child-process hosting is introduced. Hosting still runs in-process here.

- `configuration/`: config, paths, defaults, migration and portability settings.
- `security/`: membership, tokens, access and encryption.
- `documents/`: document writes, placement, copying and trash operations.
- `queries/`, `trees/`, `navigation/`: queries, tree operations and pins.
- `inference/`: embedding eligibility, scheduling and content preparation.
- `storage/`: workspace-facing backend, container, object and transfer APIs.
- `storage/index/`: Stored integration, document projection, rescans, replicas,
  content resolution and thumbnails. `WorkspaceStoredIndex` owns its lifecycle.
- `services/`: independently managed mail, connectors, hooks, storage policies,
  contacts, messaging, Git and trash services.
- `discovery/`, `portability/`: workspace discovery and archive handling.
- `runtime/`: local state, lifecycle helpers, pending-operation diagnostics and
  remote workspace proxies.

Import directly from the functional directories. `canvas-common/packages/runtime-core`
carries the same workspace implementation for standalone hosts.

## Serialization and cancellation

Stored serializes physical mutations. Nested physical calls share their owning
scope; independent event observers detach from that scope. Document projection
uses a separate queue; Stored events enqueue projection without waiting for it
while holding the physical mutation lock. Object APIs can await projection after
the physical mutation completes. Synapsd owns database write serialization.

Rescans and directory moves reserve a per-backend namespace. A completed scan is
required before absence reconciliation. Cancellation must reach Stored as well
as the document adapter, including an empty snapshot with no file callbacks.
Incomplete, cancelled or unavailable-root scans cannot establish absence.

Storage-policy events coalesce into one background reconciliation plus a dirty
flag for a follow-up. Explicit operations retain FIFO ordering. Reconciliation,
scan ingestion, tree loading and receipt processing yield periodically so an
already-resolved promise chain cannot monopolize the event loop.

## Investigating a stall

Pending-operation warnings do not require `DEBUG=*`:

- `Workspace operations still pending`: public operation/startup stage and age.
- `Workspace storage operations still pending`: scan or document projection.
- `backend.initialize:<name>` in a storage report identifies a pending backend
  root preparation. File backend registration and path ingestion use async
  filesystem calls so an unavailable NAS does not synchronously block Node.
- `Stored mutation still pending`: physical holder and queued mutation count.
- `Synapsd write still pending`: active database writer and waiting callers;
  threshold configured with `CANVAS_SLOW_WRITE_MS` (default 1000 ms).

`workspace.runtimeDiagnostics` exposes the workspace's pending operations to
local diagnostic callers. Reports omit operation arguments and document data.
They never abandon a write, unlock it early, or retry it concurrently. A blocked
event loop or native call also prevents these timers from firing; lack of a
warning is therefore not proof that nothing is blocked.

For a live, CPU-bound stall, copy `canvas-server/scripts/profile-runtime.mjs`
alone to the remote host; no dependency installation or server restart is needed.
Run it there with Node 22 or newer as the server user (or root), using the actual
server Node PID:

```sh
node /tmp/profile-runtime.mjs --pid NODE_PID --enable-inspector --stack --seconds 10
```

The collector verifies the inspector's PID, samples CPU at 100 Hz, and prints
hot functions plus an optional JavaScript stack. `--stack` briefly pauses and
immediately resumes the target. It does not request variables, scopes, source
code or document content. A late-attached CPU profile can omit the function
already executing an endless loop; the stack snapshot covers that case. A
snapshot timeout cancels the deferred pause and still preserves the profile.
The profile is written to an exclusive, mode-0600 file in `/tmp` by default.

`--enable-inspector` opts into SIGUSR1 if no inspector is available. Node starts
its inspector using its configured listen address (normally `127.0.0.1:9229`);
keep that port local. The collector connects only to loopback, leaves the
inspector enabled after disconnecting, and never restarts the server, triggers
a rescan or changes workspace data. Copy the printed summary and stack for
investigation before redeploying. A native CPU loop may not service inspector
requests; a timeout alone does not identify the native operation.

`DEBUG=canvas:synapsd` also identifies which tree is initializing. Directory
hydration rejects repeated/cyclic node references with `CORRUPT_TREE`, without
rewriting the persisted tree. Parent-path lookup detects cycles as well.
Treat that error as evidence for an offline investigation against a copy, not
permission to reset or reconstruct the user's database automatically.

Three live Universe CPU profiles on 2026-10-14 identified the dominant hot path:
`StoragePolicyService.#reconcile -> #documentPlan -> #latest ->
ReplicaService.list -> LMDB/msgpack decode`. That path occupied about 64–80% of
sampled time, with 16–21% attributed separately to garbage collection. The old
implementation decoded the full replica-operation ledger for every document;
resolved promises between documents did not give sockets a turn.

Stored now builds an owner-to-latest-receipt lookup once, reads current receipt
state directly, and updates the lookup on submission without invalidating it on
completion. Membership changes/rollback still invalidate it. Reconciliation
yields during paging, document/folder planning, validation and submission. Its
regression uses 2,000 documents and 8,000 real LMDB receipts: one history scan,
with an HTTP response delivered while planning is still in progress. Synapsd
also skips document-page offsets in the cursor before decoding and reuses tree
bitmap collections instead of constructing/logging them for each membership
lookup. Those repeated collection log lines are not evidence of a stalled tree
startup.

The live database has not been modified or replayed locally; verify the deployed
runtime against the same workload. Reconciliation requires Stored's indexed
`latest` API (1.13.0 or newer) and reports `STORED_UPGRADE_REQUIRED` if an old
installed dependency would bring back the full-scan fallback. The separate
regressions for tree corruption and unavailable filesystems are defensive
coverage, not evidence that either caused this captured incident.

## Testing sibling checkouts

From `canvas-server`, use `node --import ./scripts/local-runtime-sources.mjs
--test ...` to resolve Stored and Synapsd from the sibling repositories. Set
`CANVAS_SERVER_HOME` and `CANVAS_USER_HOME` to disposable directories for tests.
`npm run dev:runtime` uses the same opt-in resolver for a development server.
Normal `npm run dev` uses installed dependencies: editing a sibling checkout
alone does not update those installed copies or their Git lockfile revisions.

## Email content and mailbox reads

Mailbox list/search/session responses contain email metadata and a bounded
`data.bodyPreview`. They read the local index; browsing never waits for IMAP.
The web client paints a cached page immediately, revalidates it against the
index, and receives subsequent sync changes through workspace events.

New IMAP and sent-mail records retain the original `.eml` and attachment blobs
in the workspace blob store. `data.body` and `data.bodyHtml` are omitted from
LMDB after those writes succeed. Existing inline records are not bulk-rewritten
or deleted; their full content remains readable, but is omitted from lists.

`GET /workspaces/:id/documents/:docId/content?format=email` returns the selected
message's parsed `{ body, bodyHtml }`; the public-share content route supports
the same format after its visibility check. Without the format parameter the
content route still returns the original bytes. MIME attachment streams are
drained rather than embedded into the body response; CID references use their
existing attachment URLs. Viewers, quoted replies/forwards, and full-document
agent reads load body content only when requested. Missing sources must not be
exported as preview-only `.eml` files.

Inference resolves full plaintext from the saved message, including HTML-only
mail, and adds subject, sender, recipients, date and preview to the embedding
input. This transient text is not written back to `data`. Existing filing
eligibility for inference is unchanged. Searchable index fields include the
subject, preview, parties and any generated summary; new emails no longer
store the entire body in the keyword index. Body rules use the preview when
no inline body exists.

Deploy the server/shared runtime, Synapsd 3.23.7 (optional Email body fields),
and the web client together. Refresh the server's locked Synapsd dependency
when installing the release. Mail and connector checkpoints now share one
serialized config update path, preventing parallel syncs from losing another
mailbox's saved UID cursor.
