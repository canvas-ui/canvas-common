/**
 * Canvas Logger - shared server logging
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import pino from 'pino';
import debugModule from 'debug';
import { env } from '../env.js';

// Diagnostic mode: retain the last message even if native code crashes or blocks.
const SYNC_LOGGING = process.env.CANVAS_LOG_SYNC === '1';
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const MAX_TAIL_LINES = 500;
const MAX_TAIL_SCAN_LINES = 5000;
const LOG_LEVEL_VALUES = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
};
const logEvents = new EventEmitter();

logEvents.setMaxListeners(0);

/**
 * Config
 */

const DEFAULT_DEBUG_NAMESPACES = 'canvas:*,stored:*,neurald:*';
const DEFAULT_LOGGING_CONFIG = {
    level: 'info',
    file: 'log/canvas-server.log',
    fileLevel: 'trace',
    console: {
        enabled: true,
        level: null,
        // 'line': one human-readable line per entry; 'json': raw pino records.
        format: 'line',
    },
    captureConsole: true,
    captureDebug: true,
    debugNamespaces: DEFAULT_DEBUG_NAMESPACES,
};

function normalizeLevel(level, fallback = 'info') {
    const normalized = String(level || fallback).toLowerCase();
    return VALID_LEVELS.has(normalized) ? normalized : fallback;
}

function resolveLogPath(filePath) {
    if (!filePath) {
        return path.join(env.server.home, DEFAULT_LOGGING_CONFIG.file);
    }

    return path.isAbsolute(filePath) ? filePath : path.join(env.server.home, filePath);
}

function loadLoggingConfig() {
    const configPath = path.join(env.server.home, 'config', 'logging.json');

    if (!fsSync.existsSync(configPath)) {
        const configDir = path.dirname(configPath);
        if (!fsSync.existsSync(configDir)) {
            fsSync.mkdirSync(configDir, { recursive: true });
        }

        fsSync.writeFileSync(configPath, `${JSON.stringify(DEFAULT_LOGGING_CONFIG, null, 2)}\n`, 'utf8');
        return { ...DEFAULT_LOGGING_CONFIG };
    }

    try {
        const parsed = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
        return {
            ...DEFAULT_LOGGING_CONFIG,
            ...parsed,
            console: {
                ...DEFAULT_LOGGING_CONFIG.console,
                ...(parsed.console || {}),
            },
        };
    } catch {
        return { ...DEFAULT_LOGGING_CONFIG };
    }
}

const loggingConfig = loadLoggingConfig();
const LOG_FILE_PATH = resolveLogPath(loggingConfig.file);
const LOG_LEVEL = normalizeLevel(process.env.LOG_LEVEL || loggingConfig.level || env.server.logLevel);
const FILE_LOG_LEVEL = normalizeLevel(loggingConfig.fileLevel, 'trace');
const CONSOLE_ENABLED = loggingConfig.console?.enabled !== false;
const CONSOLE_LOG_LEVEL = normalizeLevel(loggingConfig.console?.level || LOG_LEVEL);
const CONSOLE_FORMAT = loggingConfig.console?.format === 'json' ? 'json' : 'line';
// A workspace child tags every entry with its workspace (WorkspaceProcess sets this).
const PROCESS_WORKSPACE = process.env.CANVAS_WORKSPACE_NAME || null;

/**
 * Level helpers
 */

function stripAnsi(value) {
    // eslint-disable-next-line no-control-regex -- ESC is the point: this strips ANSI SGR codes.
    return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

function resolveDebugNamespaces() {
    if (process.env.DEBUG) {
        return process.env.DEBUG;
    }

    if (loggingConfig.captureDebug === false) {
        return null;
    }

    if (!['trace', 'debug'].includes(LOG_LEVEL)) {
        return null;
    }

    return loggingConfig.debugNamespaces ?? DEFAULT_DEBUG_NAMESPACES;
}

const DEBUG_NAMESPACES = resolveDebugNamespaces();

function getLevelValue(level) {
    if (typeof level === 'number') {
        return level;
    }

    return LOG_LEVEL_VALUES[String(level || '').toLowerCase()] ?? null;
}

function getLevelLabel(level) {
    const value = getLevelValue(level);
    if (value === null) {
        return 'unknown';
    }

    return Object.entries(LOG_LEVEL_VALUES).find(([, candidate]) => candidate === value)?.[0] || 'unknown';
}

function normalizeLineBreaks(value) {
    return String(value || '').replace(/\r\n/g, '\n');
}

function formatLogEntry(entry) {
    if (!entry) {
        return '';
    }

    if (entry.raw && !entry.data) {
        return entry.raw;
    }

    const parts = [];
    const timestamp = entry.time ? new Date(entry.time).toISOString() : null;

    if (timestamp) {
        parts.push(`[${timestamp}]`);
    }

    if (entry.levelLabel && entry.levelLabel !== 'unknown') {
        parts.push(entry.levelLabel.toUpperCase());
    }

    if (entry.module) {
        parts.push(`[${entry.module}]`);
    }

    if (entry.msg) {
        parts.push(entry.msg);
    }

    const extra = entry.data
        ? Object.fromEntries(Object.entries(entry.data).filter(([key]) => ![
            'time',
            'level',
            'module',
            'msg',
            'pid',
            'hostname',
            'service',
        ].includes(key)))
        : null;

    if (extra && Object.keys(extra).length > 0) {
        parts.push(JSON.stringify(extra));
    }

    return parts.join(' ').trim();
}

export function normalizeLogEntry(rawLine) {
    const raw = normalizeLineBreaks(rawLine).trim();
    if (!raw) {
        return null;
    }

    try {
        const data = JSON.parse(raw);
        const entry = {
            time: data.time || null,
            level: getLevelValue(data.level),
            levelLabel: getLevelLabel(data.level),
            module: data.module || data.name || data.component || null,
            msg: data.msg || data.message || '',
            data,
            raw,
        };

        return {
            ...entry,
            line: formatLogEntry(entry),
        };
    } catch {
        return {
            time: null,
            level: null,
            levelLabel: 'unknown',
            module: null,
            msg: raw,
            data: null,
            raw,
            line: raw,
        };
    }
}

function normalizeTail(tail = 200) {
    const parsed = Number.parseInt(tail, 10);
    if (!Number.isFinite(parsed)) {
        return 200;
    }

    return Math.min(Math.max(parsed, 1), MAX_TAIL_LINES);
}

function matchesLogFilter(entry, filters = {}) {
    if (!entry) {
        return false;
    }

    const levelValue = getLevelValue(filters.level);
    if (levelValue !== null) {
        if (entry.level === null || entry.level < levelValue) {
            return false;
        }
    }

    const moduleFilter = String(filters.module || '').trim().toLowerCase();
    if (moduleFilter) {
        const haystack = `${entry.module || ''} ${entry.msg || ''} ${entry.line || ''}`.toLowerCase();
        if (!haystack.includes(moduleFilter)) {
            return false;
        }
    }

    return true;
}

/**
 * Streams
 */

class BroadcastStream extends Writable {
    #buffer = '';

    _write(chunk, encoding, callback) {
        try {
            this.#buffer += chunk.toString('utf8');
            const lines = this.#buffer.split('\n');
            this.#buffer = lines.pop() || '';

            for (const line of lines) {
                const entry = normalizeLogEntry(line);
                if (entry) {
                    logEvents.emit('entry', entry);
                }
            }

            callback();
        } catch (error) {
            callback(error);
        }
    }

    _final(callback) {
        if (this.#buffer.trim()) {
            const entry = normalizeLogEntry(this.#buffer);
            if (entry) {
                logEvents.emit('entry', entry);
            }
        }

        callback();
    }
}

/**
 * Console line format:
 *   time | LEVEL | workspace | subsystem | message key=value …
 * Request lines put the request first; errors add their stack below.
 */

const workspaceNames = new Map();

/** Lets console lines name a workspace that is only referenced by id. */
export function nameWorkspaceInLogs(id, name) {
    if (id && name) { workspaceNames.set(id, name); }
}

const LINE_OMIT = new Set([
    'time', 'level', 'msg', 'module', 'name', 'service', 'pid', 'hostname',
    'workspace', 'workspaceName', 'workspaceId', 'reqId', 'req', 'res',
    'responseTime', 'method', 'url', 'statusCode', 'durationMs', 'err',
]);
const LEVEL_COLORS = { trace: 90, debug: 36, info: 32, warn: 33, error: 31, fatal: 35 };

function localTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function workspaceLabel(data) {
    const named = data.workspace || data.workspaceName;
    if (named) { return String(named); }
    if (!data.workspaceId) { return '-'; }
    return workspaceNames.get(data.workspaceId) || String(data.workspaceId).slice(0, 8);
}

function requestLabel(data) {
    const method = data.method || data.req?.method;
    const url = data.url || data.req?.url;
    if (!method && !url) { return ''; }
    const status = data.statusCode ?? data.res?.statusCode;
    const ms = data.durationMs ?? data.responseTime;
    return [data.reqId, method, url, status != null ? `→ ${status}` : null, ms != null ? `${Math.round(ms)}ms` : null]
        .filter(Boolean).join(' ');
}

function formatValue(value) {
    if (typeof value === 'string') { return /\s/.test(value) ? JSON.stringify(value) : value; }
    return JSON.stringify(value);
}

export function formatConsoleLine(data, { color = false } = {}) {
    const label = getLevelLabel(data.level);
    const level = label.toUpperCase().padEnd(5);
    const request = requestLabel(data);
    const fields = Object.entries(data)
        .filter(([key, value]) => !LINE_OMIT.has(key) && value !== undefined)
        .map(([key, value]) => `${key}=${formatValue(value)}`);
    const err = data.err;
    const message = [request, data.msg, err?.message && err.message !== data.msg ? err.message : null, ...fields]
        .filter(Boolean).join(' ');
    const line = [
        localTime(data.time),
        color ? `\u001b[${LEVEL_COLORS[label] || 0}m${level}\u001b[0m` : level,
        workspaceLabel(data),
        data.module || data.name || '-',
        message,
    ].join(' | ');
    const stack = err?.stack && getLevelValue(data.level) >= LOG_LEVEL_VALUES.error
        ? `\n${String(err.stack).split('\n').map(l => `    ${l.trim()}`).join('\n')}` : '';
    return line + stack;
}

class ConsoleLineStream extends Writable {
    #color = Boolean(process.stdout.isTTY);

    _write(chunk, encoding, callback) {
        for (const raw of chunk.toString('utf8').split('\n')) {
            if (!raw.trim()) { continue; }
            let data;
            try { data = JSON.parse(raw); } catch { process.stdout.write(`${raw}\n`); continue; }
            process.stdout.write(`${formatConsoleLine(data, { color: this.#color })}\n`);
        }
        callback();
    }
}

function buildStreams() {
    const streams = [
        { level: FILE_LOG_LEVEL, stream: new BroadcastStream() },
        { level: FILE_LOG_LEVEL, stream: pino.destination({ dest: LOG_FILE_PATH, mkdir: true, sync: SYNC_LOGGING }) },
    ];

    if (CONSOLE_ENABLED) {
        streams.push({
            level: CONSOLE_LOG_LEVEL,
            stream: CONSOLE_FORMAT === 'line'
                ? new ConsoleLineStream()
                : pino.destination({ dest: 1, sync: SYNC_LOGGING }),
        });
    }

    return streams;
}

export const logger = pino({
    name: 'canvas-server',
    base: {
        service: 'canvas-server',
        ...(PROCESS_WORKSPACE ? { workspace: PROCESS_WORKSPACE } : {}),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    level: LOG_LEVEL,
    redact: {
        paths: [
            'authorization',
            'cookie',
            'password',
            'passwordHash',
            'token',
            'apiToken',
            'accessToken',
            'refreshToken',
            'resetToken',
            'verificationToken',
            'headers.authorization',
            'headers.cookie',
            'req.headers.authorization',
            'req.headers.cookie',
            'request.headers.authorization',
            'request.headers.cookie',
            'auth.pass',
            'smtpConfig.auth.pass',
        ],
        censor: '[REDACTED]',
    },
}, pino.multistream(buildStreams()));

/**
 * Console capture
 */

function serializeConsoleArg(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (typeof value === 'object' && value !== null) {
        return value;
    }

    return String(value);
}

function writeConsoleLog(level, args) {
    const consoleLogger = logger.child({ module: 'console' });
    const writer = (consoleLogger[level] || consoleLogger.info).bind(consoleLogger);

    if (!args.length) {
        writer('');
        return;
    }

    if (typeof args[0] === 'string') {
        const rest = args.slice(1);
        if (!rest.length) {
            writer(args[0]);
            return;
        }

        const objects = rest.filter((item) => typeof item === 'object' && item !== null);
        if (objects.length === rest.length && objects.length === 1) {
            writer(objects[0], args[0]);
            return;
        }

        writer({ detail: rest.map(serializeConsoleArg) }, args[0]);
        return;
    }

    writer({ detail: args.map(serializeConsoleArg) }, 'console output');
}

function patchConsole() {
    if (loggingConfig.captureConsole === false) {
        return;
    }

    const methods = {
        log: 'info',
        info: 'info',
        debug: 'debug',
        warn: 'warn',
        error: 'error',
    };

    for (const [method, level] of Object.entries(methods)) {
        console[method] = (...args) => writeConsoleLog(level, args);
    }
}

patchConsole();
patchDebug();

/**
 * debug module capture
 */

function patchDebug() {
    if (loggingConfig.captureDebug === false || !DEBUG_NAMESPACES) {
        return;
    }

    if (!process.env.DEBUG) {
        debugModule.enable(DEBUG_NAMESPACES);
    }

    if (!process.env.DEBUG_COLORS) {
        process.env.DEBUG_COLORS = 'no';
    }

    debugModule.formatArgs = function (_args) {
        // pino adds timestamp + module; keep the raw debug message only
    };

    debugModule.log = function (...args) {
        const namespace = this?.namespace || 'debug';
        const msg = args.map((arg) => stripAnsi(arg)).join(' ').trim();
        const debugLogger = logger.child({ module: namespace });
        const writer = debugLogger.debug.bind(debugLogger);

        if (this?.diff != null) {
            writer({ ms: this.diff }, msg);
            return;
        }

        writer(msg);
    };
}

/**
 * Public API
 */

export function createLogger(name) {
    return name ? logger.child({ module: name }) : logger;
}

export function getLogFilePath() {
    return LOG_FILE_PATH;
}

export function getLogLevel() {
    return LOG_LEVEL;
}

export function getLoggingConfig() {
    return {
        level: LOG_LEVEL,
        file: LOG_FILE_PATH,
        fileLevel: FILE_LOG_LEVEL,
        console: {
            enabled: CONSOLE_ENABLED,
            level: CONSOLE_LOG_LEVEL,
            format: CONSOLE_FORMAT,
        },
        captureConsole: loggingConfig.captureConsole !== false,
        captureDebug: loggingConfig.captureDebug !== false,
        debugNamespaces: DEBUG_NAMESPACES,
    };
}

export function subscribeToLogs(listener, filters = {}) {
    const handler = (entry) => {
        if (matchesLogFilter(entry, filters)) {
            listener(entry);
        }
    };

    logEvents.on('entry', handler);

    return () => {
        logEvents.off('entry', handler);
    };
}

async function readTailLines(maxLines) {
    try {
        const file = await fs.open(LOG_FILE_PATH, 'r');

        try {
            const stats = await file.stat();
            if (!stats.size) {
                return [];
            }

            let position = stats.size;
            let chunkSize = 64 * 1024;
            let content = '';
            let newlineCount = 0;

            while (position > 0 && newlineCount <= maxLines) {
                const size = Math.min(chunkSize, position);
                position -= size;

                const buffer = Buffer.alloc(size);
                await file.read(buffer, 0, size, position);

                content = buffer.toString('utf8') + content;
                newlineCount = content.split('\n').length - 1;
                chunkSize = Math.min(chunkSize * 2, 512 * 1024);
            }

            return content
                .split(/\r?\n/)
                .map((line) => line.trimEnd())
                .filter(Boolean)
                .slice(-maxLines);
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

export async function readRecentLogs(filters = {}) {
    const tail = normalizeTail(filters.tail);
    const scanLines = Math.min(Math.max(tail * 10, tail), MAX_TAIL_SCAN_LINES);
    const lines = await readTailLines(scanLines);

    return lines
        .map(normalizeLogEntry)
        .filter((entry) => matchesLogFilter(entry, filters))
        .slice(-tail);
}

export const createDebug = createLogger;

export default logger;
