#!/usr/bin/env node
// Publishes the shared packages to npm (@augmentd-labs scope) — every version
// in PACKAGES that the registry does not have yet; published versions are
// skipped, so this is safe to run on every push to main (release.yml).
//
// Each package is staged by scripts/pack-dist.mjs in registry mode: workspace
// deps become `^<version>` deps on the published siblings, git deps (edge's
// canvas-stored) are bundled. Order matters only for humans reading the log —
// npm does not check that dependencies exist at publish time.
//
// To release: bump the package's version (a dependent that needs the new
// version bumps its own too), push main. Locally:
//   node scripts/publish-npm.mjs [name,…] [--dry-run]
// Auth: CI uses npm trusted publishing (GitHub OIDC, provenance attached);
// a local run uses whatever token your npm config has.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage } from './pack-dist.mjs';
import { PUBLIC_PACKAGES } from './public-packages.mjs';

export const PACKAGES = PUBLIC_PACKAGES;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => !a.startsWith('--'));
const names = only ? only.split(',') : PACKAGES;
for (const n of names) if (!PACKAGES.includes(n)) throw new Error(`'${n}' is not published to npm (${PACKAGES.join(', ')})`);

function published(name, version) {
    try {
        return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
    } catch {
        return false; // E404: package or version not on the registry yet
    }
}

const out = mkdtempSync(join(tmpdir(), 'canvas-npm-'));
let failed = 0;
try {
    for (const n of names) {
        const { stageDir, name, version } = await stage(n, { out, registry: true });
        if (published(name, version)) {
            console.log(`${name}@${version}: already on npm — skipping`);
            continue;
        }
        // Run from inside the staged dir: npm 11 validates `bin` paths against the
        // cwd, so `npm publish <dir>` from here silently drops wallpapers' bin.
        const cmd = ['publish', '--access', 'public'];
        if (process.env.GITHUB_ACTIONS === 'true') cmd.push('--provenance');
        if (dryRun) cmd.push('--dry-run');
        console.log(`${name}@${version}: npm ${cmd.join(' ')}`);
        try {
            execFileSync('npm', cmd, { cwd: stageDir, stdio: 'inherit' });
        } catch {
            console.error(`${name}@${version}: publish FAILED`);
            failed++;
        }
    }
} finally {
    rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
