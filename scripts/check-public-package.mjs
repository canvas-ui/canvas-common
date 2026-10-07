import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRIVATE_PACKAGES } from './public-packages.mjs';

const read = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
function dependencyDir(from, name) {
    for (let dir = from; ; dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        if (dirname(dir) === dir) return null;
    }
}
function checkManifest(pkg, chain) {
    if (pkg.private || PRIVATE_PACKAGES.has(pkg.name)) throw new Error(`Private package cannot enter an npm distribution: ${chain.join(' -> ')}`);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
        if (PRIVATE_PACKAGES.has(name)) throw new Error(`Private dependency cannot enter an npm distribution: ${[...chain, name].join(' -> ')}`);
    }
}

/** Check the installed production closure before copying any dependency sources. */
export function assertPublicDependencies(dir, seen = new Set(), chain = []) {
    dir = realpathSync(dir);
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = read(dir);
    chain = [...chain, pkg.name];
    checkManifest(pkg, chain);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
        const child = dependencyDir(dir, name);
        if (child) assertPublicDependencies(child, seen, chain);
        else if (!pkg.optionalDependencies?.[name]) throw new Error(`Cannot verify missing dependency ${[...chain, name].join(' -> ')}`);
    }
}

/** Also inspect vendored manifests, even if they are not declared dependencies. */
export function assertPublicArtifact(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) assertPublicArtifact(file);
        else if (entry.name === 'package.json') {
            const pkg = JSON.parse(readFileSync(file, 'utf8'));
            checkManifest(pkg, [file, pkg.name]);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const dir = resolve(process.argv[2] || '.');
    assertPublicDependencies(dir);
    assertPublicArtifact(dir);
    console.log('Public package contains no private workspace engine');
}
