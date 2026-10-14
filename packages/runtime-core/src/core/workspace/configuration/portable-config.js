// Server bindings belong in the per-user workspace index. They must not travel
// with a folder or be restored over the destination server's runtime state.
export const WORKSPACE_RUNTIME_FIELDS = [
    'rootPath', 'configPath', 'host', 'reference', 'owner',
    'origin', 'importedFrom', 'lastScannedAt', 'remote',
];

export function portableWorkspaceConfig(config) {
    const portable = { ...config };
    for (const field of WORKSPACE_RUNTIME_FIELDS) delete portable[field];
    return portable;
}

export function validateImportPresentation({ name, label } = {}) {
    if (name !== undefined && (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))) {
        throw Object.assign(new Error('Workspace name must start with a letter or number and contain only letters, numbers, _ or -'), { statusCode: 400 });
    }
    if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
        throw Object.assign(new Error('Workspace label must not be empty'), { statusCode: 400 });
    }
    return { ...(name !== undefined ? { name: name.toLowerCase() } : {}), ...(label !== undefined ? { label: label.trim() } : {}) };
}
