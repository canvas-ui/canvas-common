# Workspace storage policies

The workspace resolves virtual placements into an ordered list of exact physical
destinations. Stored accepts that list as one durable operation for an opaque
owner. Stored never interprets context paths, document schemas or hook rules.

Policies are in `workspace.configDir/storage-policies.json`, outside the hook
repository. `GET /workspaces/:id/storage-policies` returns the list, revision,
backend capabilities and operation status. `PUT` requires the revision returned
by GET; a stale edit fails with 409, a missing revision with 428. Configuration
writes use a temporary file, fsync and atomic rename. Invalid or unreadable
configuration blocks planning; it never means “remove every replica.”

```json
{ "policies": [{
  "id": "accounting", "kind": "mirror", "enabled": true,
  "path": "ctx:/Accounting", "recursive": true,
  "targets": [
    { "backend": "workspace:home", "folder": "Accounting", "recursive": true,
      "recreateDirectories": true, "onConflict": "error" },
    { "backend": "archive", "folder": "Accounting", "recursive": true,
      "recreateDirectories": true, "onConflict": "error" }
  ]
}] }
```

`archive` must be a configured, writable file backend with recovery support.
Use a separate `kind: "filing"` policy for date/name templates or permanent
exports. Filing copies remain after unfiling. Mirror targets have stable paths
and recoverable removal. Google Drive and S3-compatible backends currently
support filing creates only (`onConflict: "error"` or `"rename"`); mirroring and
overwrites are rejected until each driver meets the same recovery contract.
S3 uses real conditional creates and checks endpoint support before admission;
single PUT uploads are limited to 5 GiB. Neither backend becomes a mirror just
because it can read/index remote files. Note rendering and layer metadata remain
deferred. See [Stored's S3 configuration and limits](../../../../../../canvas-stored/README.md#s3-compatible-backend).

## Execution and identity

- All matching policies contribute destinations in configuration order. Exact
  duplicate destinations are combined; incompatible instructions at one key
  produce an error. No policy-order or naming-conflict resolution is inferred.
- Uploads stage in `workspace:data`. Stored pins an immutable source version,
  verifies every exact destination, retires obsolete owned copies through Trash,
  verifies destinations again, then releases staging. Two keys on the same
  backend count as two destinations. Partial failure retains recovery bytes.
- API/FUSE backend writes also pin ingress locally before publication, including
  newly created files. A new indexed file under a mirror target is projected
  into its virtual path before planning the other replicas. Outside mirrors,
  the requested primary destination is verified before the ingress pin is
  released. API-created empty folders likewise project into the virtual tree.
- Mirrored file edits and renames preserve the document ID. Byte checksums and
  row versions change independently. A managed old replica is updated using its
  recorded version as the precondition. A conflicting edit on another replica
  blocks propagation. A content identity already assigned to a different
  document blocks projection rather than merging document identities silently.
- Placing an already indexed source into an explicit mirror adopts that exact
  source location. An equal but unrelated destination is not automatically
  claimed for deletion. Shared physical replicas are not retired while another
  owner or unfinished operation still needs them.
- Leaving the last mirror stages bytes back into the blob store before removing
  managed copies. Orphan document cleanup is a separate lifecycle. Disabling or
  deleting a policy preserves existing physical copies.
- Proactive directories are protected from pruning. Automatic retirement removes
  only empty owned directories. An explicit backend folder deletion trashes the
  original whole folder, including hidden/unindexed files; it does not sweep
  unknown children on other replicas.

## Logical recovery and observations

Startup, events and a 30-second reconciliation pass all resolve current desired
state. A complete document/placement/config read is required before retirement.
Completed replicas receive a full byte audit on first reconciliation and at most
once per 15 minutes per completed operation; placement and cache-release barriers
always verify bytes. Physical observations run continuously. Detected drift is
reported; an unavailable mount is never interpreted as intentional deletion.

API/FUSE folder moves persist a logical intent before the Stored namespace move.
Stored's operation receipt makes retries safe; the workspace resumes virtual
projection before planning other replicas. Context-tree projection recreates
only the selected branch because layer names are shared. Explicit API file and
folder deletions also persist their logical unfiling intent before execution.

The workspace consumes Stored's durable physical change feed. Provenance marks
replication and coordinated namespace writes so their observations do not become
new user intent. A confidently paired filesystem file rename can be propagated.
Unpaired deletion, a missing change-feed segment, ambiguous flat mapping,
concurrent edits, or a move outside a mirror root blocks automatic propagation.
Filesystem folder renames without an explicit API intent are not inferred as
complete folder moves. API/canvas-fuse is the supported namespace mutation path
for the pilot; unrestricted Samba folder manipulation needs further inference
and recovery validation.

## Operator surface and validation

Settings shows outstanding operations and exact target outcomes, including the
last error. Retry uses `POST /storage-policies/operations/:operationId/retry` and
reuses the accepted plan. A newer content edit can supersede unfinished older
work: verified partial effects become its baseline and old staging is retained
until the successor completes. Changing policy instructions alone does not
rewrite an unfinished operation; resolve its reported conflict first. Apply-to-existing invokes a full
reconciliation, including overlapping policies. Completion is asynchronous.

Stored runs its executor inside the owning process currently, with a durable
journal and a Linux OS lock (requires `util-linux`/`flock`, included in the server
image). Running it as a standalone syncd requires an
IPC adapter; a second process must not open an independent executor on the same
state. Deploy the updated Stored and server together. An old Stored dependency
exposes policy execution as unavailable rather than falling back to hook deletes.

Tests cover exact-target barriers, partial failures, restart and abrupt process
exit during placement/release/retirement, shared ownership, unknown folder
children, open-handle edits, cache collection, API rename/delete, stable document
IDs and a failed folder projection replay. This suite does not establish behavior
under power loss or every network filesystem's durability semantics. Production
ZFS snapshots and backups remain independent recovery layers.
