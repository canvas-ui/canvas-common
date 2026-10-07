#!/usr/bin/env node
// Build an isolated public workspace. pnpm can fetch private importers from a
// shared lockfile even with --filter, so they must not be present at all.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PUBLIC_PACKAGES } from './public-packages.mjs';
import { TARGETS } from './pack-dist.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(source, '.public-workspace');
// This generated directory is exclusively owned by this script.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(source, 'package.json')));
delete manifest.dependencies; delete manifest.exports; delete manifest.bin; delete manifest.files;
writeFileSync(path.join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const name of ['pnpm-workspace.yaml', 'eslint.config.js', 'LICENSE', 'scripts']) {
    cpSync(path.join(source, name), path.join(out, name), { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') });
}
const dirs = PUBLIC_PACKAGES.map(name => TARGETS[name].dir);
for (const dir of dirs) {
    cpSync(path.join(source, dir), path.join(out, dir), { recursive: true,
        filter: file => !file.split(path.sep).some(segment => ['node_modules', 'dist', 'coverage'].includes(segment)) });
}
// Retain exact resolutions and integrity hashes. Only public importers survive;
// unreferenced package snapshots remain harmless and keep the lockfile stable.
const lock = readFileSync(path.join(source, 'pnpm-lock.yaml'), 'utf8');
const start = lock.indexOf('importers:\n') + 'importers:\n'.length;
const end = lock.indexOf('\npackages:\n', start);
if (start < 11 || end < 0) throw new Error('Unsupported pnpm lockfile layout');
const blocks = lock.slice(start, end).split(/(?=^ {2}[^\s].*:(?: \{\})?$)/m);
const kept = blocks.flatMap(block => {
    const match = /^ {2}([^\n]+?):(?: \{\})?$/m.exec(block);
    if (!match) return [];
    if (match[1] === '.') {
        const dev = block.indexOf('    devDependencies:\n');
        if (dev < 0) throw new Error('Root development dependencies missing from lockfile');
        return ['  .:\n' + block.slice(dev)];
    }
    return dirs.includes(match[1]) ? [block] : [];
});
if (kept.length !== dirs.length + 1) throw new Error('Public importer is missing from lockfile');
writeFileSync(path.join(out, 'pnpm-lock.yaml'), lock.slice(0, start) + '\n' + kept.join('') + lock.slice(end));
execFileSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit', cwd: out });
for (const forbidden of ['node_modules/canvas-synapsd', 'packages/runtime-core', 'runtimes/workspaced']) {
    if (existsSync(path.join(out, forbidden))) throw new Error(`Private package entered public workspace: ${forbidden}`);
}
console.log(`Public workspace ready: ${out}`);
