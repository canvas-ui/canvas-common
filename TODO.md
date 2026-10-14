# TODO

## User workflows

### Ad-hoc problem(task) container 
- User gets an email - API GW connection filtered from SRC A to DST B
- User creates a context tree folder - customer://ops/infra/apigw/issues/FW SRC A TS
- User links the aforementioned email to that path based on a subject substring and thread ID
- Adds/links related notes, documents, emails, chat messages, if running canvas-desktop open windows
- Pins that task to the in-workspace pin(todo) list
- Optioanlly adds/assigns people/agents/watcheres
- Switches to another task

## Sortable workspace-local + global pinning

We have a new UI comming soon thats in some extent already described in

With that being said, untill all the drawings and flow diagrams are ready, we can implement 
some of the features in the current "classical" UI too.

One important one - pins
Every tree node (folder) - regardless whether of type context or directory - represents 
something like a task container, It holds all data (and later workflows) to help contextualize 
work seamlessly.

Related to the use-case above, a user should be able to pin a specific path to allow easier 
"context switches" for tasks he is activelly working on. We will require the same functionality
for at least the desktop UI so most probably, it should be implemented on the backend too(separate
API endpoints maybe). 

Pins are per-workspace, one should be able to right-click on a path and Pin/Unpin it
We should add a Pins tab into M2
- M2 tabs should be sortable, users who default to the directory tree view should have the option to 

Pins should be shown as tiles, Folder name as title, full path as subtitilee and maybe a few stats
read from metadata or doc count (we can ommit for now), tiles should be prominent - since each
"layer" can store metadata we should show its color and icon if present

Let me descope the UI update for now, we'll work on it once the above landed

LANDED 2026-09-07 (server 2.8.5, web 2.9.1, protocol routes `workspaces.pins`):
- Backend: workspace.json `pins[]` (ordered; `{id, tree, path, layerId, label, createdAt}`),
  `GET/POST/DELETE /workspaces/:id/pins`, `DELETE /pins/:pinId`, `PATCH /pins/order`;
  GET resolves each pin against the live tree (label/description/color/icon/locked +
  `resolvable`), self-heals renamed/moved folders via layerId, keeps deleted ones flagged;
  `pins.changed` on the workspace ws channel. Pins are workspace-level (shared by members),
  not per-user — the older per-user home `pinnedCanvases` list is untouched.
- Web: Pins tab in the workspace M2 (tiles: icon well tinted with layer color, label,
  `tree:/path`, description, unpin, drag-sort), Pin/Unpin in the tree context menu
  (context + directory trees), M2 tabs drag-sortable, order kept per user in the webui
  config (`m2.tabOrder`) — the first tab is what a bare /workspaces/<name> opens on.
- Not done: tile stats (doc counts), global cross-workspace pin list, desktop UI.


## (legacy) UI revamp

Lets do an experiment
Not sure whether this can be considered a "theme" or a revamp as stated in the title - lets 
go with the simplest least-complex approach.

Same as with architecture where natural materials like wood and stone create pleasing harmonies
when combined with artificial surfaces like glass, (brass) metal and/or contrasting accents
(switches, faucets, radiators, lightning) - the most beautiful user interfaces (to me) are 
a combination of analog-like, rough and/or layered and/or structured and smooth, clean "digital" 
elements interacting in a physically believable way.

Our UI should present its elements in a physically-believable way too(we'll dive into the 
contrast and color space later).

Lets start with the layout. As with the "Next" UI concept, main controlls should be 
Left/Right/Up/Down (keyboard handle + arrow-keys or swipe) with both, horizontal and vertical
spaces virtually devided into rows and columns.

Lets take the workspace flow as an example.
M0 is the most-left element, M1 comes/appears to the right to it. M2 should not overlay M1, 
it should appear next to it focusing it into the view but kb left or swipe-left would navigate 
back to M1.

Clicking an M2 item opens-up a 1/sqrt(2) ratio ISO 216 content card/canvas (same top-bottom 
margin, only width gets calculated) - keeping m2 left-most and said card as the main area
(user shoul be able to extend to full view size as is the case now by default)

Menu is considered part of the backround surface area. When you click on Workspaces, inactive 
workspaces in M1 are still considered on the same layer, activating a workspace elevates it 
(our card-like shadow-dropping design).


Now the difference compared to the menu.
Shift+click on a tree item opens a new canvas tab (for now) on the same columnd space as the
main canvas(lets say canvasA)
Opening a modal or another canvas from canvasA will open a canvas next to it
Returning back wont auto-close it
Opening canvasA > Modal with 4 relationships to other documents would open a related document
right to it, focusing it. Returning back (kb left or swipe) and shift+opening a 2nd relationship
would open it as the main canvas moving the other one on top of the current one (or into a tab
for now)

Where we are heading with this prototype:
A row of canvases as drawn below
```
         []
         []  []
[pinA] [][][][][]
[pinB]     [] 

```
is related to a specific task [pinA]
Currently, navigating away in the tree menu destroys the old layout but esp in canvas-desktop
for pinned items we'll use a different setup
a pinA item may have 4-5 open canvases (active conversations, open terminal windows etc)
Switching to pinB will vertically navigate to the pinB row of canvases (navigatable in all 
4 directions)

Again, this is a window-management feature that should support organizing canvases in 4 main 
directions + tabbed + tiled which is mostly irrelevant in a webui setting but just to 
give you an idea where we are heading.


## Editor registry + sketches

SHIPPED 2026-09-02 (web 2.8.0, synapsd 3.19.0, server 2.6.3): editor registry
contract (`canvas-web/src/components/editors/registry.ts`), Excalidraw sketch
applet (`/apps/sketch`, toolbox Apps tab, Add → Sketch everywhere), schema
`data/schema/drawing` (scene JSON = source of truth, PNG preview blob →
thumbnails/cards/FUSE/WebDAV/offline all work unchanged), self-hosted fonts
(`/excalidraw/fonts`, esm.sh fallback allowed in font-src). 2.8.1: sketch
thumbnails in table/tile/card document views + gallery/mosaic widgets, and
"Edit sketch" opens the full editor from the document modal/side card.
Leftovers:

- [ ] Text inside scenes is not searchable — extractor should fold scene text
      elements into FTS (same pattern as File's `metadata.text.content`).
- [ ] Large pasted images inflate `data.scene` (embedded files are base64) —
      consider a size cap or externalizing scene files into blobs.

### Video trim (LATER — job, not editor)

- [ ] No browser editor, no ffmpeg.wasm. UI = existing `<video>` player + a
      two-handle range slider; "cut" = one server-side ffmpeg job
      (`-ss/-to -c copy` keyframe cut, near-instant, no re-encode) persisting a
      NEW document linked at the same path. Registry entry whose "editor" is a
      thin parameter UI over that endpoint; agent-invokable.

### Iframe + postMessage applet host (ONLY when a concrete tool demands it)

- [ ] For non-React / untrusted tools: sandboxed iframe + tiny window-message
      protocol (`getDocument`, `saveDocument(schema, payload, blob)`,
      `getContext`) — VS Code webview / Figma plugin model. Deliberately deferred.

## Next UI

### Main objectives!

Dates back to my early `iolinux` linux distribution endeavors with a ro-root and movable containerized user-runtimes dynamically installing your sw on-demand when needed(aot).

- Contextualize your work! Working on a specific task? De-clutter your UI and only see data(notes, files, messages, browser tabs etc) related to the task
- Share and collaborate on top of your Data, Context, Canvases aaand whole Workspaces with others
- Cross device, every screen or even simple single-purpose compatibile HW should extend the UI
  - Filter with swipe gestures on your phone running the toolbox UI and send results of your data analysis to your TV side-by-side with your favorite podcast
- Simple navigation (up/down/left/right + rotation + click + doble-click + optional gestures depending on HW - your smart ring should be able to control the UI seamlessly)
- Every task starts with a single clean canvas and one globally available button next to it triggering voice mode by default
- Objective/outcome focused UI, no OS crap bleading-in, pure content contextualized to whatever task you are working on
- No controll clutter, no multilevel Menu > Amend image > Graphical crap > Some other crap sub-category > Layer tool that you need so spend years learning, a single toolbox with a contextualized set of tools and a global always available section - both as fallback to voice
- Roaming profiles are the default - login to your workstation then your laptop then any other device, authenticate and continue where you leff - start your work in voice-mode while driving, finish on your workstation+monitor setup, review on tablet while sipping coffee
- Fine grained storage policies, backup your accounting data to S3 and local NAS, your photos to google drive and glacier, your podcasts to locally or to your local NAS
- Intelligent data categorization - define a tree structure and tell your agents to sort specific data automatically when you dump them - have 1000 browser tabs you finally want to get stored? Sync them to /to-sort, run a hook to sort them into existing tree categories and optionally write summaries of each one(or download a local copy)

- Canvases are organized into virtual threads centered around a given task(in context mode)
- Switching between tasks has to be as moving from a well-maintained desk with a task-tuned toolbox and a bunch of canvases on to another well-maintained desks
- Canvases can be organized vertically or horizontally or tabbed
- Switching to a task(anchor)  via the the menu left moves the whole virtual "plane" up or down - displaing task-specific canvases
- Screens or canvases that are opened on other devices will have a small indicator on the top righr corner
- Layout and every single canvas can be LLM controlled, "show me the latest emails for the DC migration project please" folowed by "add the task list to the right" followed by "send this to my team" 

### UI Hierarchy

  - Screen/Viewport
    - Real viewport/computer screen that shows the UI, any screen that connects to the UI should have the option to be named by the user (a default screen is created and autoconnected, rename spins of a named screen)
    - Elements can be sent to a nemed screen or displayed on a named screen as 100% of the available viewport with margins
  - Main "Context" menu (M0/M1/M2)
    - Controlls whether we are in Explorer mode or whether the current screen is bound to a context
    - L2 menu are pinned items shown as tiles with internal details(number of documents, messages etc), 
      hidden by default, available as the left-most elements when swiped/navigated to the left
    - L1 Full tree view, navigate the currently selected workspace trees freely or to change the context url, shows when navigating "left" from L2
    - L0 Main menu that shows when navigating "left" from L1, Current M0
    - Clicking on a pinned tile/item or on a tree node opens a default canvas
    - Shift+clicking 

A tree node can be tought-of as a "task container" - it containes everything related to a given task
Canvases and widgets help to split that view into individual streams/threads 

  - Set of canvases
    - Different behaviour in Explorer and Context mode
      - Explorer mode:
        - Double-click on tree node
        - 
        - 
        - 
        - 
      - Context mode:
        - 
        - 
        - 
        - 

	- Opening a 
    - Canvas is a A2UI/MCP-UI/MCP-APP AI driven dynamic "canvas" with the following layout features
      - Canvas can take the full viewport(with a sane margin)
      - New canvases can appear to the right 
  - Contextualized Toolbox with globally-available elements


- UI Workflows
  - 



## Prose
Great, btw, finally raining here, great as well, I love coding when it rains. Couple of cosmetics to
  keep the cosmetic treatment tempo - Toolbox should also be closable by Esc, same for M1/M2 - sorry
  should have tested that before. One more UI tweak, since we are slowly becoming something I tried to
  build 15y ago - a true desktop overlay - lets add Settings > Appearance > Wallpaper and allow users to
  set a global UI background wallapper (defaults to the current color) - with some basic settings
  "Fill, Scale and Crop, Centered". Another thing - we should be able to add a full content page App 
  (Notes, Todos) as a tab and now the most complex of the pack - we should allow displaying those tabs 
  side-by-side. Now, there are many grid layout engines that are battle-tested that we could reuse - 
  a-la vscode - but before we do any of the layout changes, let me first highlight where we are heading:
  The target *default* UI is simple, you have your toolbox icon on the right bottom which can be moved
  to your phone or any web-capable device and used from there, on the left you have a nice but hidden by
  default list of pinned layers representing "task containers" - a gestre/keyboard shortcut or swipe 
  can list all tasks of your selected workspace you want to work on today or in general. Selecting a 
  layer will bring up all open canvases related to your work that user can navigate with swipe gestures
  on top of his toolbox left-right or top-bottom(canvases in the desktop app may be webviews - a browser
  canvas may be tabbed or stacked on top vertically, swipe up-down will switch through the pages, 
  left-right between lets say your emails, tasks, notes etc. Switching to a different task would load a
  new vertical line of canvases. Switching of workspaces would be one more swipe left from Pinned to 
  Tree to Workspaces. A user willbe able to open a new canvas - doubleclick - tick on the toolbox and 
  voice-mode tell his canvas-ui agent - show me todays emails and open a pinned canvas to the right with
  that podcast from yesterday. So, while this run is not a full-fledge UI revamp - we have our "/next"
  ui skeleton for that - we are essentially building a tiling window manager in browser (nothing new,
  people did that with jquery years ago) hence should pick components that would not gight the stated 
  goal. UI should bring you all information you need for a task in a human-readable way, nothing else, 
  context switches should be as if you'd walk from a perfectly maintained work table with all tools 
  related to task on that table - to a new worktable related to a new tasks with everything prepared


## Rust core, desktop-first runtime (design note 2026-09-07)

Where the project is heading: **most users will download canvas-desktop**
(Rust/Tauri: tray app + UI, used together with the web UI) and never see a
terminal. The CLI was meant to be an Ollama-like single binary; bun gives a
90 MB executable because the runtime IS the binary (all CLI JavaScript is
0.3 MB), and no JS packager does better (Node SEA 100+ MB, Deno ~80-100,
QuickJS has no fs/process). A small static binary means a compiled core,
and the stack already has one language for that: canvas-fuse is Rust, the
desktop shell is Rust. This note is cross-repo (canvas-common, canvas-cli, canvas-desktop, canvas-fuse,
canvas-server, canvas-stored), hence here.

### Decision

1. **`canvas-core` Rust crate** — one substrate for the desktop app, a Rust
   `canvas` CLI and canvas-fuse. Planned under `canvas-common/crates/canvas-core`; canvas-desktop,
   a Rust CLI and canvas-fuse consume an explicitly versioned crate.
   Each integration keeps its own repository and binary.
2. **The desktop path must not depend on Node.** The Rust real-folder mirror
   daemon (below) is the Tauri sidecar/thread; canvas-edge (JS) stays for
   headless boxes and the npm CLI.
3. **JS CLI = npm channel and reference implementation**, package by package
   (`packages/cli-*` boundaries are the porting units). Bun binaries retire
   when the Rust CLI reaches parity; until then they remain the no-Node
   fallback.
4. **Protocol stays JS-owned** (`packages/protocol`): route tables, event
   names, sync constants and the wire shapes are the contract; Rust gets a
   generated/mirrored copy checked by a CI test that both agree (hash of
   the JSON export of `routes.js`/`events.js`/`sync.js` vs the Rust tables).

### What `canvas-core` takes from canvas-fuse (first pass)

| canvas-fuse today | canvas-core module | notes |
|---|---|---|
| `config.rs` (remotes.json, device token, `~/.canvas` layout) | `paths`, `remotes`, `device` | same files the JS CLI writes (`config/remotes.json`, `device.json`, `config/mirrors.json`); byte-compatible, no migration |
| `api.rs` (REST over the workspaces/objects/changes API) | `api` (blocking + async client) | typed against the protocol tables; the fuse render/tree parts stay in fuse |
| `events.rs` (socket.io subscribe, nudges) | `events` | one client for fuse, daemon and tray |
| `mirror/store.rs`, `reconcile.rs`, `sync.rs`, `hub.rs`, `cache.rs` | `sync::{ledger, reconcile, jobs, hub, cache}` | the three-way table + conflict protocol from `docs/sync-protocol.md`; redb stays the store |
| `mirror/control.rs` | `control` | local control socket (`run/edge.sock` / localhost port): status, reload, resync, shutdown — same routes canvas-edge exposes so the CLI drives either |
| `nudge.rs`, `names.rs`, `fsimpl.rs`, `writes.rs`, `state.rs` | stay in canvas-fuse | FUSE-specific |

### New binaries on the crate

- **`canvas-edged`** (working name; Rust twin of canvas-edge) — real-folder
  mirrors: `notify` watcher + the shared `sync` engine over a plain
  directory, state under `<folder>/.workspace/`, reads the CLI's
  `mirrors.json` (`client: "daemon"`), reports to the hub's mirror registry
  exactly like canvas-edge. Runs as the desktop sidecar (tray shows sync
  state, conflicts, pause/resume) and standalone on Linux/macOS/Windows.
  Supervision by the tray app; pm2 only for the headless JS path.
- **`canvas` (Rust CLI)** — grows out of the crate command by command in this
  order: `auth`/`remote` (login, device registration), `remote mirror
  status|sync|init` (drives edged/fuse over the control socket), `ws`/`ctx`
  read paths, then writes. Same grammar and flags as the JS CLI (the JS
  dispatcher's module/noun/verb walk is the spec); `--format json` output
  must be identical so scripts do not care which binary answers.
- **canvas-desktop** — Tauri shell embeds the crate: login + device
  registration on first run, mirror root picker, the same wizard as
  `canvas remote mirror init` as a native dialog, tray with sync status,
  launches the web UI. Browser-extension and web UI remain JS.

### Sequencing

- [ ] `canvas-common/crates/canvas-core` scaffold; move `config.rs` +
      `api.rs` + `events.rs` from canvas-fuse (fuse depends on it by git ref);
      protocol-tables parity test in ci.yml.
- [ ] Move the mirror engine (`mirror/*` minus fuse glue) into
      `canvas-core::sync`; canvas-fuse `--mirror` keeps working on the crate.
- [ ] `canvas-edged` binary: watcher + engine over a folder; e2e against the
      dev hub with the phase-3 scenario table (mirror both ways, offline
      queue, conflict inbox, rename). Ship as `edged-v*` release assets
      (5 to 8 MB per platform) and as the Tauri sidecar.
- [ ] Desktop: first-run wizard + tray + sidecar supervision; `v*` releases in canvas-desktop;
      bundles include edged. `canvas desktop install` (CLI package) points at
      those bundles.
- [ ] Rust `canvas` CLI: auth/remote/mirror first; release as `v*`
      assets in canvas-cli next to the bun binaries, then replace them.
- [ ] Retire: bun `build:*` targets, `packages/cli-mirror`'s fuse/daemon
      supervision (the tray owns it), pm2 paths outside `packages/cli-server`.

### Non-goals / kept as is

- canvas-server stays Node (hub, single DB writer); canvas-stored/synapsd
  unchanged. The hub-side objects/changes API is the only contract the Rust
  side needs.
- No Rust port of the web UI, browser extension or agent runtime.
- The JS `canvas-edge` is not deleted while any headless deployment uses it.

## Target topology (independent integrations + shared packages)

```
canvas-common            shared npm packages: protocol, api-client, schemas, wallpapers
                         runtimes/edge (JS headless/npm device runtime)
                         integrations/kde
                         PLANNED: crates/canvas-core (versioned Rust substrate)
canvas-cli               CLI, shell/, packages/cli-* (SDK and lazy integrations)
canvas-web               web UI
canvas-desktop           Rust/Tauri setup and tray app
canvas-browser-extension Chromium and Firefox extensions
canvas-fuse              standalone Rust filesystem client
canvas-stored            blob storage
canvas-synapsd           context indexing
canvas-server            hub, transports and services
```

Each repository owns its releases and pipelines. Shared package versions are
explicit dependencies; a shared Rust crate would follow the same model.

Only open cross-repository work belongs here. Implemented behavior belongs in
the owning package's README.

## Inferd

Current embedding behavior and service boundaries are documented in
`../canvas-inferd/README.md`.

### General inference

- [ ] Replace the embedding-only provider contract with explicit capabilities:
      `embed`, `describe`, `transcribe`, and experimental `extract`.
- [ ] Route one input to a capability chain. An image may produce an image
      vector, description, text vector, and anchor observations in one pass.
- [ ] Define a streaming API with bounded input queues, cancellation, cadence,
      backpressure, and typed incremental outputs.

### Generated content

- [ ] Write generated text to `metadata.summary` with
      `{ model, generatedAt, sourceChecksum }` provenance.
- [ ] Key derivation work by source checksum. `updatedAt` would create a
      caption-write-recaption loop.
- [ ] Add audio transcription and decide whether existing voice STT becomes an
      inferd provider or remains a Canvas Server adapter.
- [ ] Implement the `text` summarize modality. Config already validates it
      (`config.js` SUMMARIZE_MODALITIES) but only `describeImage` exists, so
      long-body documents (mail, GitHub issues) get vectors and no summary.
### Live feeds

- [ ] Move the current browser frame loop behind a server-side stream consumer
      without changing the QuerySession delta contract.
- [ ] Settle whether feed orchestration is part of inferd or a small sensord
      service. Model execution and projection stay in inferd either way.
- [ ] Generalize feeds beyond camera input: audio, journal output, mail, chat,
      and agent-produced observations.
- [ ] Implement smoothing, scene/change detection, and time decay in the stream
      producer. SynapsD receives replacement ID or anchor cues and stays
      clock-free.
- [ ] Decide whether batching frames improves measured throughput before adding
      another endpoint.

### Semantic anchors

Anchor research items (baseline, codebook training, anchor-vs-kNN evaluation,
Gemma per-layer experiments) moved to `../canvas-inferd/TODO.md`; the S2/Hilbert
storage-encoding caveat moved to `../canvas-synapsd/TODO.md`. Cross-repo parts
stay here:

- [ ] Design excitatory and inhibitory cue fusion. Exact veto already exists as
      bitmap exclusion; soft suppression needs normalized rank-space semantics.

### Inferd versus agentd

- [ ] Keep model execution, reusable derivation, projection, and stream decay in
      inferd.
- [ ] Keep goals, thread spawning, parent/child context, inhibition policy, and
      retrieval-session ownership in agentd.
- [ ] Define the smallest data contract between them: observations, anchors,
      summaries, provenance, and confidence. Do not expose runtime tensors
      unless an experiment proves they are needed.

## GitHub issues connector — residue

SHIPPED 2026-08 as a driver in the generic connectors service
(`canvas-server/src/core/workspace/services/connectors/`, docs in
`canvas-server/docs/connectors.md`) — not the imap-style standalone service
this section originally sketched. Landed: identity-only checksums
(sha256 of the `gh://owner/repo/issues/N` provenance URL), backends-tree
`/github/…` mirror, Workspace backend-facade wiring, web config panel
(ConnectorsSection incl. edit + deletion-sync tickbox), `schema-meta.ts`
entry + todo renderer, and bidirectional state mapping
(open/closed ↔ pending/completed/cancelled, write-back behind
`readOnly: false` + PAT). Still open:

- [ ] Register `data/schema/task/github/issue` in SynapsD as a task subtype
      (issues currently ingest as plain `data/schema/task`); hierarchical
      schema matching in hooks/rules (2026-08-17) already anticipates
      sub-schema ids. `vectorEmbeddingFields: title + body`.
- [ ] Store issue comments as an array in `data` (driver only carries
      `commentCount` today). No email-style `inReplyTo` graph — GitHub
      already flattens the thread and inferd chunking handles long bodies.

## Connector deletion-sync — remaining drivers

Source→Canvas deletion-sync shipped 2026-08-17 (server 2.5.36) for github:
opt-in `pruneRemoved: true` per backend; after a clean container sync the
service compares a FULL source traversal (`driver.listIdentities(container)`
→ every current provenance URL) against the mirror and hands source-deleted
docs to `WorkspaceStoredIndex.reconcileRemovedLocations` (orphan-not-delete:
locations dropped, mirror paths unticked, empty locations + `orphanedAt` (engine ticks `feature/orphaned`),
purged later by retention GC). The service side is fully generic — each
remaining driver only needs `listIdentities` (throw on ANY API error: a
partial listing must never masquerade as complete). Contract + guard rails:
`canvas-server/docs/connectors.md` "Deletion / destroy".

- [ ] caldav `listIdentities`: identity is `caldav://<address>/<calendar>/<uid>`
      with the UID inside the ICS — needs a no-time-range calendar-query
      REPORT retrieving UIDs (partial retrieval `<c:calendar-data>` with only
      the UID prop where supported; fall back to full calendar-data).
      Server-compat nuance (GroupOffice/Nextcloud/Radicale/SOGo) — test
      against a real server. Recurring events: one UID per series.
- [ ] gcal: consider `showDeleted=true` on the events list instead of a full
      traversal — the sync-token delta already carries `status: 'cancelled'`
      tombstones, which could prune inline during `fetchChanges` (cheaper and
      race-free); `listIdentities` then only backfills pre-existing deletes.
- [ ] slack: full-history traversal is rate-limit-expensive
      (`conversations.history` full walk per channel); check whether message
      tombstones (`subtype: message_deleted` in deltas) are visible to bot
      tokens before committing to the listing approach.
- [ ] teams: Graph delta queries carry `@removed` tombstones — same inline
      option as gcal; full listing via `/messages` pagination otherwise.

## Integration leftovers

- [ ] Extend session-driven lists to layer and unfiled views where useful.
- [ ] Add reconnect/resume only together with a bounded grace TTL.
- [ ] Decide live-session sorting and pagination UX. Stable insertion order is
      currently deliberate.
