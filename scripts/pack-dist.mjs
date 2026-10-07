#!/usr/bin/env node
// Stages a shared package as a self-contained npm package — what
// scripts/publish-npm.mjs publishes to npm (and what `--pack` writes as a
// tarball for inspection).
//
// Rule: the staged package has REGISTRY dependencies only. Git deps (edge's
// `github:canvas-ui/canvas-stored#main`) are copied into the package's own
// node_modules and listed as bundleDependencies, their registry deps merged
// into the package's. Registry mode ({ registry: true }, what publish-npm
// uses) turns workspace deps into `^<version>` deps on the sibling packages
// published to npm; without it they are bundled too. The root LICENSE is
// copied into any package that has none of its own.
//
// Usage:
//   node scripts/pack-dist.mjs <target|all> [--out artifacts] [--pack] [--registry]
//
// Targets: protocol schemas wallpapers api-client edge (see TARGETS).
// Output: <out>/dist/<target>/; --pack also writes <out>/<name>-<version>.tgz.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// target name → source directory.
export const TARGETS = {
    protocol: { dir: 'packages/protocol' },
    schemas: { dir: 'packages/schemas' },
    wallpapers: { dir: 'packages/wallpapers' },
    'api-client': { dir: 'packages/api-client' },
    edge: { dir: 'runtimes/edge' },
    'runtime-core': { dir: 'packages/runtime-core' },
    workspaced: { dir: 'runtimes/workspaced' },
};

const META_FILES = ['package.json', 'LICENSE', 'LICENSE.md', 'NOTICE', 'README.md'];
const isWorkspace = (spec) => /^workspace:/.test(spec);
const isGit = (spec) => /^(github:|git\+|git:|https?:\/\/.*\.git|[\w-]+\/[\w.-]+#)/.test(spec) || /^[\w-]+\/[\w.-]+$/.test(spec);

function readPkg(dir) {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

function gitRev() {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
    catch { return 'unknown'; }
}

/** Where a dependency of `fromDir` is installed (pnpm symlinks → real dir). */
function installedDir(fromDir, name) {
    const p = join(fromDir, 'node_modules', name);
    if (!existsSync(p)) throw new Error(`${name} is not installed under ${fromDir} — run pnpm install`);
    return realpathSync(p);
}

/** Copy a package's publishable files (its `files` + metadata) into `dest`. */
function copyPackageFiles(srcDir, pkg, dest, extra = []) {
    mkdirSync(dest, { recursive: true });
    const wanted = new Set([...(pkg.files || ['src']), ...extra]);
    for (const entry of wanted) {
        const from = join(srcDir, entry);
        if (!existsSync(from)) continue;
        // Skip nested node_modules by path RELATIVE to the package: the source
        // itself may live under a pnpm store path that contains node_modules.
        cpSync(from, join(dest, entry), { recursive: true, filter: (p) => !/(^|\/)node_modules(\/|$)/.test(p.slice(srcDir.length)) });
    }
    for (const f of META_FILES) {
        if (f === 'package.json') continue;
        if (existsSync(join(srcDir, f))) cpSync(join(srcDir, f), join(dest, f));
    }
}

/**
 * Bundle one non-registry dependency into `<parentDir>/node_modules/<name>`.
 * Its own non-registry deps nest underneath the same way (a git dep of a
 * git dep); registry deps are merged upward and
 * declared once on the artifact, where npm hoists them for every level.
 */
function bundleDep(parentDir, name, spec, fromDir) {
    const src = isWorkspace(spec) ? workspaceDir(name) : installedDir(fromDir, name);
    const pkg = readPkg(src);
    const dest = join(parentDir, 'node_modules', name);
    copyPackageFiles(src, pkg, dest);
    const deps = {};
    const optional = { ...(pkg.optionalDependencies || {}) };
    const nested = [];
    for (const [n, s] of Object.entries(pkg.dependencies || {})) {
        if (isWorkspace(s) || isGit(s)) {
            // Nested copy lives under THIS package; only its registry deps
            // bubble up (the nested name itself must never reach the artifact's
            // dependencies — npm would try the registry for it).
            const sub = bundleDep(dest, n, s, src);
            nested.push([n, sub.version]);
            for (const [dn, ds] of Object.entries(sub.deps)) deps[dn] ??= ds;
            Object.assign(optional, sub.optional);
            continue;
        }
        deps[n] = s;
    }
    const manifest = { ...pkg };
    delete manifest.scripts; delete manifest.devDependencies; delete manifest.publishConfig;
    // Same rule as the top level: a bundled copy must be a declared dep at its concrete version.
    manifest.dependencies = { ...(pkg.dependencies || {}) };
    for (const [n, v] of nested) manifest.dependencies[n] = v;
    if (nested.length) manifest.bundleDependencies = nested.map(([n]) => n);
    writeFileSync(join(dest, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    // A git dep's optional deps (e.g. lmdb's platform binaries) travel too.
    return { deps, optional, version: pkg.version };
}

function workspaceDir(name) {
    for (const group of ['packages', 'runtimes', 'apps']) {
        for (const d of readdirSync(join(root, group))) {
            const p = join(root, group, d, 'package.json');
            if (existsSync(p) && readPkg(join(root, group, d)).name === name) return join(root, group, d);
        }
    }
    throw new Error(`workspace package ${name} not found`);
}

export async function stage(targetName, { out = join(root, 'artifacts'), registry = false } = {}) {
    const t = TARGETS[targetName];
    if (!t) throw new Error(`unknown target '${targetName}' (${Object.keys(TARGETS).join(', ')})`);
    const srcDir = join(root, t.dir);
    const pkg = readPkg(srcDir);
    const stageDir = join(out, 'dist', targetName);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    const rev = gitRev();

    copyPackageFiles(srcDir, pkg, stageDir);
    if (!existsSync(join(stageDir, 'LICENSE')) && existsSync(join(root, 'LICENSE'))) cpSync(join(root, 'LICENSE'), join(stageDir, 'LICENSE'));
    const dependencies = {};
    const optionalDependencies = { ...(pkg.optionalDependencies || {}) };
    const bundled = [];
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
        if (!isWorkspace(spec) && !isGit(spec)) { dependencies[name] = spec; continue; }
        if (registry && isWorkspace(spec)) { dependencies[name] = `^${readPkg(workspaceDir(name)).version}`; continue; }
        const { deps, optional, version } = bundleDep(stageDir, name, spec, srcDir);
        bundled.push(name);
        // A bundled dep must ALSO be a declared dependency (its concrete version),
        // or Arborist treats the bundled copy as extraneous and npm pack drops it.
        dependencies[name] = version;
        for (const [n, s] of Object.entries(deps)) {
            if (dependencies[n] && dependencies[n] !== s) console.warn(`[pack-dist] ${targetName}: ${n} wanted as ${dependencies[n]} and ${s} (via ${name}); keeping ${dependencies[n]}`);
            dependencies[n] ??= s;
        }
        Object.assign(optionalDependencies, optional);
    }
    const manifest = { ...pkg };
    delete manifest.scripts; delete manifest.devDependencies; delete manifest.publishConfig;
    manifest.dependencies = dependencies;
    if (Object.keys(optionalDependencies).length) manifest.optionalDependencies = optionalDependencies;
    if (bundled.length) manifest.bundleDependencies = bundled;
    manifest.description = `${pkg.description || pkg.name} (dist artifact)`;
    manifest.canvasRev = rev;
    manifest.canvasSource = t.dir;
    writeFileSync(join(stageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { stageDir, name: manifest.name, version: manifest.version, bundled };
}

export function pack(stageDir, out) {
    mkdirSync(out, { recursive: true });
    const before = new Set(readdirSync(out));
    execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stageDir, stdio: ['ignore', 'ignore', 'inherit'] });
    return readdirSync(out).filter((f) => f.endsWith('.tgz') && !before.has(f)).map((f) => join(out, f));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const which = args.find((a) => !a.startsWith('--')) || 'all';
    const outIdx = args.indexOf('--out');
    const out = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(root, 'artifacts');
    const doPack = args.includes('--pack');
    const registry = args.includes('--registry');
    const names = which === 'all' ? Object.keys(TARGETS) : which.split(',');
    for (const n of names) {
        const res = await stage(n, { out, registry });
        const extra = res.bundled?.length ? ` (bundled: ${res.bundled.join(', ')})` : '';
        console.log(`${n}: ${res.name}@${res.version} → ${res.stageDir}${extra}`);
        if (doPack) for (const f of pack(res.stageDir, out)) console.log(`  packed ${f}`);
    }
}
