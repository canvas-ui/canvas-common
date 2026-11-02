import fs from 'node:fs';

const source = new URL('../../canvas-server/src/runtimes/agent/', import.meta.url);
const target = new URL('../runtimes/agent/src/core/agent/', import.meta.url);
const check = process.argv.includes('--check');
let changed = false;
for (const [from, to] of [['tools/index.js', 'tools/index.js'], ['tools/client.js', 'tools/client.js'], ['tools/render.js', 'tools/render.js'], ['tools/trees.js', 'tools/trees.js'], ['config/files.js', 'files.js']]) {
    const bytes = fs.readFileSync(new URL(from, source));
    const destination = new URL(to, target);
    if (fs.existsSync(destination) && bytes.equals(fs.readFileSync(destination))) continue;
    if (check) throw new Error(`Stale generated agent file: ${to}`);
    fs.mkdirSync(new URL('.', destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    changed = true;
}
if (changed && process.argv.includes('--bump')) {
    for (const relative of ['../package.json', '../runtimes/agent/package.json']) {
        const file = new URL(relative, import.meta.url);
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        const version = manifest.version.split('.').map(Number);
        version[2]++;
        manifest.version = version.join('.');
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    }
}
console.log(`Agent tools ${check ? 'verified' : 'refreshed'} from production sources`);
