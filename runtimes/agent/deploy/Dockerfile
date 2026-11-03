FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/canvas
COPY package.json ./
COPY runtime ./runtime
COPY src/local.js src/runtime.js ./src/
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV NODE_ENV=production
EXPOSE 8012
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/canvas/src/local.js"]
CMD ["/workspace", "--foreground", "--host", "0.0.0.0", "--port", "8012"]
