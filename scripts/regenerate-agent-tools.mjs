import fs from 'node:fs';

const source = new URL('../../canvas-server/src/runtimes/agent/', import.meta.url);
const target = new URL('../runtimes/agent/src/core/agent/', import.meta.url);
const check = process.argv.includes('--check');
let changed = false;
for (const [from, to] of [['tools/index.js', 'tools/index.js'], ['tools/client.js', 'tools/client.js'], ['tools/render.js', 'tools/render.js'], ['tools/trees.js', 'tools/trees.js'], ['config/files.js', 'files.js'],
    ['Agent.js', 'Agent.js'], ['config/models.js', 'config/models.js'], ['config/generation.js', 'config/generation.js'],
    ['runtime/view-context.js', 'view-context.js'], ['../../utils/private-file.js', '../../utils/private-file.js'],
    ['../../transports/routes/agents/index.js', '../../transports/routes/agents/index.js']]) {
    let code = fs.readFileSync(new URL(from, source), 'utf8');
    // The standalone package has a flat agent directory and its own auth entry.
    if (from === 'Agent.js') code = code.replaceAll('./runtime/worker-session.js', './worker-session.js')
        .replaceAll('./runtime/view-context.js', './view-context.js').replaceAll('./config/files.js', './files.js');
    if (from === '../../transports/routes/agents/index.js') code = code
        .replaceAll('../../../runtimes/agent/config/models.js', '../../../core/agent/config/models.js')
        .replaceAll('../../../runtimes/agent/runtime/view-context.js', '../../../core/agent/view-context.js')
        .replaceAll('../../auth/strategies.js', '../../auth/validate-user.js');
    const bytes = Buffer.from(code);
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
