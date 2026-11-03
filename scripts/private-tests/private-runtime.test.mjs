import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const exporter = fileURLToPath(new URL('../export-private-runtime.mjs', import.meta.url));

test('private deployments include runtime and client sources with no runtime registry dependency', t => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-private-export-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const run = (...args) => execFileSync(process.execPath, [exporter, '--out', out, ...args], { stdio: 'pipe' });
    run();
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json')));
    assert.equal(pkg.private, true);
    for (const name of ['@augmentd-labs/canvas-agent-runtime', '@augmentd-labs/canvas-workspaced', '@augmentd-labs/canvas-api-client', '@augmentd-labs/canvas-protocol']) {
        assert.equal(pkg.dependencies[name], undefined);
    }
    for (const file of [pkg.main, pkg.bin['canvas-agent'], 'runtime/src/core/agent/worker.js', 'runtime/packages/api-client/src/EdgeClient.js']) {
        assert.ok(fs.existsSync(path.join(out, file)), file);
    }
    run('--check');
    fs.writeFileSync(path.join(out, 'runtime/src/main.js'), 'stale');
    assert.throws(() => run('--check'), /Regenerate AgentD/);
    run();
    run('--check');
});

test('workspace launcher is local and keeps its client HTTP dependency isolated', t => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-private-launcher-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    execFileSync(process.execPath, [exporter, '--workspace', '--out', out]);
    const deps = JSON.parse(fs.readFileSync(path.join(out, 'launcher/dependencies.json')));
    assert.equal(deps['@augmentd-labs/canvas-agent-runtime'], undefined);
    assert.match(deps['@canvas-local/undici'], /^npm:undici@/);
    const daemon = fs.readFileSync(path.join(out, 'launcher/src/runtime/daemon.js'), 'utf8');
    assert.match(daemon, /\.\.\/\.\.\/packages\/api-client\/src\/EdgeClient.js/);
});
