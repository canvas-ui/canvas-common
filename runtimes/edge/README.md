# @augmentd-labs/canvas-edge

The device-side Canvas runtime. One Node process, two jobs:

- **mirror** — keep real folders in sync with hub workspaces (canvas-stored's
  `Mirror` engine, state under `<folder>/.workspace/` or an external state dir). Configured by the CLI's
  `~/.canvas/config/mirrors.json` (`canvas remote mirror init`), driven over a local
  control socket (`~/.canvas/run/edge.sock`, a localhost port on Windows).
- **tunnel** — `EdgeClient` dials out to a canvas-server, announces what this
  runtime hosts and replays proxied requests into a local fastify app, so a
  remote workspace or agent behaves as if it were server-local. The hub side
  (`EdgeRegistry`) lives in canvas-server.

No canvas-server imports: the same package backs `ws`, canvas-agentd and the
desktop sidecar. This is the seed of the generic standalone runtime
(`mirror | workspace | agent` units behind one lifecycle).

```
canvas-edge --foreground        # run attached (pm2 / systemd); logs to stdout
canvas-edge                     # detached, logs to ~/.canvas/var/log/canvas-edge.log
```

## Install

Published to npm as `@augmentd-labs/canvas-edge` (canvas-common's
release.yml, on a version bump). The CLI fetches it into its own prefix:

```
canvas remote mirror edge install      # → ~/.canvas/edge/node_modules/@augmentd-labs/canvas-edge
canvas remote mirror edge update       # latest from npm + restart the daemon
```

(`npm install --ignore-scripts @augmentd-labs/canvas-edge` in any project does
the same; avoid `npm -g` — global installs of packages with bundled deps came
out incomplete on npm 11.) `canvas remote mirror init` offers the
install when the binary is missing. The
artifact bundles its workspace/git dependencies (canvas-protocol,
canvas-stored) and keeps only registry dependencies external — see
`scripts/pack-dist.mjs`.

## fuse units (on-demand mounts, e.g. a GPU workstation)

A mirrors.json entry with `client: 'fuse', managed: 'edge'` is a **fuse unit**:
the daemon spawns `canvas-fuse mount -w <ws> <root> --remote <id> --mirror …`
attached, restarts it with backoff when it dies, reads `canvas-fuse status
--json` for its state and unmounts it on stop — one process per workspace
under one root (`<root>/<folder>`), as many units as workspaces. canvas-fuse
stays a plain executable (`CANVAS_FUSE_BIN`, `~/.cargo/bin`, PATH); its
on-demand namespace, content cache, pins and LRU are its own. `canvas remote
mirror add <ws> --edge` (or `… supervisor <ws> edge`) configures one.

## Container (NAS, servers)

`runtimes/edge/Dockerfile` installs the npm package into an
unprivileged image; one container mirrors one workspace, configured by
environment (no CLI needed on the host):

```
docker build -t canvas-edge -f runtimes/edge/Dockerfile .
docker run -d --name canvas-edge-augmentd --restart unless-stopped \
  -e CANVAS_HUB_URL=https://canvas.example.org -e CANVAS_HUB_TOKEN=canvas-… \
  -e CANVAS_WORKSPACE=augmentd -e CANVAS_DIRECTION=pull -e CANVAS_DEVICE_ID=nas-synology \
  -v /volume1/work/Augmentd:/data -v canvas-edge-config:/config -v canvas-edge-state:/state \
  canvas-edge
```

`docker/docker-compose.example.yml` is the same as a compose project (what
Synology Container Manager takes). `canvas remote mirror docker <workspace>`
prints one filled in from a remote you are logged in to. State (ledger,
queue, cache, trash, conflicts) lives under `/state/<mirror id>`
(`CANVAS_EDGE_STATE_ROOT`), so the mirrored share holds user files only; a
non-container mirror gets the same with `--state-dir` (`stateDir` in
mirrors.json). `CANVAS_DIRECTION=pull` makes the container a backup target
(hub is the only writer), `bi` while seeding from existing files.

Protocol: canvas-server `docs/canvas-edge-protocol.md` (tunnel) and
`docs/sync-protocol.md` (file plane).

New mirrors default to `rename` conflict handling: the hub version keeps its
name and the device version gets a conflict-copy name. Set `CANVAS_CONFLICTS=prompt`
for the hub conflict inbox instead. Existing `mirrors.json` conflict policies
are preserved unless explicitly overridden.

### Client certificates (0.5.0+)

Hub remotes retain `tls: { certFile, keyFile }` from the shared client config.
Workspace remotes can carry the same optional fields. Pairing, tunnel sockets,
mirror status calls, and object transfers all use the identity. Container bootstrap
accepts `CANVAS_TLS_CERT`/`CANVAS_TLS_KEY` as a complete pair of file paths; mount
these files read-only. Use leaf-first PEM chains and protected unencrypted RSA/EC
keys. Server verification is enabled. Restart the daemon/container after renewal.
