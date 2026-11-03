#!/usr/bin/env node
// Generate private agent deployments and the workspace launcher from runtime sources.
// Production-derived files are refreshed by regenerate-agent-tools.mjs first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const common = fileURLToPath(new URL('../', import.meta.url));
const workspace = process.argv.includes('--workspace');
const generated = workspace ? 'launcher' : 'runtime';
const outIndex = process.argv.indexOf('--out');
const out = outIndex < 0 ? (workspace ? path.join(common, 'runtimes/workspaced') : path.resolve(common, '../canvas-agentd')) : path.resolve(process.argv[outIndex + 1]);
const check = process.argv.includes('--check');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const groups = [
    { from: 'runtimes/agent', to: generated, dirs: workspace ? [] : ['src', 'bin', 'deploy'] },
    { from: 'packages/api-client', to: `${generated}/packages/api-client`, dirs: ['src'] },
    { from: 'packages/protocol', to: `${generated}/packages/protocol`, dirs: ['src'] },
];
const entries = new Map();
for (const group of groups.slice(1)) {
    const pkg = read(path.join(common, group.from, 'package.json'));
    for (const [key, value] of Object.entries(pkg.exports)) {
        const entry = typeof value === 'string' ? value : value.default;
        entries.set(pkg.name + (key === '.' ? '' : key.slice(1)), path.join(out, group.to, entry));
    }
}
const expected = new Map();
const dependencies = {};
function collect(from, relative) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const destination = path.join(relative, entry.name);
        if (entry.isDirectory()) collect(source, destination);
        else {
            let bytes = fs.readFileSync(source);
            if (entry.name.endsWith('.js')) {
                bytes = Buffer.from(bytes.toString().replace(/(['"])(@augmentd-labs\/canvas-(?:api-client|protocol)(?:\/[^'"\s]+)?)\1/g, (_literal, quote, spec) => {
                    const target = entries.get(spec);
                    if (!target) throw new Error(`Unknown shared module: ${spec}`);
                    let resolved = path.relative(path.dirname(path.join(out, destination)), target).split(path.sep).join('/');
                    if (!resolved.startsWith('.')) resolved = `./${resolved}`;
                    return `${quote}${resolved}${quote}`;
                }));
            }
            if (workspace && destination.includes('/packages/api-client/')) bytes = Buffer.from(bytes.toString().replace(/(['"])undici\1/g, '$1@canvas-local/undici$1'));
            expected.set(destination, bytes);
        }
    }
}
for (const group of groups) {
    const source = path.join(common, group.from);
    const pkg = read(path.join(source, 'package.json'));
    if (workspace && group === groups[0]) {
        const daemon = fs.readFileSync(path.join(source, 'src/runtime/daemon.js'), 'utf8').replace('@augmentd-labs/canvas-api-client/edge', '../../packages/api-client/src/EdgeClient.js');
        expected.set('launcher/src/runtime/daemon.js', Buffer.from(daemon));
        dependencies['proper-lockfile'] = pkg.dependencies['proper-lockfile'];
        continue;
    }
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
        if (entries.has(name)) continue;
        if (spec.startsWith('workspace:')) throw new Error(`Unbundled workspace dependency: ${name}`);
        if (dependencies[name] && dependencies[name] !== spec) throw new Error(`Conflicting dependency: ${name}`);
        if (workspace && name === 'undici') dependencies['@canvas-local/undici'] = `npm:undici@${spec}`;
        else dependencies[name] = spec;
    }
    for (const dir of group.dirs) collect(path.join(source, dir), path.join(group.to, dir));
    for (const file of ['NOTICE', 'LICENSE', 'README.md']) {
        if (fs.existsSync(path.join(source, file))) expected.set(path.join(group.to, file), fs.readFileSync(path.join(source, file)));
    }
}
// Retain only shared source modules reachable from the runtime entrypoints.
const live = new Set();
function visit(relative) {
    if (live.has(relative) || !expected.has(relative)) return;
    live.add(relative);
    if (!relative.endsWith('.js')) return;
    for (const match of expected.get(relative).toString().matchAll(/(['"])(\.[^'"\s]+\.js)\1/g)) {
        visit(path.normalize(path.join(path.dirname(relative), match[2])));
    }
}
for (const relative of expected.keys()) if (!relative.includes('/packages/')) visit(relative);
for (const relative of expected.keys()) {
    if (relative.includes('/packages/') && relative.endsWith('.js') && !live.has(relative)) expected.delete(relative);
}
if (workspace) {
    expected.set('launcher/dependencies.json', Buffer.from(JSON.stringify(dependencies, null, 2) + '\n'));
} else {
    const manifestFile = path.join(out, 'package.json');
    const manifest = fs.existsSync(manifestFile) ? read(manifestFile) : {
        name: 'canvas-agentd', version: read(path.join(common, 'runtimes/agent/package.json')).version,
        type: 'module', main: './src/runtime.js', bin: { 'canvas-agent': './src/local.js' },
        engines: { node: '>=22.19.0' },
    };
    manifest.private = true;
    manifest.files = ['runtime', 'src/local.js', 'src/runtime.js'];
    const existing = { ...manifest.dependencies };
    delete existing['@augmentd-labs/canvas-agent-runtime'];
    manifest.dependencies = { ...existing, ...dependencies };
    expected.set('package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    expected.set('src/runtime.js', Buffer.from("export { main } from '../runtime/src/main.js';\n"));
    expected.set('src/local.js', Buffer.from("#!/usr/bin/env node\nimport { main } from './runtime.js';\nmain().catch(error => { console.error(error.message); process.exitCode = 1; });\n"));
}
function prune(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) prune(file);
        else if (!expected.has(path.relative(out, file))) {
            if (check) throw new Error(`Stale generated file: ${file}`);
            fs.unlinkSync(file);
        }
    }
}
prune(path.join(out, generated));
for (const [relative, bytes] of expected) {
    const file = path.join(out, relative);
    if (fs.existsSync(file) && bytes.equals(fs.readFileSync(file))) continue;
    if (check) throw new Error(`Regenerate AgentD: ${relative}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
}
console.log(`Private runtime distribution ${check ? 'verified' : 'generated'}: ${out}`);
