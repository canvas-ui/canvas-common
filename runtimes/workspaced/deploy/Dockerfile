# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/canvas
ARG CANVAS_RUNTIME_PACKAGE=git+https://github.com/canvas-ui/canvas-common.git#main
RUN mkdir -p -m 700 /root/.ssh && ssh-keyscan github.com >> /root/.ssh/known_hosts
RUN git config --global url."ssh://git@github.com/".insteadOf https://github.com/
RUN printf '%s' '{"private":true,"overrides":{"fast-jwt":"6.2.4"}}' > package.json
RUN --mount=type=ssh,required=true npm install --omit=dev --no-audit --no-fund "${CANVAS_RUNTIME_PACKAGE}"
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV NODE_ENV=production
EXPOSE 8012
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/canvas/node_modules/.bin/canvas-workspace"]
CMD ["/workspace", "--foreground", "--host", "0.0.0.0", "--port", "8012"]
