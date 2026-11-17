# @augmentd-labs/canvas-edge

The device-side Canvas runtime. One Node process, three jobs:

- **mirror** — keep real folders in sync with hub workspaces (canvas-stored's
  `Mirror` engine, state under `<folder>/.workspace/` or an external state dir). Configured by the CLI's
  `~/.canvas/config/mirrors.json` (`canvas remote mirror init`), driven over a local
  control socket (`~/.canvas/run/edge.sock`, a localhost port on Windows).
- **share** — serve local folders (a NAS volume, an external drive) to a hub
  workspace as read-only storage backends. The folder is hashed and watched
  here and read in place; nothing is copied. Configured by
  `~/.canvas/config/shares.json` (`canvas workspace <ws> share add`). See
  [Shares](#shares-nas-volumes-external-drives).
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

## Shares (NAS volumes, external drives)

A shares.json entry is a **share unit**: one folder served to one workspace.

```
canvas workspace universe share add /mnt/mywd --name wd1t.home --label "1TB WD"
canvas workspace universe share list
canvas workspace universe share scan wd1t.home
canvas workspace universe share remove wd1t.home     # --local: only stop serving it here
```

The name is `<share>.<site>`. It is the backend's address in the workspace,
the authority of the files' `file://wd1t.home/Music/x.mp3` URLs and the node
`/device/home/wd1t` in the backends tree. It names the share, not the machine:
a drive moved to another computer is added there under the same name and
keeps its catalog.

The daemon walks and hashes the folder into its own index (resumable: an
unchanged file keeps its checksum), follows changes with a watcher unless
`--no-watch`, rescans every six hours and answers the workspace's requests.
It only dials out (`POST …/backends/share/<name>/poll`, see canvas-server
`docs/storage-shares.md`), so the machine needs no open port.

Nothing is written into the folder. The index lives in
`~/.canvas/var/shares/<id>`, in `<CANVAS_EDGE_STATE_ROOT>/<id>`, or in the
entry's `stateDir` (`--state-dir`). It records the filesystem it was built
from. When the folder is missing, on another filesystem, or empty while the
index lists files, the unit stops checking in: the workspace shows the share
offline and keeps its catalog, so an unplugged drive is never read as "every
file was deleted". When the folder is back the unit rescans and reconnects.
Emptying a share for real therefore does not empty its catalog; removing the
share does.

On top of the default exclusions (dotfiles, `node_modules`, caches) a share
skips recycle bins, NAS bookkeeping (`@eaDir`, `#recycle`, `#snapshot`),
half-written downloads, `tmp`/`temp` folders, logs and lock files
(`SHARE_EXCLUSIONS` in `src/share-runtime.js`). `--exclude a,b` adds globs.

In a container, set `CANVAS_SHARE_NAME` next to the hub variables and mount
the folder read-only. Such a container serves the share and mirrors nothing:

```
docker run -d --name canvas-edge-accounting --restart unless-stopped \
  -e CANVAS_HUB_URL=https://canvas.example.org -e CANVAS_HUB_TOKEN=canvas-… \
  -e CANVAS_WORKSPACE=augmentd -e CANVAS_DEVICE_ID=nas-synology -e CANVAS_DEVICE_NAME="NAS@Home" \
  -e CANVAS_SHARE_NAME=nas-accounting.home -e CANVAS_SHARE_LABEL="NAS Accounting" \
  -v /volume1/augmentd/accounting:/data:ro -v canvas-edge-config:/config -v canvas-edge-state:/state \
  canvas-edge
```

`CANVAS_SHARE_PATH` (default `/data`), `CANVAS_SHARE_WATCH=false` and
`CANVAS_SHARE_EXCLUDE` are optional. One container serves one share; run one
per exported folder.

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
