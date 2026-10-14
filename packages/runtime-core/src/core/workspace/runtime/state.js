import { WORKSPACE_STATUS_CODES } from '../configuration/constants.js';

export function createWorkspaceState() {
    return {
        crypto: null,
        withoutSecrets: false,
        protectionPromise: null,
        rootPath: null,
        configStore: null,
        logger: null,
        db: null,
        storedIndex: null,
        servicesStartPromise: null,
        storagePolicyService: null,
        trashOperations: null,
        mailIndex: null,
        mailRuntimeBinding: null,
        connectorIndex: null,
        connectorRuntimeBinding: null,
        tokens: null,
        members: null,
        status: WORKSPACE_STATUS_CODES.INACTIVE,
        startPromise: null,
        runtimeListeners: [],
        sessions: new Set(),
        configuredInferd: null,
        inferd: null,
        embedEligibilityPending: new Set(),
        inferdRegistered: false,
        embedStoreCount: 0
    };
}
