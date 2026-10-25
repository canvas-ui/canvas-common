'use strict';

/** Turn a workspace service on and record it in workspace.json. */
export async function enableService(workspace, serviceName) {
    let result;
    switch (serviceName) {
        case 'git':
            result = await workspace.dotfiles.enable();
            break;
        case 'webdav':
            await workspace.startHomeService();
            result = true;
            break;
        case 'imapSync':
            result = await workspace.enableImap();
            break;
        default:
            throw new Error(`Unknown service: ${serviceName}`);
    }
    workspace.setServiceConfig(serviceName, { enabled: true });
    return result;
}

/** Turn a workspace service off and record it in workspace.json. */
export async function disableService(workspace, serviceName) {
    let result;
    switch (serviceName) {
        case 'git':
            result = { success: true };
            break;
        case 'webdav':
            await workspace.stopHomeService();
            result = true;
            break;
        case 'imapSync':
            result = await workspace.disableImap();
            break;
        default:
            throw new Error(`Unknown service: ${serviceName}`);
    }
    workspace.setServiceConfig(serviceName, { enabled: false });
    return result;
}

export async function getServicesStatus(workspace) {
    const config = workspace.services;
    const imapStatus = await workspace.getImapStatus();
    return {
        git: { ...config.git, initialized: workspace.dotfiles.enabled },
        webdav: { ...config.webdav, initialized: config.webdav?.enabled === true },
        imapSync: { ...config.imapSync, ...imapStatus },
    };
}
