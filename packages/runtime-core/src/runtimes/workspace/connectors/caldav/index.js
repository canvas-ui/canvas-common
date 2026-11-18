'use strict';

/**
 * Generic CalDAV driver — any RFC 4791 endpoint (GroupOffice, Nextcloud,
 * Radicale, SOGo, …). One backend per account (address = account label).
 *
 * Config: `url` (calendar-home or a single calendar collection), `username`,
 * `password` (basic auth), optional `calendars` (collection names to sync,
 * each optionally renamed in Canvas as `<name> = <calendar name>`, see
 * calendar-names.js; empty = every calendar found, named by its DAV display
 * name), `readOnly` (default TRUE — set false to enable write-back),
 * `initialSyncDays`.
 *
 * Sync: RFC 6578 sync-collection REPORT with the server's sync-token as the
 * cursor (changed hrefs → calendar-multiget for the ICS payloads). An invalid
 * token (DAV 403/409/507 responses vary — anything non-207) falls back to a
 * full calendar-query REPORT over the initialSyncDays window, then re-arms
 * the token. Servers without sync-token just re-run the window query each
 * poll — the identity-checksum upsert makes that harmless.
 *
 * Components: VEVENT syncs as an event, VTODO as a task. A collection that
 * declares its supported-calendar-component-set is only asked for those.
 *
 * Write-back (only when readOnly === false): `createDocument` PUTs a new
 * VEVENT or VTODO (If-None-Match: * so it can never overwrite),
 * `updateDocument` rewrites the changed properties of the existing resource
 * (If-Match on its ETag, every other property kept), `deleteDocument` removes
 * the resource.
 *
 * ICS parsing is a deliberate minimal built-in (unfold + master component
 * properties) — no new dependencies, mirroring the other drivers' plain-fetch
 * stance. Recurrence overrides (RECURRENCE-ID) are skipped in v1; the master
 * VEVENT carries the RRULE and synapsd ≥3.4 expands multi-position timelines
 * from it.
 */

import BaseConnector from '../BaseConnector.js';
import { parseCalendarList } from '../calendar-names.js';
import { changedFields } from '../patch.js';

const DAV_NS_HINT = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

// Document kind (BaseConnector.creates) ↔ iCalendar component.
const COMPONENT_OF = { event: 'VEVENT', task: 'VTODO' };
const COMPONENTS = Object.values(COMPONENT_OF);

// Task status ↔ VTODO STATUS (RFC 5545 §3.8.1.11).
const TASK_STATUS = { 'NEEDS-ACTION': 'pending', 'IN-PROCESS': 'in-progress', 'COMPLETED': 'completed', 'CANCELLED': 'cancelled' };
const VTODO_STATUS = Object.fromEntries(Object.entries(TASK_STATUS).map(([ics, status]) => [status, ics]));

export default class CaldavConnector extends BaseConnector {
    static driver = 'caldav';
    static label = 'CalDAV';
    static icon = 'mdi:calendar-sync';
    static blurb = 'Any RFC 4791 calendar server — Nextcloud, Radicale, SOGo, GroupOffice.';
    static provenanceScheme = 'caldav';
    static supports = { prune: false, create: true, update: true, delete: true };
    static creates = ['event', 'task'];

    static configFields = [
        { key: 'address', label: 'Account label', placeholder: 'nextcloud', required: true },
        { key: 'url', label: 'CalDAV URL (calendar home or one calendar)', placeholder: 'https://host/caldav/user', required: true },
        { key: 'username', label: 'Username' },
        { key: 'password', label: 'Password', secret: true },
        { key: 'calendars', label: 'Calendar names (one per line, blank = all; "<name> = <calendar name>" names the calendar in Canvas)', list: true },
        { key: 'writeBack', label: 'Allow Canvas to create, edit and delete events and tasks', type: 'boolean' },
    ];




    #base() {
        const url = String(this.config.url || '').trim();
        if (!url) throw new Error('caldav backend requires a url');
        return url.replace(/\/+$/, '');
    }

    #origin() { return new URL(this.#base()).origin; }

    #headers(extra = {}) {
        const headers = { ...extra };
        if (this.config.username) {
            headers['Authorization'] = 'Basic ' +
                Buffer.from(`${this.config.username}:${this.config.password || ''}`).toString('base64');
        }
        return headers;
    }

    async #dav(method, url, { depth, body, headers = {} } = {}) {
        const res = await fetch(url, {
            method,
            headers: this.#headers({
                'Content-Type': 'application/xml; charset=utf-8',
                ...(depth !== undefined ? { 'Depth': String(depth) } : {}),
                ...headers,
            }),
            body,
        });
        const text = await res.text().catch(() => '');
        return { status: res.status, ok: res.status >= 200 && res.status < 300 || res.status === 207, text, headers: res.headers };
    }

    async test() {
        const { status } = await this.#dav('PROPFIND', this.#base(), {
            depth: 0,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:resourcetype/></d:prop></d:propfind>`,
        });
        if (status === 401 || status === 403) throw new Error(`caldav auth failed (${status})`);
        if (status !== 207) throw new Error(`caldav endpoint did not answer PROPFIND (${status})`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Discovery
    // ─────────────────────────────────────────────────────────────────────────

    async listContainers() {
        const base = this.#base();
        const { status, text } = await this.#dav('PROPFIND', base, {
            depth: 1,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
        });
        if (status !== 207) throw new Error(`caldav PROPFIND failed (${status})`);

        const calendars = [];
        for (const response of this.#responses(text)) {
            if (!/<[^>]*\bcalendar\b[^>]*\/>/i.test(response.propXml) &&
                !/<[^:>]*:calendar\s*\/>/i.test(response.propXml)) continue;
            const name = decodeURIComponent(response.href.replace(/\/+$/, '').split('/').pop() || '');
            calendars.push({
                id: name,
                name: this.#tagText(response.propXml, 'displayname') || name,
                href: new URL(response.href, this.#origin()).toString(),
                writable: this.canWrite,
                ...this.#componentSet(response.propXml),
            });
        }

        // The configured url may itself BE a calendar collection (no children
        // matched) — treat it as the single container.
        if (calendars.length === 0) {
            const name = decodeURIComponent(base.replace(/\/+$/, '').split('/').pop() || 'calendar');
            calendars.push({ id: name, name, href: `${base}/`, writable: this.canWrite, ...this.#componentSet('') });
        }

        // `calendar` is the calendar's name in Canvas (data.calendar → its own
        // timeline): the configured name, else the DAV display name.
        const wanted = parseCalendarList(this.config.calendars);
        const selected = wanted.length
            ? calendars.filter((c) => wanted.some((w) => w.id === c.id || w.id === c.name))
            : calendars;
        return selected.map((c) => ({
            ...c,
            calendar: wanted.find((w) => w.id === c.id || w.id === c.name)?.calendar || c.name,
        }));
    }

    // The components a collection holds, and the document kinds that follow.
    // A collection that declares no set accepts every component (RFC 4791
    // §5.2.3); `declared` records whether the server said so itself.
    #componentSet(propXml) {
        const set = this.#tagText(propXml, 'supported-calendar-component-set') || '';
        const named = [...set.matchAll(/<(?:\w+:)?comp\b[^>]*\bname=["']([^"']+)["']/gi)].map((m) => m[1].toUpperCase());
        const components = named.length ? COMPONENTS.filter((c) => named.includes(c)) : COMPONENTS;
        return {
            components,
            componentsDeclared: named.length > 0,
            creates: Object.keys(COMPONENT_OF).filter((kind) => components.includes(COMPONENT_OF[kind])),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync
    // ─────────────────────────────────────────────────────────────────────────

    async fetchChanges(container, cursor) {
        if (cursor) {
            const incremental = await this.#syncCollection(container, cursor);
            if (incremental) return incremental;
            // Token rejected — fall through to a full window query.
        }
        return this.#fullQuery(container);
    }

    async #syncCollection(container, token) {
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: undefined,
            body: `<?xml version="1.0"?><d:sync-collection ${DAV_NS_HINT}><d:sync-token>${this.#xmlEscape(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        });
        if (status !== 207) return null;

        const hrefs = this.#responses(text)
            .filter((r) => !/404/.test(r.statusLine || ''))
            .map((r) => r.href)
            .filter((h) => /\.ics$/i.test(h));
        const nextToken = this.#tagText(text, 'sync-token') || token;
        const documents = hrefs.length ? await this.#multiget(container, hrefs) : [];
        return { documents, nextCursor: nextToken, done: true };
    }

    async #fullQuery(container) {
        const initialDays = Number(this.config.initialSyncDays) || 365;
        const start = new Date(Date.now() - initialDays * 86_400_000)
            .toISOString().replace(/[-:]|\.\d{3}/g, '');
        const components = container.components || COMPONENTS;
        const documents = [];

        if (components.includes('VEVENT')) {
            documents.push(...await this.#query(container, `<c:comp-filter name="VEVENT"><c:time-range start="${start}"/></c:comp-filter>`));
        }
        if (components.includes('VTODO')) {
            // Tasks have no window: an open task stays relevant however old.
            // A server that never declared VTODO support may refuse the
            // query; that is "no tasks here", not a failed sync.
            try {
                documents.push(...await this.#query(container, '<c:comp-filter name="VTODO"/>'));
            } catch (error) {
                if (container.componentsDeclared) throw error;
            }
        }

        // Re-arm incremental sync where the server supports it.
        const token = await this.#fetchSyncToken(container);
        return { documents, nextCursor: token, done: true };
    }

    async #query(container, componentFilter) {
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: 1,
            body: `<?xml version="1.0"?><c:calendar-query ${DAV_NS_HINT}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR">${componentFilter}</c:comp-filter></c:filter></c:calendar-query>`,
        });
        if (status !== 207) throw new Error(`caldav calendar-query failed (${status})`);
        const documents = [];
        for (const response of this.#responses(text)) {
            const ics = this.#calendarData(response.propXml);
            if (!ics) continue;
            const doc = this.#toDocument(container, response.href, ics);
            if (doc) documents.push(doc);
        }
        return documents;
    }

    async #fetchSyncToken(container) {
        const { status, text } = await this.#dav('PROPFIND', container.href, {
            depth: 0,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:sync-token/></d:prop></d:propfind>`,
        });
        if (status !== 207) return null;
        return this.#tagText(text, 'sync-token') || null;
    }

    async #multiget(container, hrefs) {
        const hrefXml = hrefs.map((h) => `<d:href>${this.#xmlEscape(h)}</d:href>`).join('');
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: 1,
            body: `<?xml version="1.0"?><c:calendar-multiget ${DAV_NS_HINT}><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefXml}</c:calendar-multiget>`,
        });
        if (status !== 207) throw new Error(`caldav multiget failed (${status})`);
        const documents = [];
        for (const response of this.#responses(text)) {
            const ics = this.#calendarData(response.propXml);
            if (!ics) continue;
            const doc = this.#toDocument(container, response.href, ics);
            if (doc) documents.push(doc);
        }
        return documents;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write-back
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create a VEVENT (`kind` 'event') or a VTODO ('task') in a calendar.
     * `data` follows the Event schema ({title, start, end?, description?,
     * location?, recurrence?, allDay?}) or the Task schema ({title,
     * description?, status?, dueDate?, priority?}).
     * Returns { uid, href, document } — the caller ingests the mirror.
     */
    async createDocument(container, data = {}, kind = 'event') {
        if (!this.canWrite) throw new Error(`caldav backend ${this.address} is read-only`);
        const component = COMPONENT_OF[kind];
        if (!component) throw new Error(`caldav cannot create kind "${kind}", use "event" or "task"`);
        if (!data.title) throw new Error(`${kind} requires a title`);
        if (kind === 'event' && !data.start) throw new Error('event requires a start');

        const uid = `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@canvas`;
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Canvas//connector//EN',
            `BEGIN:${component}`,
            `UID:${uid}`,
            `DTSTAMP:${this.#icsDate(new Date().toISOString())}`,
            ...this.#propertyLines(component, data),
            `END:${component}`,
            'END:VCALENDAR',
            '',
        ].join('\r\n');
        const href = `${container.href.replace(/\/+$/, '')}/${uid}.ics`;

        const res = await fetch(href, {
            method: 'PUT',
            headers: this.#headers({
                'Content-Type': 'text/calendar; charset=utf-8',
                // Create-only: never overwrite an existing resource.
                'If-None-Match': '*',
            }),
            body: ics,
        });
        if (res.status !== 201 && res.status !== 204) {
            const body = await res.text().catch(() => '');
            throw new Error(`caldav PUT failed (${res.status}): ${body.slice(0, 200)}`);
        }
        return { uid, href, document: this.#toDocument(container, href, ics) };
    }

    /** caldav://<address>/<calendar>/<uid> → container id <calendar>. */
    containerIdFromProvenance(provenanceUrl) {
        const m = /^caldav:\/\/[^/]+\/([^/]+)\//.exec(String(provenanceUrl || ''));
        return m ? m[1] : null;
    }

    // Resource name and UID are independent — resolve the href by UID.
    async #findResource(container, provenanceUrl) {
        const uid = String(provenanceUrl || '').split('/').filter(Boolean).pop();
        if (!uid) throw new Error(`Cannot resolve the uid from ${provenanceUrl}`);
        for (const component of container.components || COMPONENTS) {
            const { status, text } = await this.#dav('REPORT', container.href, {
                depth: 1,
                body: `<?xml version="1.0"?><c:calendar-query ${DAV_NS_HINT}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}"><c:prop-filter name="UID"><c:text-match>${this.#xmlEscape(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
            });
            if (status !== 207) {
                if (component === 'VTODO' && !container.componentsDeclared) continue;
                throw new Error(`caldav UID lookup failed (${status})`);
            }
            const hit = this.#responses(text).find((r) => /\.ics$/i.test(r.href));
            if (hit) return new URL(hit.href, this.#origin()).toString();
        }
        return null;
    }

    /**
     * Change the VEVENT or VTODO behind a caldav:// provenance URL. `patch`
     * uses the document's data keys: a value sets the property, null or ''
     * removes it, an absent key leaves it alone. Only the named properties of
     * the master component are rewritten; alarms, attendees and everything
     * else in the resource stay as the server has them.
     */
    async updateDocument(container, provenanceUrl, patch = {}) {
        if (!this.canWrite) throw new Error(`caldav backend ${this.address} is read-only`);
        const href = await this.#findResource(container, provenanceUrl);
        if (!href) throw new Error(`${provenanceUrl} no longer exists on the CalDAV server`);

        const current = await fetch(href, { headers: this.#headers() });
        if (!current.ok) throw new Error(`caldav GET failed (${current.status})`);
        const etag = current.headers.get('etag');
        const source = await current.text();
        // Unchanged properties are never rewritten, so a title edit cannot
        // touch a DTSTART the server stores with its own time zone.
        const before = { ...this.#toDocument(container, href, source)?.data };
        // The Task schema stores a date-only due date as the end of that day.
        if (/^\d{4}-\d{2}-\d{2}$/.test(before.dueDate || '')) before.dueDate = this.#endOfDay(before.dueDate);
        const changed = changedFields(patch, before, [['start', 'end', 'allDay'], ['status', 'completedAt']]);
        if (this.#properties(this.#parseComponent(source)?.component, changed).length === 0) {
            return { remote: { href }, document: this.#toDocument(container, href, source) };
        }
        const ics = this.#patchIcs(source, changed);

        const res = await fetch(href, {
            method: 'PUT',
            headers: this.#headers({
                'Content-Type': 'text/calendar; charset=utf-8',
                // Refuse to overwrite a change made elsewhere since the GET.
                ...(etag ? { 'If-Match': etag } : {}),
            }),
            body: ics,
        });
        if (res.status === 412) throw new Error('The item changed on the CalDAV server in the meantime. Rescan the calendar and retry.');
        if (!(res.status === 200 || res.status === 201 || res.status === 204)) {
            const body = await res.text().catch(() => '');
            throw new Error(`caldav PUT failed (${res.status}): ${body.slice(0, 200)}`);
        }
        return { remote: { href }, document: this.#toDocument(container, href, ics) };
    }

    /**
     * Delete the resource behind a caldav:// provenance URL. Returns
     * { removedRemote: true } — no terminal mirror remains, the caller drops
     * the local document.
     */
    async deleteDocument(container, provenanceUrl) {
        if (!this.canWrite) throw new Error(`caldav backend ${this.address} is read-only`);
        const href = await this.#findResource(container, provenanceUrl);
        // Already gone remotely — report removed so the local mirror clears.
        if (!href) return { removedRemote: true };

        const res = await fetch(href, { method: 'DELETE', headers: this.#headers() });
        if (!(res.status === 200 || res.status === 204 || res.status === 404)) {
            throw new Error(`caldav DELETE failed (${res.status})`);
        }
        return { removedRemote: true };
    }

    #endOfDay(day) {
        const [year, month, date] = day.split('-').map(Number);
        const end = new Date(0);
        end.setFullYear(year, month - 1, date);
        end.setHours(23, 59, 59, 999);
        return end.toISOString();
    }

    // Document data → [property name, content line | null]. null removes the
    // property; a key the data does not carry yields no entry at all.
    #properties(component, data) {
        const out = [];
        const has = (key) => Object.hasOwn(data, key);
        const empty = (value) => value === undefined || value === null || value === '' || value === false;
        const text = (name, key) => { if (has(key)) out.push([name, empty(data[key]) ? null : `${name}:${this.#icsEscape(data[key])}`]); };
        const date = (name, value, dateOnly) => dateOnly
            ? `${name};VALUE=DATE:${String(value).slice(0, 10).replace(/-/g, '')}`
            : `${name}:${this.#icsDate(value)}`;

        text('SUMMARY', 'title');
        text('DESCRIPTION', 'description');
        if (component === 'VEVENT') {
            text('LOCATION', 'location');
            // allDay decides how both ends are written, so the three travel together.
            if (has('start') && !empty(data.start)) {
                const allDay = data.allDay === true;
                out.push(['DTSTART', date('DTSTART', data.start, allDay)]);
                out.push(['DTEND', empty(data.end) ? null : date('DTEND', data.end, allDay)]);
            }
            if (has('recurrence')) out.push(['RRULE', empty(data.recurrence) ? null : `RRULE:${data.recurrence}`]);
        } else {
            if (has('dueDate')) {
                out.push(['DUE', empty(data.dueDate) ? null : date('DUE', data.dueDate, /^\d{4}-\d{2}-\d{2}$/.test(String(data.dueDate)))]);
            }
            if (has('priority')) out.push(['PRIORITY', empty(data.priority) ? null : `PRIORITY:${Number(data.priority)}`]);
            if (has('status') && !empty(data.status)) {
                const status = VTODO_STATUS[data.status];
                if (!status) throw new Error(`Unknown task status "${data.status}", use ${Object.keys(VTODO_STATUS).join(', ')}`);
                out.push(['STATUS', `STATUS:${status}`]);
                out.push(['COMPLETED', status === 'COMPLETED' ? `COMPLETED:${this.#icsDate(data.completedAt || new Date().toISOString())}` : null]);
                out.push(['PERCENT-COMPLETE', status === 'COMPLETED' ? 'PERCENT-COMPLETE:100' : null]);
            }
        }
        return out;
    }

    #propertyLines(component, data) {
        return this.#properties(component, data).map(([, line]) => line).filter(Boolean).map((line) => this.#fold(line));
    }

    // Rewrite the patched properties of the master VEVENT/VTODO in place.
    #patchIcs(ics, patch) {
        const lines = String(ics).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
        const master = this.#masterRange(lines);
        if (!master) throw new Error('The CalDAV resource holds no event or task');
        const changes = new Map(this.#properties(master.component, patch));
        changes.set('LAST-MODIFIED', `LAST-MODIFIED:${this.#icsDate(new Date().toISOString())}`);
        changes.set('DTSTAMP', `DTSTAMP:${this.#icsDate(new Date().toISOString())}`);
        const sequence = lines.slice(master.start, master.end).find((line) => /^SEQUENCE:/i.test(line));
        changes.set('SEQUENCE', `SEQUENCE:${(Number(sequence?.split(':')[1]) || 0) + 1}`);

        const body = [];
        let depth = 0;
        for (const line of lines.slice(master.start + 1, master.end)) {
            // Nested components (VALARM) keep every line, also a SUMMARY of their own.
            if (/^BEGIN:/i.test(line)) depth += 1;
            const name = line.split(/[;:]/, 1)[0].toUpperCase();
            if (depth === 0 && changes.has(name)) continue;
            body.push(line);
            if (/^END:/i.test(line)) depth -= 1;
        }
        const added = [...changes.values()].filter(Boolean);
        return [
            ...lines.slice(0, master.start + 1),
            ...added,
            ...body,
            ...lines.slice(master.end),
        ].map((line) => this.#fold(line)).join('\r\n');
    }

    // Line range [start, end] of the first VEVENT/VTODO without a
    // RECURRENCE-ID (the series master) in unfolded lines.
    #masterRange(lines) {
        let start = -1;
        let component = null;
        let override = false;
        for (let i = 0; i < lines.length; i++) {
            const begin = /^BEGIN:(VEVENT|VTODO)\s*$/i.exec(lines[i]);
            if (begin && start < 0) { start = i; component = begin[1].toUpperCase(); override = false; continue; }
            if (start < 0) continue;
            if (/^RECURRENCE-ID[;:]/i.test(lines[i])) override = true;
            if (new RegExp(`^END:${component}\\s*$`, 'i').test(lines[i])) {
                if (!override) return { start, end: i, component };
                start = -1;
            }
        }
        return null;
    }

    // RFC 5545 §3.1: content lines are folded at 75 octets.
    #fold(line) {
        if (Buffer.byteLength(line) <= 75) return line;
        const parts = [];
        let current = '';
        for (const char of line) {
            if (Buffer.byteLength(current + char) > (parts.length ? 74 : 75)) { parts.push(current); current = ''; }
            current += char;
        }
        parts.push(current);
        return parts.join('\r\n ');
    }

    #icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, ''); }
    #icsEscape(v) { return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
    #xmlEscape(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // ─────────────────────────────────────────────────────────────────────────
    // ICS → Event document
    // ─────────────────────────────────────────────────────────────────────────

    #toDocument(container, href, ics) {
        const parsed = this.#parseComponent(ics);
        if (!parsed) return null;
        const { component, props } = parsed;
        const uid = props.UID || href;
        const absHref = new URL(href, this.#origin()).toString();
        const common = {
            metadata: {
                remoteId: uid,
                remoteUpdatedAt: this.#fromIcsDate(props['LAST-MODIFIED']) || undefined,
            },
            provenanceUrl: this.provenance(this.address, container.id, uid),
            links: [absHref],
            containerSegment: container.id,
        };
        const dateOnly = (name) => /VALUE=DATE\b/.test(props[`${name}_PARAMS`] || '') || /^\d{8}$/.test(props[name] || '');

        if (component === 'VTODO') {
            const due = this.#fromIcsDate(props.DUE, props.DUE_PARAMS);
            const priority = Number(props.PRIORITY);
            return this.document({
                ...common,
                schema: 'data/schema/task',
                data: {
                    title: this.#unescapeIcs(props.SUMMARY) || '(untitled)',
                    description: this.#unescapeIcs(props.DESCRIPTION) || undefined,
                    status: TASK_STATUS[String(props.STATUS || '').toUpperCase()] || (props.COMPLETED ? 'completed' : 'pending'),
                    completedAt: this.#fromIcsDate(props.COMPLETED, props.COMPLETED_PARAMS) ?? undefined,
                    // A date-only DUE stays a calendar date: the Task schema
                    // places it at the end of that day.
                    dueDate: due ? (dateOnly('DUE') ? due.slice(0, 10) : due) : undefined,
                    // RFC 5545: 0 means "no priority".
                    priority: Number.isInteger(priority) && priority >= 1 && priority <= 9 ? priority : undefined,
                    calendarId: container.id,
                },
            });
        }

        const start = this.#fromIcsDate(props.DTSTART, props.DTSTART_PARAMS);
        if (!start) return null;
        return this.document({
            ...common,
            schema: 'data/schema/event/calendar',
            data: {
                title: this.#unescapeIcs(props.SUMMARY) || '(untitled)',
                description: this.#unescapeIcs(props.DESCRIPTION) || undefined,
                start,
                end: this.#fromIcsDate(props.DTEND, props.DTEND_PARAMS) ?? undefined,
                allDay: dateOnly('DTSTART') || undefined,
                location: this.#unescapeIcs(props.LOCATION) || undefined,
                recurrence: props.RRULE || undefined,
                calendar: container.calendar,
                calendarId: container.id,
                eventStatus: props.STATUS ? props.STATUS.toLowerCase() : undefined,
            },
        });
    }

    // Minimal component reader: unfold (CRLF + space/tab continuation), take
    // the FIRST VEVENT or VTODO without a RECURRENCE-ID (the series master)
    // and collect its top-level properties. Parameters are kept beside the
    // value for the few we inspect (VALUE=DATE).
    #parseComponent(ics) {
        const lines = String(ics).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
        const master = this.#masterRange(lines);
        if (!master) return null;
        const props = {};
        let depth = 0;
        for (const line of lines.slice(master.start + 1, master.end)) {
            if (/^BEGIN:/i.test(line)) { depth += 1; continue; }
            if (/^END:/i.test(line)) { depth -= 1; continue; }
            if (depth > 0) continue;
            const idx = line.indexOf(':');
            if (idx < 1) continue;
            const [name, ...params] = line.slice(0, idx).split(';');
            const key = name.toUpperCase();
            if (props[key] === undefined) {
                props[key] = line.slice(idx + 1);
                if (params.length) props[`${key}_PARAMS`] = params.join(';');
            }
        }
        return { component: master.component, props };
    }

    // 19980118T230000Z (UTC) | TZID=Europe/Vienna:19980118T230000 (wall time
    // in that zone) | 19980118T230000 (floating — treated as UTC, v1
    // approximation) | 19980118 (all-day, midnight UTC).
    #fromIcsDate(value, params = '') {
        if (!value) return null;
        const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (!m) return null;
        const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1, 7).map((part) => Number(part ?? 0));
        const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
        if (Number.isNaN(wall)) return null;
        const zone = !m[7] && m[4] !== undefined ? /(?:^|;)TZID=([^;]+)/i.exec(params || '')?.[1]?.replace(/^"|"$/g, '') : null;
        return new Date(zone ? this.#zonedToUtc(wall, zone) : wall).toISOString();
    }

    // The instant at which `zone` shows the wall-clock time `wall` (given as
    // if it were UTC). An unknown zone name reads as UTC.
    #zonedToUtc(wall, zone) {
        let format;
        try {
            format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch { return wall; }
        const offset = (instant) => {
            const p = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
            return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
        };
        // Second pass settles the offset across a DST change.
        return wall - offset(wall - offset(wall));
    }

    #unescapeIcs(v) {
        if (!v) return v;
        return String(v).replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Multistatus parsing (namespace-prefix agnostic, regex on localnames)
    // ─────────────────────────────────────────────────────────────────────────

    #responses(xml) {
        const out = [];
        const re = /<(?:\w+:)?response[\s>]([\s\S]*?)<\/(?:\w+:)?response>/gi;
        let m;
        while ((m = re.exec(xml))) {
            const block = m[1];
            const href = this.#tagText(block, 'href');
            if (!href) continue;
            const statusLine = this.#tagText(block, 'status') || '';
            out.push({ href, propXml: block, statusLine });
        }
        return out;
    }

    #tagText(xml, localName) {
        const m = new RegExp(`<(?:\\w+:)?${localName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'i').exec(xml);
        return m ? m[1].trim() : null;
    }

    #calendarData(xml) {
        const raw = this.#tagText(xml, 'calendar-data');
        if (!raw) return null;
        // XML-unescape the ICS payload.
        return raw
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
    }
}
