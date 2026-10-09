# Private workspace runtime

`canvas-workspaced` hosts one local workspace, its database, context APIs and web UI, and registers it with canvas-server over an outbound tunnel. It uses the private canvas-synapsd engine. **Neither workspaced nor canvas-runtime-core is published to npm.**

For an independent agent with Ollama and voice, use [canvas-agent-runtime](../agent/README.md). `canvas init agent` installs that public package and creates only `.agent/` state.

## Install from Git

Node >=22.19, Git, and read access to canvas-synapsd are required. After the public agent-runtime and API-client releases are available:

```sh
npm pkg set 'overrides.fast-jwt=6.2.4'
npm install 'git+https://github.com/canvas-ui/canvas-common.git#main'
./node_modules/.bin/canvas-workspace ./workspace --foreground
```

The private canvas-common root is the Git distribution: it exposes the runtime-core module paths, includes the workspace executable, and declares synapsd as a Git dependency. It is marked `private: true`. Use a commit SHA instead of `main` for repeatable deployments. Authenticate Git with a credential helper or SSH agent; never put credentials into package URLs or committed configuration.

The Canvas CLI selects the Git distribution for workspace initialization:

```sh
canvas init workspace ./workspace --yes --local-only
canvas init workspace ./workspace --yes \
  --server-url https://canvas.example --token-file ./pairing-token
```

`--runtime-package <spec>` (also on `canvas runtime start|restart`) or `CANVAS_WORKSPACE_PACKAGE` selects another Git ref, fork or local test artifact, for example `--runtime-package github:canvas-ui/canvas-common#<sha>`; the spec sticks for later `canvas runtime start` calls. `CANVAS_RUNTIME_NO_DEV=1` bypasses sibling-checkout detection. Without that variable, the CLI uses an installed sibling canvas-common checkout. Agent and workspace dependencies are installed separately.

## Development and tests from a Git checkout

```sh
git clone https://github.com/canvas-ui/canvas-common.git
cd canvas-common
pnpm install --frozen-lockfile
node scripts/smoke-workspace.mjs
node runtimes/workspaced/bin/canvas-workspace.js /path/to/folder --foreground
```

Canvas-server keeps its implementations in its own repository and does not depend on runtime-core, workspaced or the standalone agent package. Its normal `npm install` and `npm run dev` workflow does not require a canvas-common checkout or a runtime release. The Git distribution described here is for private workspace deployments. Refresh those consumers' lockfiles after pushing the intended Git revision and publishing its public dependencies; npm cannot lock an unpublished working tree at a remote ref.

The manually invoked `private-runtime.yml` workflow checks out Git sources and tests the workspace API/database. `CANVAS_PRIVATE_REPO_TOKEN` must have read access to both repositories. Public CI and npm release jobs install only public packages and have no need for private repository access. The npm packer rejects runtime-core/workspaced targets and private dependencies, including synapsd through transitive dependencies.

## Local access

Supervisor metadata, credentials and indexes live under `.workspace/`. Existing files are preserved. Existing workspaces must use the `home` layout. The API binds to loopback on a persisted port; `--port` chooses a fixed port. Open the status URL and log in using `canvas runtime token`, or use `Authorization: Bearer <local-token>` with `/rest/v2`.

```sh
canvas runtime status ./workspace --kind workspace
canvas runtime token ./workspace --kind workspace
canvas runtime stop ./workspace --kind workspace
canvas runtime start ./workspace --kind workspace
canvas runtime detach ./workspace --kind workspace
```

The CLI defaults to PM2 background supervision; direct invocation requires PM2 on PATH unless `--foreground` is used. `--no-start` initializes without starting. FUSE can connect directly using the local API URL/token. Detaching removes the hub registration and revokes its device credentials while preserving local data. Hub outages do not interrupt local access.

The Docker template builds from Git using an SSH agent forwarded by BuildKit; it does not copy credentials into the image. Agent/GPU deployment templates live in [the agent package](../agent/deploy/).
