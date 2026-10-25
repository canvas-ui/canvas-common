#!/usr/bin/env node
import { main } from '../src/main.js';
main({ createHost: async options => {
    // Workspaced is installed from the complete private Git checkout, not npm.
    const { createWorkspaceHost } = await import('../../../packages/runtime-core/src/runtimes/workspace/runtime/host.js');
    return createWorkspaceHost(options);
} }).catch(error => { console.error(error.message); process.exitCode = 1; });
