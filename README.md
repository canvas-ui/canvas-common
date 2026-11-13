<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# Canvas common

Shared packages of Canvas UI(OS) — published to npm under `@augmentd-labs` —
plus the `canvas-edge` device runtime. Every client lives in its own
repository with its own release pipeline:

| repo | what |
|---|---|
| [canvas-server](https://github.com/canvas-ui/canvas-server) | the server |
| [canvas-web](https://github.com/canvas-ui/canvas-web) | web UI (`@augmentd-labs/canvas-web`) |
| [canvas-cli](https://github.com/canvas-ui/canvas-cli) | `canvas` CLI + lazily installed CLI packages + canvas-shell |
| [canvas-desktop](https://github.com/canvas-ui/canvas-desktop) | desktop app (Tauri) |
| [canvas-browser-extension](https://github.com/canvas-ui/canvas-browser-extension) | Chromium + Firefox extension |

## Project screenshots

- https://demo.cnvs.ai/pub/c/aks6zaf8


## Demo instance

- https://demo.cnvs.ai/
- demo@canvas.local

## Layout

```
packages/
  protocol               wire contract: envelope, error codes, routes, events, sync constants
  schemas                document schema ids, versions, builders
  api-client             ergonomic REST client over protocol
  wallpapers             bundled wallpapers + picker metadata
runtimes/
  edge                   device runtime: folder mirrors (canvas-stored) + edge tunnel client
```

- [`runtimes/edge`](runtimes/edge/README.md) — `canvas-edge` daemon (`canvas remote mirror edge install`)

## Shared packages on npm

The libraries are published to npm under `@augmentd-labs` by `release.yml`
(`scripts/publish-npm.mjs`) whenever a package's version is new — release =
bump the version, push main. Workspace deps become `^version` deps; edge
bundles its git dep (canvas-stored). npm trusted publishing (GitHub OIDC), so
no token lives anywhere, and every version carries provenance.

| package | source |
|---|---|
| `@augmentd-labs/canvas-protocol` | `packages/protocol` |
| `@augmentd-labs/canvas-schemas` | `packages/schemas` |
| `@augmentd-labs/canvas-api-client` | `packages/api-client` |
| `@augmentd-labs/canvas-wallpapers` | `packages/wallpapers` |
| `@augmentd-labs/canvas-edge` | `runtimes/edge` |

The web UI lives in [canvas-web](https://github.com/canvas-ui/canvas-web) and
is published as `@augmentd-labs/canvas-web`.

### The old `*-dist` branches

Before the npm switch (2026-10) consumers installed `github:canvas-ui/canvas#<name>-dist`
branches. All of them were deleted on 2026-10-02; a git bundle of every
deleted branch and monorepo-era tag is kept outside the repo. `ci.yml` stages every npm package on each PR and
smoke-tests the edge tarball; `housekeeping.yml` keeps the last 5 runs per
workflow.

## Development

```bash
pnpm install
pnpm test          # package test suites (node --test)
pnpm run lint      # root eslint over packages/ + per-app lint
pnpm run build     # per-package dev builds
```

pnpm is deliberate: its strict `node_modules` makes an undeclared dependency an
install-time error, which is the property that keeps `packages/*` independently
installable. Do not add dependencies that only work because something else
hoisted them.

## Desktop integration

OS integrations (Dolphin "Send to Canvas", saving selected text as a note)
live in [canvas-os](https://github.com/canvas-ui/canvas-os) and go through
the canvas CLI.

## Licensing

Everything in this repository is available under the
**AGPL-3.0-or-later** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Across
the project, two kinds of code differ beyond that:

- **The client applications are AGPL-only, for everyone, permanently** — now
  in their own repositories (canvas-web, canvas-cli, canvas-desktop,
  canvas-browser-extension; formerly `apps/*` here). No commercial licence is
  offered for them, to anyone, and none is planned: the Canvas clients stay
  free software in all cases. Contributions need only a DCO sign-off
  (`git commit -s`).
- **`packages/*` are part of the dual-licensed Canvas engine** (AGPL-3.0-or-later
  or a commercial licence), alongside `canvas-server`, `canvas-synapsd`,
  `canvas-stored`, `canvas-inferd` and `canvas-agentd`. Contributions are
  asked for under the one-time Canvas [CLA](https://github.com/canvas-ui/canvas-server/blob/main/CLA.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) here and the server's
[COMMERCIAL.md](https://github.com/canvas-ui/canvas-server/blob/main/COMMERCIAL.md)
for the commercial side.

## Package naming & distribution

Packages use the `@augmentd-labs/canvas-*` npm scope (Augmentd Labs funds
Canvas and other projects; one org, `canvas-` names per project) and are
published to public npmjs by `release.yml` with trusted publishing and
provenance — see *Shared packages on npm* above. GitHub Packages is
deliberately not used: it requires an auth token even for public installs.
