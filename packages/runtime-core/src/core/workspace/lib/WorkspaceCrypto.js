import { randomBytes, scrypt, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';

const derive = promisify(scrypt);
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SECRET_KEYS = /^(password|passphrase|token|accessToken|refreshToken|clientSecret|apiKey|secret|webhookSecret|privateKey|secretAccessKey|accessKeySecret|authorization|cookie|x-api-key)$/i;
export const protectionError = (code, message, statusCode = 423) => Object.assign(new Error(message), { code, statusCode, retryable: false });
export const isSecretRef = (value) => typeof value === 'string' && value.startsWith('secret://');
export function containsSecrets(value) {
    if (isSecretRef(value)) return true;
    return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
        (SECRET_KEYS.test(key) && typeof item === 'string' && item.length > 0) || (key === 'headers' && item && Object.values(item).some(Boolean)) || containsSecrets(item));
}

// Rename is the commit point. Seal the secret store BEFORE committing references.
export function writePrivateJson(target, value) {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
    chmodSync(target, 0o600);
}
function readJson(target, fallback) {
    try { return JSON.parse(readFileSync(target, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT' && fallback !== undefined) return fallback; throw err; }
}
function seal(key, plaintext, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    return { iv: iv.toString('base64'), ct: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function open(key, box, aad) {
    const iv = Buffer.from(box.iv, 'base64');
    const tag = Buffer.from(box.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(box.ct, 'base64')), cipher.final()]);
}

/** Portable secrets vault. Only the workspace's running runtime owns key buffers. */
export default class WorkspaceCrypto {
    #dek = null;
    #key = null;
    #failures = 0;
    #retryAt = 0;
    constructor(root) { this.directory = path.join(root, '.workspace'); }
    get keyslotPath() { return path.join(this.directory, 'keyslots.json'); }
    get secretsPath() { return path.join(this.directory, 'secrets.json'); }
    get protected() { return existsSync(this.keyslotPath) || existsSync(this.secretsPath); }
    get unlocked() { return this.#key !== null; }
    get mode() {
        if (!this.protected) return 'none';
        try {
            const file = readJson(this.keyslotPath);
            if (file.version !== 1 || !['secrets', 'workspace'].includes(file.mode)) throw new Error();
            return file.mode;
        } catch { throw protectionError('WORKSPACE_KEYS_CORRUPT', 'Workspace keyslot file is corrupt'); }
    }
    #activate(dek) {
        this.stop();
        this.#dek = dek;
        this.#key = Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), 'canvas/workspace/k_secrets/v1', 32));
    }
    async #slot(type, password, dek) {
        const salt = randomBytes(16);
        const key = await derive(password, salt, 32, KDF);
        try { return { type, salt: salt.toString('base64'), wrapped: seal(key, dek, `canvas/keyslot/v1/${type}`) }; }
        finally { key.fill(0); }
    }
    async configure({ passphrase, mode = 'secrets', currentPassphrase }) {
        if (!['secrets', 'workspace'].includes(mode) || typeof passphrase !== 'string' || passphrase.length < 4 || passphrase.length > 1024) {
            throw protectionError('INVALID_PROTECTION', 'Choose a mode and a PIN/password of 4–1024 characters', 400);
        }
        // Always verify the old credential, even if already running/unlocked.
        if (this.protected) await this.unlock(currentPassphrase);
        const dek = this.#dek || randomBytes(32);
        const recoveryKey = randomBytes(32).toString('base64url');
        try {
            const slots = [await this.#slot('passphrase', passphrase, dek), await this.#slot('recovery', recoveryKey, dek)];
            writePrivateJson(this.keyslotPath, { version: 1, mode, kdf: { alg: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p }, slots });
            if (!this.#dek) this.#activate(dek);
            return { mode, recoveryKey };
        } catch (err) { if (dek !== this.#dek) dek.fill(0); throw err; }
    }
    async unlock(passphrase) {
        if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) throw protectionError('WORKSPACE_PASSPHRASE_REQUIRED', 'Enter the workspace PIN/password or recovery key');
        if (Date.now() < this.#retryAt) throw protectionError('WORKSPACE_UNLOCK_THROTTLED', 'Too many unlock attempts; try again shortly', 429);
        let file;
        try {
            file = readJson(this.keyslotPath);
            if (file.version !== 1 || file.kdf?.alg !== 'scrypt' || file.kdf.N !== KDF.N || file.kdf.r !== KDF.r || file.kdf.p !== KDF.p || !Array.isArray(file.slots) || file.slots.length !== 2) throw new Error();
        } catch { throw protectionError('WORKSPACE_KEYS_CORRUPT', 'Workspace keyslot file is corrupt'); }
        for (const slot of file.slots) {
            let key;
            try {
                if (!['passphrase', 'recovery'].includes(slot.type)) throw new Error();
                const salt = Buffer.from(slot.salt, 'base64');
                if (salt.length !== 16) throw new Error();
                key = await derive(passphrase, salt, 32, KDF);
                const dek = open(key, slot.wrapped, `canvas/keyslot/v1/${slot.type}`);
                if (dek.length !== 32) { dek.fill(0); throw new Error(); }
                this.#activate(dek);
                this.#failures = 0;
                this.#retryAt = 0;
                // Authenticate the entire vault before any driver can start.
                try { for (const id of Object.keys(readJson(this.secretsPath, {}))) this.resolve(`secret://${id}`); }
                catch (err) { this.stop(); throw err; }
                return;
            } catch (err) { if (err.code === 'WORKSPACE_SECRETS_CORRUPT') throw err; }
            finally { key?.fill(0); }
        }
        this.#failures++;
        if (this.#failures >= 5) this.#retryAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(this.#failures, 9));
        throw protectionError('WORKSPACE_UNLOCK_FAILED', 'Incorrect PIN/password or damaged workspace keyslot');
    }
    protect(value, prefix = 'services') {
        if (!this.protected) return structuredClone(value);
        const secrets = readJson(this.secretsPath, {});
        let changed = false;
        const visit = (item, parts, key = '', sensitive = false) => {
            if (isSecretRef(item)) return item;
            if ((sensitive || SECRET_KEYS.test(key)) && typeof item === 'string' && item) {
                if (!this.#key) throw protectionError('WORKSPACE_SECRETS_LOCKED', 'Start with the PIN/password before changing credentials');
                const id = parts.map(encodeURIComponent).join('/');
                const plain = Buffer.from(item);
                try { secrets[id] = seal(this.#key, plain, id); } finally { plain.fill(0); }
                changed = true;
                return `secret://${id}`;
            }
            if (Array.isArray(item)) return item.map((child, i) => visit(child, [...parts, String(i)], key, sensitive));
            if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, [...parts, name], name, sensitive || key === 'headers')]));
            return item;
        };
        const result = visit(value, [prefix]);
        if (changed) writePrivateJson(this.secretsPath, secrets);
        return result;
    }
    resolve(value) {
        if (isSecretRef(value)) {
            if (!this.#key) throw protectionError('WORKSPACE_SECRETS_LOCKED', 'Start with the PIN/password to use authenticated integrations');
            const id = value.slice(9);
            let plain;
            try { plain = open(this.#key, readJson(this.secretsPath)[id], id); return plain.toString('utf8'); }
            catch { throw protectionError('WORKSPACE_SECRETS_CORRUPT', 'Workspace secrets are missing or corrupt'); }
            finally { plain?.fill(0); }
        }
        if (Array.isArray(value)) return value.map((item) => this.resolve(item));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item)]));
        return value;
    }
    stop() { this.#key?.fill(0); this.#dek?.fill(0); this.#key = null; this.#dek = null; }
}

// Public metadata must never disclose plaintext from a not-yet-migrated workspace.
export function redactSecrets(value, inHeaders = false) {
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item, inHeaders));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        (inHeaders || SECRET_KEYS.test(key)) && typeof item === 'string' && item ? true : redactSecrets(item, key === 'headers')]));
}
