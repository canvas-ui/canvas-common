import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';

// The production workspace host and its relative module graph are copied verbatim.
// No source rewrites or compatibility entrypoints belong in this snapshot.
const common = fileURLToPath(new URL('../', import.meta.url));
const server = path.resolve(common, '../canvas-server');
const source = path.join(server, 'src');
const target = path.join(common, 'packages/runtime-core/src');
const check = process.argv.includes('--check');
let changed = false;
const files = new Set();
const packages = new Set();
const visit = relative => {
  if (files.has(relative)) return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Source escapes src: ${relative}`);
  const file = path.join(source, relative);
  if (!fs.statSync(file).isFile()) throw new Error(`Expected a source file: ${relative}`);
  files.add(relative);
  if (!relative.endsWith('.js')) return;
  const code = fs.readFileSync(file, 'utf8');
  const specifiers = [];
  const scan = node => {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
      if (typeof node.source.value === 'string') specifiers.push(node.source.value);
      // Hooks load user-authored modules from the workspace, not this package.
      else if (!(relative === 'runtimes/workspace/services/hooks/index.js' && node.source.name === 'moduleUrl')) {
        throw new Error(`Declare dynamic module assets explicitly: ${relative}`);
      }
    }
    if ((node.type === 'NewExpression' && node.callee?.name === 'URL') ||
        (node.type === 'CallExpression' && (node.callee?.name === 'require' ||
          (node.callee?.object?.name === 'require' && node.callee?.property?.name === 'resolve')))) {
      const value = node.arguments?.[0]?.value;
      if (typeof value === 'string' && (value.startsWith('.') || node.type === 'CallExpression')) specifiers.push(value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') scan(value);
    }
  };
  scan(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) visit(path.normalize(path.join(path.dirname(relative), specifier)));
    else packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
  }
};
visit('runtimes/workspace/runtime/host.js');
// Dotfile seeds are read from disk, including scripts that are not module imports.
const assets = 'runtimes/workspace/services/dotfile/files';
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const file of walk(path.join(source, assets))) files.add(path.relative(source, file));
const serverPackage = JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8'));
const dependencies = {};
for (const name of [...packages].sort()) {
  if (isBuiltin(name)) continue;
  const version = serverPackage.dependencies?.[name];
  if (!version) throw new Error(`Undeclared runtime dependency: ${name}`);
  dependencies[name] = version;
}
for (const relative of ['packages/runtime-core/package.json', 'package.json']) {
  const file = path.join(common, relative);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = relative === 'package.json'
    ? { ...dependencies, '@augmentd-labs/canvas-agent-runtime': manifest.dependencies['@augmentd-labs/canvas-agent-runtime'] }
    : dependencies;
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(wanted)) changed = true;
  if (check) {
    if (JSON.stringify(manifest.dependencies) !== JSON.stringify(wanted)) throw new Error(`Stale runtime dependencies: ${relative}`);
  } else {
    manifest.dependencies = wanted;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
}
const expected = [...files].sort();
{
  const actual = fs.existsSync(target) ? walk(target).map(file => path.relative(target, file)).sort() : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some(file => !fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(target, file))))) {
    changed = true;
    if (check) throw new Error('runtime-core is stale; run npm run runtime:refresh in canvas-common');
  }
}
if (!check && changed) {
  fs.rmSync(target, { recursive: true, force: true });
  for (const file of expected) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}
if (!check && changed && process.argv.includes('--bump')) {
  for (const relative of ['package.json', 'packages/runtime-core/package.json', 'runtimes/workspaced/package.json']) {
    const file = path.join(common, relative);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const version = manifest.version.split('.').map(Number);
    version[2] += 1; manifest.version = version.join('.');
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
}
console.log(`runtime-core ${check ? 'verified' : 'refreshed'}: ${expected.length} source and asset files`);
