#!/usr/bin/env node
import { main } from '../src/main.js';
main({ kind: 'workspace', createHost: async options => {
    // Workspaced is installed from the complete private Git checkout, not npm.
    const { createLocalHost } = await import('../../../packages/runtime-core/src/runtime/host.js');
    return createLocalHost(options);
} }).catch(error => { console.error(error.message); process.exitCode = 1; });
