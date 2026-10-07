import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRuntime } from '@augmentd-labs/canvas-agent-runtime/runtime/daemon.js';

export async function main({ kind = 'workspace', argv = process.argv.slice(2), createHost } = {}) {
    // Compatibility for callers of the old workspaced agent entrypoint.
    if (kind === 'agent') return (await import('@augmentd-labs/canvas-agent-runtime')).main({ argv });
    return runRuntime({ kind: 'workspace', argv, version: '0.1.2',
        script: fileURLToPath(new URL('../bin/canvas-workspace.js', import.meta.url)),
        async createHost(options) {
            const state = path.join(options.root, '.workspace');
            process.env.CANVAS_SERVER_HOME = path.join(state, 'host');
            process.env.CANVAS_USER_HOME = path.join(state, 'host', 'users');
            process.env.CANVAS_SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
            const factory = createHost || (await import('@augmentd-labs/canvas-runtime-core/host')).createLocalHost;
            return factory(options);
        },
        async exportsFor(host) {
            const workspace = await host.workspaceManager.getWorkspace(host.workspaceId, host.user.id);
            return [{ type: 'workspace', id: host.workspaceId, name: host.config.name, acl: workspace.acl }];
        } });
}
