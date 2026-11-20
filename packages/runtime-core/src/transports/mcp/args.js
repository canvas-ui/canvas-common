/**
 * Argument names shared by route `config.mcp` declarations, keyed by the REST
 * parameter they rename (path parameters as written in the URL). Spread the
 * ones a route uses into `args` so the same thing is called the same in every
 * tool.
 */
export const workspace = { ':id': { name: 'workspace', description: 'Workspace name or id, as returned by workspace_list.' } };

/** One backend of a workspace, as backend_list names it. */
export const backend = {
    ':driver': { description: 'The backend\'s driver from backend_list, e.g. file, cacache, s3, gdrive, share, imap.' },
    ':address': { description: 'The backend\'s address from backend_list.' },
};

export const tree = { ':treeNameOrTreeId': { name: 'tree', description: 'Tree name or id from tree_list. Omit for the default context tree.' } };

export const treePath = { '*': { name: 'path', description: 'Absolute path in the tree, e.g. /work/projects.' } };

export const document = { ':docId': { name: 'documentId', type: 'integer', description: 'Numeric document id.' } };

/** The tree selection shared by document listing and filing routes. */
export const documentPath = {
    context: { name: 'path', description: 'Absolute tree path, e.g. /work/projects. In a context tree /a/b selects documents in both a and b.' },
    treeNameOrTreeId: { name: 'tree', description: 'Tree name or id from tree_list. Omit for a default tree; see treeType.' },
    treeType: { description: 'Only when tree is omitted: directory selects the default directory tree (folders with exact membership) instead of the default context tree.' },
};
