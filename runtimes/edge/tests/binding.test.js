import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BINDING_FILE, bindFolder } from '../src/binding.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'edge-binding-'));

test('first start binds folder and state; later starts return the same id', () => {
    const base = tmp(); const folder = path.join(base, 'folder'); const state = path.join(base, 'state');
    const id = bindFolder(folder, state, false);
    assert.strictEqual(fs.readFileSync(path.join(folder, BINDING_FILE), 'utf8').trim(), id);
    assert.strictEqual(bindFolder(folder, state, true), id);
});

test('an unmounted folder (empty directory at the same path) is refused', () => {
    const base = tmp(); const folder = path.join(base, 'folder'); const state = path.join(base, 'state');
    bindFolder(folder, state, false);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    fs.rmSync(folder, { recursive: true });
    fs.mkdirSync(folder);
    assert.throws(() => bindFolder(folder, state, true), /not the folder/);
    assert.strictEqual(fs.existsSync(path.join(folder, BINDING_FILE)), false, 'nothing written into the stand-in');
});

test('history from before bindings: an empty folder is refused, a populated one is bound', () => {
    const base = tmp(); const folder = path.join(base, 'folder'); const state = path.join(base, 'state');
    fs.mkdirSync(folder); fs.mkdirSync(state);
    assert.throws(() => bindFolder(folder, state, true), /is empty but/);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    assert.match(bindFolder(folder, state, true), /^[0-9a-f]{32}$/);
});

test('state inside the folder: marker and record are one file', () => {
    const base = tmp(); const folder = path.join(base, 'folder');
    const id = bindFolder(folder, path.join(folder, '.workspace'), false);
    assert.strictEqual(bindFolder(folder, path.join(folder, '.workspace'), true), id);
});
