'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';

export const AGENT_RUNTIME_FILES = {
    context: 'AGENTS.md',
    system: 'SYSTEM.md',
    appendSystem: 'APPEND_SYSTEM.md',
    memory: 'MEMORY.md',
    skillsDir: 'skills',
    skillFile: 'SKILL.md',
};

// Server-managed skill materialized for bound agents (see setAccess). Kept out
// of user config on read-back — it follows the binding, not the skills list.
export const CANVAS_SKILL_NAME = 'canvas-tools';

const CANVAS_SKILL = {
    name: CANVAS_SKILL_NAME,
    description: 'How to query and manage user data in canvas via the canvas_* tools',
    content: [
        '# Canvas tools',
        '',
        'You are bound to a canvas workspace scope. Canvas indexes the user\'s data',
        '(emails, notes, browser tabs, files, ...) as documents in a context tree.',
        'Filing and path-management inputs are RELATIVE to your scope; native query',
        'selectors and tree_paths results are workspace-absolute. Your token bounds access.',
        '',
        '## Tree semantics',
        '- Context trees: each node is a bitmap. /foo/bar/baz selects foo AND bar AND baz. Linking there ticks all three nodes, so shorter paths include the document too. This is context membership, not a record of where a document was explicitly filed.',
        '- Directory trees: each folder owns its membership. A folder query selects that exact folder; recursive: true includes descendants by OR-ing their memberships.',
        '- canvas_tree_list reports context or directory types. Tree/path tools accept treeNameOrId; omitted means the default context tree. Native document queries use context or directory selectors.',
        '',
        '## Tools',
        '- `canvas_context` — inspect scope and effective permissions. Without write permission, canvas_doc_insert and canvas_link are not available.',
        '- `canvas_schema { "schema": "link" }` — required/optional fields, JSON Schema, examples and server normalization rules.',
        '- `canvas_doc_find` — search/list documents. takes { spec } with the complete native query. spec paths are workspace-absolute; your token scope is independently intersected. Use feature buckets, timeline filters, exact match, relation filters and server pagination/counts.',
        '- `canvas_doc_get_by_id` — fetch one document by id.',
        '- `canvas_doc_insert` — insert a document `{ schema, data }` at an optional path. Returns `{ id, created, status, schema, path }`; created is false on a checksum match. Changed data can create another document.',
        '- `canvas_link { "docIds": [113655, 113656], "path": "/music", "createPath": true }` — attach existing accessible documents without modifying their content or versions. Returns linked IDs; requires write permission.',
        '- `canvas_doc_get_by_hash { algorithm, hash }` — checksum lookup within your scope.',
        '- `canvas_doc_update { docId, changes }` — update a known document; changes.data replaces the whole data object. Read it first. Other omitted fields are preserved.',
        '- `canvas_unlink { docIds, path }` — untick context membership; shared context layers affect every path using that layer.',
        '- `canvas_doc_content`, `canvas_doc_download`, `canvas_doc_locations` — retrieve content, fetch a linked resource, inspect available copies.',
        '- `canvas_doc_copy_to_backend`, `canvas_doc_move_to_backend` — physical transfers using native backend operations.',
        '- `canvas_features` — discover valid bitmap keys and counts within your token scope.',
        '- `canvas_tree_list`, `canvas_tree_get`, `canvas_tree_paths` — discover trees, structure and absolute paths.',
        '- `canvas_path_insert { path, treeNameOrId? }` — create folder paths and missing ancestors. Optional type: canvas, querySpec and metadata create saved canvases.',
        '- `canvas_path_get/update/move/copy/remove` — manage folders using native context/directory semantics; copy does not duplicate document content or bytes.',
        '- `canvas_tree_create/rename/remove` and `canvas_layer_list/get/update/rename/remove/lock/unlock/merge/subtract` — workspace-wide tree and shared-layer management.',
        '- `canvas_path_merge_down/subtract_down` — modify shared ancestor bitmaps. Context membership does not record an original filing path.',
        '- Subtree bindings can create folders and move/copy to existing parents inside the binding, but cannot rename or edit shared layers or change the binding root. Workspace-wide operations are hidden.',
        '- `canvas_notify` — send a notification to your user over their configured channel (WhatsApp/Slack).',
        '',
        '## Common schemas',
        '- `data/schema/message/email` — ingested emails (data.subject, data.from, data.to, data.bodyPreview); use `canvas_doc_get_by_id` to read the full message.',
        '- `data/schema/note` — notes (data.title, data.content)',
        '- `data/schema/tab` — browser tabs (data.url, data.title)',
        '- `data/schema/link` — saved links (required data.uri; optional data.label, data.tags; data.scheme is derived from uri)',
        '- `data/schema/file` — indexed files',
        '- `data/schema/task` — todo items: title; optional description, status, dueDate, priority (1 highest to 9 lowest). status defaults to pending; completed is synchronized with status.',
        '- Task dueDate accepts an ISO timestamp with timezone or YYYY-MM-DD. Date-only values become 23:59:59.999 in the workspace runtime timezone (TZ/system), stored in UTC. The server derives timelines: [{timeline: "tasks", start}] from dueDate; callers need not supply it.',
        '- `data/schema/event` — calendar / alert / activity (data.title, data.start, data.end; leaf is the schema id)',
        '',
        '## Examples',
        '- "Any new emails?" → `canvas_doc_find { "spec": { "features": { "allOf": ["data/schema/message/email"] }, "sortBy": "content", "order": "desc", "limit": 10 } }`',
        '- "Emails about ticket X" → `canvas_doc_find { "spec": { "features": { "allOf": ["data/schema/message/email"] }, "query": "ticket X", "match": "exact" } }`',
        '- "Leave me a note" → `canvas_doc_insert { "schema": "note", "data": { "title": "Meeting", "content": "..." } }`',
        '- "File this link" → `canvas_doc_insert { "schema": "link", "data": { "uri": "https://example.com", "label": "Example", "tags": ["music"] }, "path": "/music", "createPath": true }`',
        '- Missing destination paths are created by default. Set createPath: false to require an existing path (404 and no insertion if missing). Inserts never silently fall back to root.',
        '',
        'Use the installed Canvas tools. A shell CLI or runtime/canvas.env is not guaranteed to be installed.',
    ].join('\n'),
};

function getRuntimePath(rootPath) {
    return path.join(rootPath, 'home', '.pi');
}

function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function formatMarkdown(value) {
    const content = normalizeText(value);
    return content ? `${content}\n` : '';
}

function quoteFrontmatter(value) {
    return JSON.stringify(String(value ?? ''));
}

export function sanitizeSkillName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
}

async function readOptionalFile(filePath) {
    try {
        return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function syncOptionalFile(filePath, value) {
    const content = formatMarkdown(value);
    if (!content) {
        if (existsSync(filePath)) await fsPromises.rm(filePath, { force: true });
        return;
    }
    await fsPromises.writeFile(filePath, content);
}

export function parseSkillMarkdown(raw, fallbackName) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
        return {
            name: fallbackName,
            description: '',
            content: trimmed,
            disableModelInvocation: false,
        };
    }

    const fields = {};
    for (const line of match[1].split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        fields[key] = value;
    }

    return {
        name: sanitizeSkillName(fields.name || fallbackName) || fallbackName,
        description: fields.description || '',
        content: match[2].trim(),
        disableModelInvocation: fields['disable-model-invocation'] === 'true',
    };
}

function buildSkillMarkdown(skill) {
    const name = sanitizeSkillName(skill?.name);
    if (!name) return null;

    const description = normalizeText(skill?.description) || `${name} skill`;
    const content = normalizeText(skill?.content) || `# ${name}`;
    const lines = [
        '---',
        `name: ${quoteFrontmatter(name)}`,
        `description: ${quoteFrontmatter(description)}`,
    ];

    if (skill?.disableModelInvocation) {
        lines.push('disable-model-invocation: true');
    }

    lines.push('---', '', content);
    return `${lines.join('\n')}\n`;
}

async function readSkills(rootPath) {
    let skillsPath = path.join(getRuntimePath(rootPath), AGENT_RUNTIME_FILES.skillsDir);
    if (!existsSync(skillsPath) && !existsSync(path.join(getRuntimePath(rootPath), '.canvas-migrated'))) {
        skillsPath = path.join(rootPath, 'runtime', AGENT_RUNTIME_FILES.skillsDir);
    }
    if (!existsSync(skillsPath)) return null;

    const entries = await fsPromises.readdir(skillsPath, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(skillsPath, entry.name, AGENT_RUNTIME_FILES.skillFile);
        const raw = await readOptionalFile(skillPath);
        if (!raw) continue;
        skills.push(parseSkillMarkdown(raw, entry.name));
    }

    return skills;
}

async function syncSkills(rootPath, skills) {
    const skillsPath = path.join(getRuntimePath(rootPath), AGENT_RUNTIME_FILES.skillsDir);
    if (!Array.isArray(skills) || skills.length === 0) {
        if (existsSync(skillsPath)) await fsPromises.rm(skillsPath, { recursive: true, force: true });
        return;
    }

    await fsPromises.mkdir(skillsPath, { recursive: true });
    const nextNames = new Set();

    for (const skill of skills) {
        const name = sanitizeSkillName(skill?.name);
        const markdown = buildSkillMarkdown({ ...skill, name });
        if (!name || !markdown) continue;

        nextNames.add(name);
        const dirPath = path.join(skillsPath, name);
        await fsPromises.mkdir(dirPath, { recursive: true });
        await fsPromises.writeFile(path.join(dirPath, AGENT_RUNTIME_FILES.skillFile), markdown);
    }

    const entries = await fsPromises.readdir(skillsPath, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || nextNames.has(entry.name)) continue;
        await fsPromises.rm(path.join(skillsPath, entry.name), { recursive: true, force: true });
    }
}

export async function loadAgentRuntimeConfig(rootPath, config) {
    const runtimePath = getRuntimePath(rootPath);
    const migrated = existsSync(path.join(runtimePath, '.canvas-migrated'));
    const instruction = async (name) => await readOptionalFile(path.join(runtimePath, name))
        ?? (migrated ? null : await readOptionalFile(path.join(rootPath, 'runtime', name)));
    const baseConfig = config?.config || {};
    const prompts = { ...(baseConfig.prompts || {}) };

    const [systemPrompt, appendSystemPrompt, contextPrompt, memory, skills] = await Promise.all([
        instruction(AGENT_RUNTIME_FILES.system),
        instruction(AGENT_RUNTIME_FILES.appendSystem),
        instruction(AGENT_RUNTIME_FILES.context),
        instruction(AGENT_RUNTIME_FILES.memory),
        readSkills(rootPath),
    ]);

    if (systemPrompt !== null) prompts.system = systemPrompt.trim();
    if (appendSystemPrompt !== null) prompts.append = appendSystemPrompt.trim();
    if (contextPrompt !== null) prompts.context = contextPrompt.trim();

    // The canvas skill is server-managed (materialized from the binding); keep
    // it out of user config so it never duplicates or outlives the binding.
    const userSkills = skills !== null
        ? skills.filter((skill) => skill?.name !== CANVAS_SKILL_NAME)
        : null;

    return {
        ...config,
        config: {
            ...baseConfig,
            prompts,
            ...(memory !== null ? { memory: memory.trim() } : {}),
            ...(userSkills !== null ? { skills: userSkills } : {}),
        },
    };
}

export async function materializeAgentRuntimeFiles(rootPath, config) {
    const runtimePath = getRuntimePath(rootPath);
    const agentConfig = config?.config || {};
    const prompts = agentConfig.prompts || {};

    await fsPromises.mkdir(runtimePath, { recursive: true });
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.system), prompts.system);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.appendSystem), prompts.append);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.context), prompts.context);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.memory), agentConfig.memory);

    // Bound agents get the server-managed canvas skill alongside user skills.
    const skills = [
        ...(agentConfig.skills || []).filter((skill) => skill?.name !== CANVAS_SKILL_NAME),
        ...(config?.access ? [CANVAS_SKILL] : []),
    ];
    await syncSkills(rootPath, skills);
}

// Copy legacy resources once, preserving any files supplied by a cloned repo.
export async function migrateAgentRuntimeFiles(rootPath) {
    const destination = getRuntimePath(rootPath);
    const marker = path.join(destination, '.canvas-migrated');
    if (existsSync(marker)) return;
    await fsPromises.mkdir(destination, { recursive: true });
    for (const name of [...Object.values(AGENT_RUNTIME_FILES).filter(name => name !== 'SKILL.md'), 'settings.json']) {
        const source = path.join(rootPath, 'runtime', name);
        const target = path.join(destination, name);
        if (!existsSync(source) || existsSync(target)) continue;
        await fsPromises.cp(source, target, { recursive: true, force: false, errorOnExist: false });
    }
    await fsPromises.writeFile(marker, '1\n');
}
