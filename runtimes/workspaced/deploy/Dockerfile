FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/canvas
# Select the published runtime release to install.
ARG CANVAS_RUNTIME_PACKAGE=@augmentd-labs/canvas-workspaced@0.1.1
RUN printf '%s' '{"private":true,"overrides":{"fast-jwt":"6.2.4"}}' > package.json
RUN npm install --omit=dev --no-audit --no-fund "${CANVAS_RUNTIME_PACKAGE}"
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV NODE_ENV=production
EXPOSE 8012
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/canvas/node_modules/.bin/canvas-agent"]
CMD ["/workspace", "--foreground", "--host", "0.0.0.0", "--port", "8012"]
