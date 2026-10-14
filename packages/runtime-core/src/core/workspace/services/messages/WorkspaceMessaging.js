import { readSendReceipt } from './outbox.js';
import { emailRecipients } from './email.js';
import { sendWorkspaceMessage, sourceAccount } from './index.js';
import path from 'path';

// Workspace delegates this domain to a collaborator. Runtime dependencies stay
// private to the local host; the public Workspace API is the transport boundary.
export default class WorkspaceMessaging {
    #workspace;
    #runtime;
    constructor(workspace, runtime) { this.#workspace = workspace; this.#runtime = runtime; }


    async messagingAccounts() {
        return (await this.#workspace.listBackends()).filter((b) => ['imap', 'slack', 'whatsapp'].includes(b.driver)).map((b) => {
            const c = b.driver === 'imap' ? b.config.smtp || {} : b.config;
            return { driver: b.driver, address: b.address, enabled: b.enabled !== false,
                canSend: b.enabled !== false && (b.driver === 'imap' ? c.enabled === true && !b.config.readOnly : c.sendEnabled === true && c.readOnly === false),
                allowAgentSend: c.allowAgentSend === true, from: c.from || null };
        });
    }

    async messageSendStatus(requestId, principal) {
        return readSendReceipt(path.join(this.#workspace.varPath, 'message-outbox'), requestId, principal);
    }

    async messageReplyTarget(id) {
        const doc = await this.#workspace.get(id);
        if (!doc) throw Object.assign(new Error('Document not found'), { statusCode: 404 });
        const source = sourceAccount(doc);
        if (source?.driver === 'imap') {
            const config = await this.#runtime.integrations.mailReadonly().senderConfig(source.address).catch(() => null);
            if (config) return { ...source, recipients: emailRecipients(config.smtp.from, {}, doc),
                allRecipients: emailRecipients(config.smtp.from, { replyAll: true }, doc) };
        }
        return source;
    }

    async sendMessage(input, principal = {}) {
        return sendWorkspaceMessage(this.#workspace, this.#runtime.integrations.mailReadonly(), await this.#runtime.integrations.connectors(), input, principal);
    }

    async messageConnection(driver, address, reset = false) {
        return (await this.#runtime.integrations.connectors()).messageConnection(driver, address, reset);
    }
}
