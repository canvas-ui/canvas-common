import { fileURLToPath } from 'node:url';
import { createAgentHost } from './runtime/host.js';
import { runRuntime } from './runtime/daemon.js';

export function main({ argv = process.argv.slice(2) } = {}) {
    return runRuntime({ kind: 'agent', argv, createHost: createAgentHost, version: '0.1.0',
        script: fileURLToPath(new URL('../bin/canvas-agent.js', import.meta.url)),
        exportsFor: host => [{ type: 'agent', id: host.config.agentId, name: host.config.name }] });
}
