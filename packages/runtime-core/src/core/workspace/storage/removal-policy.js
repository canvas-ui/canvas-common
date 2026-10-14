const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

export const backendIdentity = config => JSON.stringify([config?.driver, config?.root, config?.device?.id,
    config?.folderId, config?.bucket, config?.prefix, config?.account, config?.host, config?.port, config?.user, config?.endpoint]);

// Permissions remain independent: accepting a propagated deletion never grants
// write access, and a writable archive may still refuse propagated deletions.
export function normalizeRemovalPolicy(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('removalPolicy must be an object');
    const membership = value.membership ?? 'keep';
    const propagation = value.propagation ?? 'never';
    const targets = value.targets ?? [];
    if (!['keep', 'review', 'trash'].includes(membership)) throw invalid('Invalid missing-item membership policy');
    if (!['never', 'review', 'automatic'].includes(propagation)) throw invalid('Invalid deletion propagation policy');
    if (targets !== 'all' && (!Array.isArray(targets) || targets.some(t => typeof t !== 'string' || !t.trim()) || targets.length > 200)) {
        throw invalid('Deletion targets must be an array of backend names or all');
    }
    if ('acceptPropagatedDeletions' in value && typeof value.acceptPropagatedDeletions !== 'boolean') throw invalid('acceptPropagatedDeletions must be a boolean');
    return { membership, propagation, targets: targets === 'all' ? 'all' : [...new Set(targets)], acceptPropagatedDeletions: value.acceptPropagatedDeletions === true };
}
