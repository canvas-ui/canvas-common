# Standalone agent runtime

`@augmentd-labs/canvas-agent-runtime` runs one Pi agent in a selected folder. It includes a token-authenticated local API/UI, file-backed sessions, filesystem tools, Ollama and voice integration, and an outbound canvas-server tunnel. It neither installs nor initializes canvas-workspaced, canvas-runtime-core, canvas-stored, or canvas-synapsd.

## Initialize

```sh
canvas init agent ./gpu-agent
canvas init agent ./gpu-agent --yes --local-only --foreground
```

An omitted path uses the current directory. Interactive setup prompts for missing settings and defaults to PM2 background operation. `--no-start` initializes only. The CLI manages Node 22.20 on Linux x64/arm64. Direct installation requires Node >=22.19:

```sh
git clone git@github.com:canvas-ui/canvas-agentd.git
cd canvas-agentd
npm install
node src/local.js ./gpu-agent --foreground
```

Direct background launch requires PM2 on PATH. The CLI installs PM2 itself. Native execution has the launching user's OS permissions; use the Docker template for a separate filesystem/process environment.

```sh
canvas init agent ./gpu-agent --yes \
  --model qwen3:latest --ollama-url http://127.0.0.1:11434/v1 \
  --stt-url http://127.0.0.1:8000 --stt-model Systran/faster-whisper-small \
  --tts-url http://127.0.0.1:8880 --voice af_heart \
  --server-url https://canvas.example --token-file ./pairing-token
```

`--remote NAME` uses an authenticated CLI remote; `--local-only` skips remote registration. `CANVAS_PAIRING_TOKEN` is an alternative to a token file. Pairing exchanges the owner's token for a revocable device token. Model services must already have their selected models installed; initialization works with those services offline.

## Local access and lifecycle

All runtime metadata, credentials, configuration and sessions live in `.agent/`. Existing folder contents are preserved. No `.workspace/` or synapsd database is created. The agent advertises only an agent resource to canvas-server. Workspace indexing, context trees and FUSE workspace mounts require a separately deployed workspace runtime.

```sh
canvas runtime status ./gpu-agent
canvas runtime token ./gpu-agent
canvas runtime logs ./gpu-agent
canvas runtime stop ./gpu-agent
canvas runtime start ./gpu-agent
canvas runtime restart ./gpu-agent
canvas runtime detach ./gpu-agent
```

The API binds to loopback and reuses its port on restart; `--port 8012` selects a fixed port. Open the status URL and log in with the local token, or send `Authorization: Bearer <local-token>` to `/rest/v2`. Agent lifecycle, prompts/SSE, sessions, skills and `/agents/:id/voice` are available locally and through the hub. The capabilities endpoint reports `workspace: false`. The standalone agent has no Canvas workspace binding; local filesystem tools remain available.

Disconnecting the hub does not stop local access. Offline registrations remain visible and return 503; reconnection restores the same agent ID. Detaching revokes the device registration and preserves local data. If a folder hosts both kinds of runtime, use `canvas runtime ... --kind agent` or `--kind workspace` (the default prefers `.agent`). Agent and workspace installations have separate dependency trees.

## Existing workspace-backed agents

Stop and detach the old runtime before migration:

```sh
canvas runtime stop ./gpu-agent
canvas runtime detach ./gpu-agent
canvas init agent ./gpu-agent --yes --local-only
```

The new host adopts the existing agent identity, owner token, configuration and sessions, removes its old local workspace binding, and stores supervisor state under `.agent/`. Existing `.workspace/` data is retained. Pair again with `--server-url`/`--token-file` to register the agent-only export. Migration is rejected while the old process is running or still configured with an active remote. The older canvas-agentd legacy engine has a different layout and is not automatically migrated.

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

The paired device token persists in the mounted folder. Read the local login token from `.agent/runtime.json` on the host. The Dockerfile builds from the private AgentD checkout and installs its public dependencies. See the upstream [Speaches installation](https://speaches.ai/installation/), [model provisioning](https://speaches.ai/usage/model-discovery/) and [Kokoro configuration](https://github.com/remsky/Kokoro-FastAPI/blob/master/docs/configuration.md) for service-specific requirements.

## Private local deployments

Agent and workspace runtimes are not published to npm. Production agent logic
comes from canvas-server; `scripts/regenerate-agent-tools.mjs` refreshes the
derived runtime sources. The exporter includes the shared API client and protocol
sources so local deployments do not require unpublished Canvas libraries.

From canvas-common:

```sh
npm run agent:export
node scripts/export-private-runtime.mjs --check
cd ../canvas-agentd
npm pack
```

Install from the private Git repository, a GitHub ZIP, or a local tarball:

```sh
canvas init agent ./gpu-agent --runtime-package git@github.com:canvas-ui/canvas-agentd.git
canvas init agent ./gpu-agent --runtime-package ./canvas-agentd-main.zip
canvas init agent ./gpu-agent --runtime-package ./canvas-agentd-0.3.2.tgz
```

The CLI clones Git sources without submodules, packs them, and caches the result.
Only public dependencies are resolved through npm. `CANVAS_RUNTIME_NO_DEV=1`
bypasses sibling-checkout detection; `CANVAS_AGENT_PACKAGE` selects a Git or local
archive source. No model weights are included.

The npm allowlist is limited to protocol, schemas, wallpapers, api-client and edge.
Private runtime packages and dependencies are rejected by public packaging checks.
