/** Scoped reads must never fall through to a provider that ignores scope options. */
export function requireQueryScope(db, scope) {
    if (scope && db.queryScopeVersion !== 1) {
        throw Object.assign(new Error('Scoped queries require the matching Synapsd runtime. Upgrade the server and Synapsd together.'), { statusCode: 503 });
    }
    return db;
}
