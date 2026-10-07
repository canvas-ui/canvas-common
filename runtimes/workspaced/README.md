# Local workspace and agent runtimes

`canvas-workspaced` runs the same workspace, context, storage and Pi agent implementation as canvas-server. One runtime owns one folder, one workspace and optionally one agent. It serves the resource REST API and web UI locally, and opens an outbound connection to a chosen canvas-server. No inbound port forwarding is needed for remote access.

## Initialize on Linux

Use the Canvas CLI for interactive setup, managed Node installation and background supervision:

```sh
canvas init agent ./gpu-agent
canvas init workspace ./my-workspace
```

An omitted path means the current directory. Unspecified settings are prompted in a terminal; `--yes` selects defaults. Background operation uses PM2. `--foreground` stays attached, and `--no-start` initializes without starting. Existing files are preserved. Existing Canvas workspaces must use the `home` layout.

For unattended setup with existing model services:

```sh
canvas init agent ./gpu-agent --yes \
  --model qwen3:latest --ollama-url http://127.0.0.1:11434/v1 \
  --stt-url http://127.0.0.1:8000 --stt-model Systran/faster-whisper-small \
  --tts-url http://127.0.0.1:8880 --voice af_heart \
  --server-url https://canvas.example --token-file ./pairing-token
```

`--remote NAME` uses an authenticated CLI remote. `--local-only` skips the CLI's current remote. Pairing exchanges an owner API token for a revocable device token; the owner token is not written into runtime configuration. `CANVAS_PAIRING_TOKEN` is an alternative to a token file. Model services must already have the selected models installed. Initialization itself works while those services are offline.

The managed installation supports Linux x64 and arm64 and installs Node 22.20 plus native npm dependencies. The host requires Node 22.19 or newer. It is a managed distribution, not a statically linked executable. Native execution gives the agent the launching user's OS permissions; use the Docker deployment for a separate filesystem/process environment.

## Local access and lifecycle

```sh
canvas runtime status ./gpu-agent
canvas runtime token ./gpu-agent
canvas runtime restart ./gpu-agent
canvas runtime logs ./gpu-agent
canvas runtime stop ./gpu-agent
canvas runtime start ./gpu-agent
canvas runtime detach ./gpu-agent
```

The API binds to loopback on an available port and reuses that port on restart. `--port 8012` chooses a fixed port. Open the URL from `runtime status` and sign in with the local token. The web UI exposes the hosted workspace and agent; global server administration and additional resource creation are unavailable. Headless clients use `Authorization: Bearer <local-token>` on `/rest/v2`.

FUSE uses this same API. Set `CANVAS_SERVER` to the local URL and `CANVAS_API_TOKEN` to the local token, then run:

```sh
canvas-fuse ping --json
canvas-fuse mount -w gpu-agent ~/MountedAgent
```

The runtime keeps private configuration, local/tunnel credentials, indexes and registration in `.workspace/`. Agent configuration, sessions and managed Pi files live in `.agent/`; the working directory remains the selected folder. Both metadata directories are excluded from workspace Home access and synchronization. Include them in backups. Moving an initialized folder requires updating stored runtime paths. Local agent and workspace root deletion is deliberately unavailable through the API; stopping the process preserves the folder and all data.

Detach removes the server registration and revokes its device credentials, without deleting local data. Server outages leave the local API usable; reconnect restores the same exported IDs. A detached device must pair again. Offline registrations remain visible on the server and return 503 until connected.

Direct entrypoints are also available for service managers:

```sh
canvas-agent ./gpu-agent --foreground
canvas-workspace ./my-workspace --foreground
```

Direct background launch requires PM2 on PATH; the CLI installs its own PM2 under the Canvas user directory. CLI-managed processes use a separate PM2 home. To start them at OS boot, configure a user service running PM2 `resurrect` with that same `PM2_HOME`; initialization does not modify system services.

## Docker with NVIDIA model services

The `deploy/compose.yaml` template runs the agent as an unprivileged user with only the chosen folder mounted. Its local API is published on host loopback. GPU services are optional and share a private Compose network; Python and CUDA dependencies stay in their own images.

Copy `deploy/` to a deployment folder, create the workspace folder owned by the configured UID/GID (defaults 1000), and set `CANVAS_WORK_DIR` if needed. Docker Compose and a working NVIDIA Container Toolkit are prerequisites for the `models` profile.

```sh
mkdir -p workspace
docker compose --profile models up -d --build
docker compose run --rm --entrypoint node agent \
  /opt/canvas/node_modules/@augmentd-labs/canvas-workspaced/deploy/provision-models.mjs
```

Model provisioning is explicit because it downloads model weights. `OLLAMA_MODEL`, `STT_MODEL`, and the image variables select models/builds. Pin `OLLAMA_IMAGE`, `KOKORO_IMAGE`, and `STT_IMAGE` to tested versions or digests for repeatable deployments. Ollama and speech-recognition caches use named volumes. Kokoro performs TTS; speech recognition is supplied by Speaches/Whisper. Voice requests are turn-based: audio upload → transcript → Pi/Ollama reply → Kokoro audio.

To use existing services, omit `--profile models` and set `OLLAMA_URL`, `STT_URL`, and `TTS_URL`. Host services can be reached at `host.docker.internal` if they listen on an interface reachable from Docker.

Pair the stopped agent container once; pass the API token using the environment without putting its value in shell arguments:

```sh
docker compose stop agent
docker compose run --rm -e CANVAS_PAIRING_TOKEN agent \
  /workspace --init-only --server-url https://canvas.example
docker compose up -d agent
```

The paired device token persists in the mounted folder. Read the local login token from `.workspace/runtime.json` on the host. The Dockerfile accepts `CANVAS_RUNTIME_PACKAGE` as a build argument for choosing a published package version. See the upstream [Speaches installation](https://speaches.ai/installation/), [model provisioning](https://speaches.ai/usage/model-discovery/) and [Kokoro configuration](https://github.com/remsky/Kokoro-FastAPI/blob/master/docs/configuration.md) for service-specific requirements.

## Development and release

Shared implementation lives in `packages/runtime-core`; server source paths re-export it for compatibility. The CLI detects a sibling `canvas-common` checkout. Run `pnpm install` in canvas-common before using that source mode. `CANVAS_RUNTIME_NO_DEV=1` forces the managed installation and `CANVAS_RUNTIME_PACKAGE` selects a registry version or tarball.

```sh
node scripts/pack-dist.mjs runtime-core,workspaced --pack
```

Without `--registry`, this bundles workspace packages plus the JS portions of canvas-stored and canvas-synapsd. npm installs their platform/native dependencies. Registry publishing uses the existing `publish:npm` workflow: release protocol/edge and runtime-core before workspaced, then update server/agentd dependencies and their lockfiles. Set `CANVAS_WEB_ROOT` to a local web build directory to test UI changes. The web package must be at least 2.15.0 for token login (2.15.1 also hides creation controls on the main resource pages). No model weights are included in the npm package.

The server's original HTTP agent workers and legacy canvas-edge mirror daemon remain supported. `canvas-agentd` now launches this shared Pi host by default; `npm run legacy` retains its previous engine. Legacy sessions and configuration are not automatically converted.

The initial scope is one hub per runtime, streamed HTTP requests/responses and resource events. Multi-hub registration, realtime full-duplex voice and replicated workspace data are separate features.
