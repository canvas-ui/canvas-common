# Workspace Git repositories

Repositories live in `Git/<name>/.git`. The home layout uses `.workspace/Git`; a configured `services.git.root` still overrides the repository container. `internal` holds hooks, scripts and dotfiles. On startup the old `git/bare.git` layout is copied into `Git/internal`, preserving refs and uncommitted hooks; the original remains a recovery copy. Native Git worktrees with a `.git` pointer file are not discovered.

In Settings → Data Backends → Connectors, choose **Git repository**. Enter a repository name and an HTTPS or SSH URL to clone a remote, or leave the URL empty to create a local repository. Private remotes use the runtime user's Git credential helper or SSH configuration. A sync fetches origin without resetting the checkout or changing local files. Branches follow origin when the local tip is behind it; local-ahead and diverged commits remain visible. Local-only branches are also available. Commit local changes before expecting them in a branch tree. Submodules and symbolic links are not traversed.

Every repository is mirrored under `Backends → Workspace → Git → Repository → Branch → Folders`. Git path segments use reversible byte escapes to avoid the virtual tree’s punctuation and case normalization. Branch names with slashes stay in a single node; original names are displayed as labels. File/folder case is preserved. Existing repositories are discovered on workspace startup and when the backends list refreshes; repositories added through the API appear immediately. Stopping a Git source keeps its checkout and disables polling until resumed.

The same connector form can follow a branch or folder into a virtual tree. For example, branch `jira-1234/myusername-int-qf-for-jetson-board-krnl-parm` can target `context:/Work/customer-foo/devops/jira-1234`. Branch `main`, source folder `docs/UI`, can target `context:/company/Branding/UI`. New committed files follow the mapping during sync. Changing or removing a mapping leaves existing curated placements intact. Deleted source files lose their backend placement; filed documents are retained as orphans. Pull-request integration is out of scope.

## API

- `GET /workspaces/:id/git/`: list local and remote repositories.
- `POST /workspaces/:id/git/`: create a repository/backend with `{ "address": "company", "url": "https://example.com/company.git" }`; omit `url` for a local repository.
- `GET /workspaces/:id/git/:repo/branches`: branch descriptors.
- `/workspaces/:id/git/:repo`: smart HTTP clone/fetch/push endpoint. Push is available for local repositories; remote clones are read-only through this endpoint, with pushes going to their origin.
- `/workspaces/:id/git` remains an alias for `internal` for older clients.
- Standard `/workspaces/:id/backends/git/:repo` CRUD (DELETE stops syncing and preserves the checkout), `/sync`, `/test` and `/containers` manage the Git data source.

A backend supports `branches: ["main", "feature/name"]` (empty means all). The form's `linkBranch`, `linkPath`, `targetTree` and `targetPath` create one mapping. API clients can additionally supply `mounts: [{ "branch": "main", "sourcePath": "docs/UI", "tree": "context", "path": "/company/Branding/UI" }]` for multiple mappings.

## Indexing boundary

Discovery reads refs and tree metadata, never file blobs. A document's identity is repository + branch + exact path, so equal files on separate branches remain independently linkable. Git blob IDs detect changed files; unchanged files are not reingested on every commit. Content resolution reads the indexed blob snapshot on demand.

Backend-only documents are excluded from live embedding enqueue, reconciliation, and embedding-input resolution. Filing a source into a non-root context or a virtual directory makes it eligible. User-authored documents at the context root retain their existing indexing behavior. File extraction is deferred from storage discovery until this eligibility check passes. Removing all curated memberships blocks subsequent embedding/extraction. Existing vectors and previously extracted metadata are not erased by this change.
