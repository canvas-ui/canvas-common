// This is the only npm release allowlist. Private workspace runtimes are Git-only.
export const PUBLIC_PACKAGES = ['protocol', 'schemas', 'wallpapers', 'api-client', 'edge', 'agent'];
export const PRIVATE_PACKAGES = new Set(['canvas-synapsd', 'canvas-common',
    '@augmentd-labs/canvas-runtime-core', '@augmentd-labs/canvas-workspaced']);
