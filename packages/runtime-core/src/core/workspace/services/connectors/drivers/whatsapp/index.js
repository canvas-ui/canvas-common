import { messageImages } from '../../../messages/images.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pino from 'pino';
import BaseConnector from '../../BaseConnector.js';
import { openAuthState } from './auth.js';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Personal WhatsApp linked device. Socket state lives outside stored.json:
// account descriptors/API reads must never expose Signal keys or credentials.
export default class WhatsAppConnector extends BaseConnector {
    static driver = 'whatsapp';
    static requiresAuthentication = true;
    static label = 'WhatsApp (linked device)';
    static icon = 'mdi:whatsapp';
    static blurb = 'Pair your phone and select conversations to synchronize.';
    static provenanceScheme = 'whatsapp';
    static configFields = [
        { key: 'address', label: 'Account label', required: true },
        { key: 'chats', label: 'Conversation IDs', list: true },
    ];
    #root;
    #authRoot;
    #legacyRoot;
    #mediaRoot;
    #mediaPrefix;
    #onDocument;
    #onContainer;
    #onContacts;
    #contacts = new Map();
    #socket;
    #starting;
    #stopped = false;
    #retry;
    #attempt = 0;
    #qr = null;
    #state = 'disconnected';
    #chats = new Map();
    #queue = Promise.resolve();
    #lib;
    #auth;
    #sessionSecrets;

    constructor(address, config, { rootPath, configDir = path.join(rootPath, 'config'), varPath = path.join(rootPath, 'var'), homePath = path.join(rootPath, 'home'), onDocument, onContainer = null, onContacts = null, sessionSecrets = null, ...options } = {}) {
        super(address, config, options);
        this.#root = path.join(varPath, 'whatsapp', hash(address));
        this.#authRoot = path.join(configDir, 'whatsapp', hash(address));
        this.#legacyRoot = path.join(rootPath, 'var', 'whatsapp', hash(address));
        const account = `${String(address).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60)}-${hash(address).slice(0, 8)}`;
        this.#mediaPrefix = `WhatsApp/Media/${account}`;
        this.#mediaRoot = path.join(homePath, this.#mediaPrefix);
        this.#onDocument = onDocument;
        this.#onContainer = onContainer;
        this.#onContacts = onContacts;
        this.#sessionSecrets = sessionSecrets;
        this.#lib = options.library;
    }

    #selected(jid) { return (this.config.chats || []).includes(jid); }
    #enqueue(fn) {
        this.#queue = this.#queue.then(fn).catch((error) => this.logger.warn?.({ error: error.message }, 'WhatsApp local persistence failed'));
    }

    async #start() {
        if (this.#state === 'logged-out') return;
        if (this.#stopped || this.#socket || this.#starting) return this.#starting;
        this.#starting = this.#connect().finally(() => { this.#starting = null; });
        return this.#starting;
    }

    async #connect() {
        const lib = this.#lib ||= await import('@whiskeysockets/baileys');
        await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
        await fs.chmod(this.#root, 0o700);
        await fs.mkdir(this.#authRoot, { recursive: true, mode: 0o700 });
        // Move legacy runtime files out of the home mirror; never overwrite a
        // newer canonical file. Keep auth in config, raw messages in runtime.
        const move = async (source, target) => {
            try { await fs.access(target); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
            try {
                await fs.rename(source, target);
            } catch (error) {
                if (error.code === 'ENOENT') return;
                if (error.code !== 'EXDEV') throw error;
                await fs.copyFile(source, target); await fs.unlink(source);
            }
        };
        if (this.#legacyRoot !== this.#root) {
            const files = await fs.readdir(this.#legacyRoot).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
            for (const file of files) if (file === 'chats.json' || file === 'session.json' || /^[a-f0-9]{64}\.json$/.test(file)) {
                await move(path.join(this.#legacyRoot, file), path.join(this.#root, file));
            }
        }
        await move(path.join(this.#root, 'session.json'), path.join(this.#authRoot, 'session.json'));

        // One linked-device session per configured account, persisted by Baileys.
        await this.#queue;
        await this.#auth?.flush();
        this.#auth = await openAuthState(this.#authRoot, lib, this.#sessionSecrets);
        const { state, saveCreds } = this.#auth;
        try { for (const c of JSON.parse(await fs.readFile(path.join(this.#root, 'chats.json'), 'utf8'))) this.#chats.set(c.id, c); } catch { /* no saved chat list */ }
        try { for (const contact of JSON.parse(await fs.readFile(path.join(this.#root, 'contacts.json'), 'utf8'))) this.#contacts.set(contact.id, contact); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await this.#onContacts?.([...this.#contacts.values()]);
        if (this.#stopped) return;
        const socket = lib.default({
            auth: state, logger: pino({ level: 'silent' }),
            browser: lib.Browsers.ubuntu('Canvas'), markOnlineOnConnect: false,
            syncFullHistory: true,
            getMessage: async (key) => (await this.#readMessage(key))?.message,
        });
        this.#socket = socket;
        this.#state = 'connecting';
        socket.ev.on('creds.update', () => { if (socket === this.#socket && !this.#stopped) this.#enqueue(saveCreds); });
        socket.ev.on('connection.update', (update) => {
            if (socket !== this.#socket || this.#stopped) return;
            if (update.qr) { this.#qr = update.qr; this.#state = 'pairing'; }
            if (update.connection === 'open') { this.#state = 'connected'; this.#qr = null; this.#attempt = 0; }
            if (update.connection === 'close') {
                this.#socket = null;
                this.#qr = null;
                const loggedOut = update.lastDisconnect?.error?.output?.statusCode === lib.DisconnectReason.loggedOut;
                this.#state = loggedOut ? 'logged-out' : 'disconnected';
                if (!loggedOut) {
                    this.#retry = setTimeout(() => this.#start().catch(() => { this.#state = 'error'; }), Math.min(60000, 1000 * 2 ** this.#attempt++));
                    this.#retry.unref?.();
                }
            }
        });
        const rememberChats = (chats = []) => {
            for (const c of chats) if (c.id && !c.id.endsWith('@broadcast')) this.#chats.set(c.id, { id: c.id, name: c.name || c.subject || c.notify || c.verifiedName || this.#chats.get(c.id)?.name || c.id });
        };
        const persistChats = (chats) => {
            rememberChats(chats);
            this.#enqueue(async () => {
                await fs.writeFile(path.join(this.#root, 'chats.json'), JSON.stringify([...this.#chats.values()]), { mode: 0o600 });
                if (!this.#stopped) for (const chat of chats || []) {
                    if (this.#selected(chat.id)) await this.#onContainer?.(this.#chats.get(chat.id));
                }
            });
        };
        socket.ev.on('chats.upsert', persistChats);
        socket.ev.on('chats.update', persistChats);
        const persistContacts = (contacts = []) => {
            for (const contact of contacts) if (contact.id) this.#contacts.set(contact.id, { ...this.#contacts.get(contact.id), ...contact });
            const updated = contacts.map((contact) => this.#contacts.get(contact.id)).filter(Boolean);
            persistChats(updated);
            this.#enqueue(async () => {
                await fs.writeFile(path.join(this.#root, 'contacts.json'), JSON.stringify([...this.#contacts.values()]), { mode: 0o600 });
                if (!this.#stopped) await this.#onContacts?.(updated);
            });
        };
        socket.ev.on('contacts.upsert', persistContacts);
        socket.ev.on('contacts.update', persistContacts);
        socket.ev.on('groups.update', persistChats);
        socket.ev.on('messaging-history.set', ({ chats, messages, contacts }) => {
            persistChats(chats);
            persistContacts(contacts);
            for (const m of messages || []) this.#enqueue(() => this.#ingest(m));
        });
        socket.ev.on('messages.upsert', ({ messages }) => {
            for (const m of messages || []) this.#enqueue(() => this.#ingest(m));
        });
    }

    async stop() {
        this.#stopped = true;
        clearTimeout(this.#retry);
        this.#socket?.end(new Error('Canvas account stopped'));
        this.#socket = null;
        this.#qr = null;
        await this.#starting;
        await this.#queue;
        await this.#auth?.flush();
    }

    async resetSession() {
        await this.stop();
        await this.#starting;
        await this.#queue;
        await this.#auth?.flush();
        await fs.unlink(path.join(this.#authRoot, 'session.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        this.#stopped = false;
        this.#state = 'disconnected';
        this.#attempt = 0;
        await this.#start();
        return { state: this.#state };
    }

    async connectionStatus() {
        await this.#start();
        const { default: QRCode } = await import('qrcode');
        return { state: this.#state, qr: this.#qr ? await QRCode.toDataURL(this.#qr) : null, chats: [...this.#chats.values()] };
    }

    async test() {
        await this.#start();
        if (this.#state !== 'connected') throw new Error('Pair this account from its WhatsApp connection panel');
    }

    async listContainers() {
        await this.#start();
        return (this.config.chats || []).map((id) => this.#chats.get(id) || { id, name: id });
    }
    async fetchChanges(container, cursor) {
        await this.#start();
        // Initial history arrives during pairing, before the picker selection
        // is saved. Replay that local history after selecting a conversation.
        await this.#queue;
        if (!this.#selected(container.id)) return { documents: [], nextCursor: cursor, done: true };
        const documents = [];
        for (const file of await fs.readdir(this.#root)) {
            // Auth state and chats.json share this directory; only message
            // files use a sha256 filename.
            if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
            const message = JSON.parse(await fs.readFile(path.join(this.#root, file), 'utf8'), this.#lib.BufferJSON.reviver);
            if (message.key?.remoteJid !== container.id) continue;
            const document = await this.#toDocument(message);
            if (document) documents.push(document);
        }
        documents.sort((a, b) => a.data.timestamp.localeCompare(b.data.timestamp));
        return { documents, nextCursor: cursor, done: true };
    }

    #messageFile(key) { return path.join(this.#root, `${hash(`${key.remoteJid}/${key.id}`)}.json`); }
    async #readMessage(key) {
        try { return JSON.parse(await fs.readFile(this.#messageFile(key), 'utf8'), this.#lib.BufferJSON.reviver); }
        catch { return undefined; }
    }
    async #toDocument(message) {
        const jid = message.key.remoteJid;
        let body = this.#lib.normalizeMessageContent(message.message) || {};
        // Baileys normalizes common wrappers; future-proof wrappers (such as
        // documents with captions) can still contain another message object.
        for (let depth = 0; depth < 4; depth++) {
            const inner = Object.values(body).find((value) => value && typeof value === 'object' && value.message)?.message;
            if (!inner) break;
            body = this.#lib.normalizeMessageContent(inner) || inner;
        }
        const media = [
            ['imageMessage', 'image', 'WhatsApp Images', '.jpg'],
            ['videoMessage', 'video', 'WhatsApp Video', '.mp4'],
            ['ptvMessage', 'video', 'WhatsApp Video', '.mp4'],
            ['audioMessage', 'file', 'WhatsApp Audio', '.ogg'],
            ['documentMessage', 'file', 'WhatsApp Documents', '.bin'],
            ['stickerMessage', 'image', 'WhatsApp Stickers', '.webp'],
        ].find(([key]) => body[key]);
        const content = body.extendedTextMessage || (media ? body[media[0]] : null) || {};
        const text = body.conversation || content.text || content.caption || content.fileName
            || (media ? (media[0] === 'audioMessage' && content.ptt ? '[Voice message]' : `[${media[0].replace('Message', '')}]`) : '');
        if (!text) return null;
        const attachments = [];
        let mediaError;
        if (media) {
            const [key, type, folder, extension] = media;
            const mime = content.mimetype || ({ imageMessage: 'image/jpeg', videoMessage: 'video/mp4', ptvMessage: 'video/mp4', audioMessage: 'audio/ogg', stickerMessage: 'image/webp' }[key]) || 'application/octet-stream';
            // eslint-disable-next-line no-control-regex -- strip control characters from untrusted attachment filenames
            const filename = String(content.fileName || `${hash(`${jid}/${message.key.id}`)}${extension}`).replace(/[\\/?#\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 180);
            const storedName = `${hash(`${jid}/${message.key.id}`).slice(0, 16)}-${filename}`;
            const target = path.join(this.#mediaRoot, folder, storedName);
            try {
                let size;
                try { size = (await fs.stat(target)).size; }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    // Stream with a size limit, as OpenClaw does. A failed or
                    // expired download must not swallow the message itself.
                    const stream = await this.#lib.downloadMediaMessage({ ...message, message: body }, 'stream', {}, {
                        logger: pino({ level: 'silent' }), reuploadRequest: this.#socket?.updateMediaMessage?.bind(this.#socket),
                    });
                    const chunks = []; size = 0;
                    for await (const chunk of stream) {
                        const buffer = Buffer.from(chunk); size += buffer.length;
                        if (size > 50 * 1024 * 1024) throw new Error('Attachment exceeds 50 MB');
                        chunks.push(buffer);
                    }
                    await fs.mkdir(path.dirname(target), { recursive: true });
                    const temp = `${target}.${crypto.randomUUID()}.tmp`;
                    try { await fs.writeFile(temp, Buffer.concat(chunks), { mode: 0o600 }); await fs.rename(temp, target); }
                    finally { await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
                }
                attachments.push({ type, name: filename, mimeType: mime, size, url: `stored://workspace:home/${this.#mediaPrefix}/${folder}/${storedName}` });
            } catch (error) { mediaError = 'Attachment unavailable; retry synchronization to download it again.'; this.logger.warn?.({ error: error.message }, 'WhatsApp media download failed'); }
        }
        const senderId = message.key.participant || (message.key.fromMe ? this.#socket?.user?.id || 'self' : jid);
        const contact = this.#contacts.get(senderId) || this.#contacts.get(senderId.replace(/:\d+(?=@)/, ''));
        const senderName = contact?.name || contact?.notify || contact?.verifiedName || message.pushName;
        const quoted = content.contextInfo?.stanzaId;
        return this.document({
            schema: 'data/schema/message', containerSegment: jid,
            provenanceUrl: this.provenance(this.address, jid, message.key.id),
            parentProvenanceUrl: quoted ? this.provenance(this.address, jid, quoted) : null,
            data: { text, platform: 'whatsapp', channel: { id: jid, name: this.#chats.get(jid)?.name || jid },
                sender: { id: senderId, name: senderName, username: senderName },
                attachments, ...(mediaError ? { mediaError } : {}),
                timestamp: new Date(Number(message.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
            },
            metadata: { remoteId: message.key.id, whatsappKey: message.key, outgoing: message.key.fromMe === true },
        });
    }
    async #ingest(message) {
        const jid = message.key?.remoteJid;
        if (!message.key?.id || !jid || jid.endsWith('@broadcast')) return;
        await fs.writeFile(this.#messageFile(message.key), JSON.stringify(message, this.#lib.BufferJSON.replacer), { mode: 0o600 });
        if (this.#stopped || !this.#selected(jid)) return;
        const document = await this.#toDocument(message);
        if (document) await this.#onDocument({ id: jid, name: this.#chats.get(jid)?.name || jid }, document);
    }

    async prepareMessage(input, parent) {
        if (!this.canWrite || this.config.sendEnabled !== true) throw new Error('Sending is disabled for this WhatsApp account');
        await this.#start();
        if (this.#state !== 'connected') throw new Error('WhatsApp is disconnected; reconnect before sending');
        const target = parent?.data?.channel?.id || input.target;
        if (!this.#selected(target)) throw new Error('Select a configured WhatsApp conversation');
        const quoted = parent ? await this.#readMessage(parent.metadata?.whatsappKey || {}) : undefined;
        if (parent && !quoted) throw new Error('The original WhatsApp message is unavailable for quoting');
        const pictures = messageImages(input.images);
        if (pictures.length && input.text.length > 1024) throw new Error('WhatsApp picture captions must be at most 1,024 characters');
        if (pictures.length > 1) throw new Error('WhatsApp supports one picture per message');
        return { target, quoted, text: input.text, picture: pictures[0] };
    }

    async sendMessage(prepared) {
        const message = await this.#socket.sendMessage(prepared.target, prepared.picture ? { image: prepared.picture.content, caption: prepared.text, mimetype: prepared.picture.contentType } : { text: prepared.text }, { quoted: prepared.quoted });
        if (!message?.key?.id) throw new Error('WhatsApp did not acknowledge the message');
        await fs.writeFile(this.#messageFile(message.key), JSON.stringify(message, this.#lib.BufferJSON.replacer), { mode: 0o600 }).catch(() => {});
        return { status: 'accepted', providerMessageId: message.key.id,
            document: await this.#toDocument(message), container: { id: prepared.target, name: prepared.target } };
    }
}
