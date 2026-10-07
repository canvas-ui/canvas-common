import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPublicDependencies, assertPublicArtifact } from '../check-public-package.mjs';
import { stage, TARGETS } from '../pack-dist.mjs';
import { PUBLIC_PACKAGES } from '../public-packages.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pack-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function manifest(dir, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(data));
}
test('release targets exclude the private workspace runtime even when explicitly requested', async () => {
    assert.deepEqual(Object.keys(TARGETS).sort(), [...PUBLIC_PACKAGES].sort());
    for (const name of ['runtime-core', 'workspaced']) await assert.rejects(stage(name), /unknown target/);
});
test('public packaging rejects private dependencies directly and through another package', t => {
    const root = fixture(t);
    manifest(root, { name: 'public-wrapper', dependencies: { bridge: '1.0.0' } });
    const bridge = path.join(root, 'node_modules/bridge');
    manifest(bridge, { name: 'bridge', dependencies: { 'canvas-synapsd': 'github:canvas-ui/canvas-synapsd#main' } });
    assert.throws(() => assertPublicDependencies(root), /public-wrapper -> bridge -> canvas-synapsd/);
    manifest(bridge, { name: 'bridge', private: true });
    assert.throws(() => assertPublicDependencies(root), /Private package/);
    manifest(bridge, { name: 'bridge' });
    assert.doesNotThrow(() => assertPublicDependencies(root));
});
test('artifact scan rejects undeclared vendored synapsd and private runtime manifests', t => {
    const root = fixture(t);
    manifest(root, { name: 'public-wrapper' });
    manifest(path.join(root, 'vendor/db'), { name: 'canvas-synapsd' });
    assert.throws(() => assertPublicArtifact(root), /canvas-synapsd/);
});
