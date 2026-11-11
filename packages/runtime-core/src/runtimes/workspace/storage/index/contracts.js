import path from 'path';

export const HOME_STORED_BACKEND = 'workspace:home';

export const DATA_BLOB_BACKEND = 'workspace:data';

export const STORED_DRIVERS = new Set(['file', 'cacache', 'gdrive', 's3']);

export const LOCAL_DRIVERS = new Set(['file', 'cacache']);

export const CONTAINER_DRIVERS = new Set(['file', 'gdrive']);

export const REMOTE_RESTART_KEYS = ['clientId', 'clientSecret', 'refreshToken', 'folderId', 'pollInterval', 'permanentDelete', 'bucket', 'prefix', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'forcePathStyle', 'readOnly'];

export const CHECKSUM_PRIORITY = ['sha256', 'sha1', 'md5'];

export const ORPHANED_FEATURE = 'feature/orphaned';

export const NUDGE_THROTTLE_MS = 300;

// How long deleted and overwritten data stays recoverable: the Trash of every
// file backend, trashed documents and displaced file versions. At least one
// day; there is no setting that turns the Trash off.
export const TRASH_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.CANVAS_TRASH_RETENTION_DAYS ?? '', 10) || 30);

export const UPSERT_WAIT_MS = 10000;

export function objectsError(message, code, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

export function normalizeObjectKey(key) {
    let out = String(key ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
    out = out.normalize('NFC');
    if (!out || out.includes('\0')) return null;
    if (path.isAbsolute(out) || /^[a-zA-Z]:\//.test(out)) return null;
    if (!out.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..')) return null;
    return out;
}
