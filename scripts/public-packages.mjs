// This is the only npm release allowlist. Agent and workspace runtimes are private Git/local distributions.
export const PUBLIC_PACKAGES = ['protocol', 'schemas', 'wallpapers', 'api-client', 'edge'];
export const PRIVATE_PACKAGES = new Set(['canvas-synapsd', 'canvas-common', 'canvas-agentd', '@augmentd-labs/canvas-agent-runtime',
    '@augmentd-labs/canvas-runtime-core', '@augmentd-labs/canvas-workspaced']);
