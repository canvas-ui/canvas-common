'use strict';

/**
 * Google Calendar driver — one backend per Google account (address = account
 * email/label). `config.calendars` lists calendar ids ('primary', an email, or
 * a long group id), each optionally naming the calendar in Canvas
 * (`<id> = <name>`, see calendar-names.js); defaults to ['primary'], named
 * after the account label.
 *
 * Cursor per calendar: Google's `nextSyncToken` — true incremental sync
 * (changed AND cancelled instances come back). A 410 GONE invalidates the
 * token; we restart from a `timeMin` window. Cancelled instances are skipped
 * (v1 keeps no tombstones — see docs/connectors.md).
 *
 * Write-back (only when readOnly === false, and the consent covered the
 * read/write calendar scope): create, edit and delete events.
 *
 * Auth: OAuth refresh-token grant — `config.clientId`, `config.clientSecret`,
 * `config.refreshToken` from an offline-access consent. Access token cached
 * until expiry. Plain fetch, no googleapis dependency.
 */

import BaseConnector from '../BaseConnector.js';
import { parseCalendarList } from '../calendar-names.js';
import { changedFields } from '../patch.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const PAGE_SIZE = 250;

export default class GcalConnector extends BaseConnector {
    static driver = 'gcal';
    static label = 'Google Calendar';
    static icon = 'mdi:google';
    static blurb = 'Events from the calendars you list.';
    static provenanceScheme = 'gcal';
    static supports = { prune: false, create: true, update: true, delete: true };
    static creates = ['event'];

    static configFields = [
        { key: 'address', label: 'Account label', placeholder: 'work', required: true },
        { key: 'clientId', label: 'OAuth client id', required: true },
        { key: 'clientSecret', label: 'OAuth client secret', secret: true, required: true },
        { key: 'refreshToken', label: 'Refresh token', secret: true, required: true },
        { key: 'calendars', label: 'Calendar ids (one per line, blank = primary; "<id> = <name>" names the calendar in Canvas)', list: true },
        { key: 'initialSyncDays', label: 'Initial history (days)', type: 'number', placeholder: '365' },
        { key: 'writeBack', label: 'Allow Canvas to create, edit and delete events (needs a refresh token with the read/write calendar scope)', type: 'boolean' },
    ];

    #accessToken = null;
    #tokenExpiresAt = 0;


    async #token() {
        if (this.#accessToken && Date.now() < this.#tokenExpiresAt - 60_000) return this.#accessToken;
        const { clientId, clientSecret, refreshToken } = this.config;
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('gcal backend requires clientId, clientSecret and refreshToken');
        }
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.access_token) {
            throw new Error(`gcal token refresh failed: ${json?.error_description || json?.error || `HTTP ${res.status}`}`);
        }
        this.#accessToken = json.access_token;
        this.#tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
        return this.#accessToken;
    }

    async #get(pathname, params = {}) {
        const token = await this.#token();
        const url = new URL(`${API}${pathname}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.status === 410) { const err = new Error('gcal sync token expired'); err.gone = true; throw err; }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`gcal ${res.status} ${pathname}: ${body.slice(0, 200)}`);
        }
        return res.json();
    }

    async test() {
        await this.#get('/users/me/calendarList', { maxResults: 1 });
    }

    // `calendar` is the calendar's name in Canvas (data.calendar → its own
    // timeline). Unnamed calendars fall back to the account label for
    // 'primary' and to the calendar id otherwise.
    async listContainers() {
        const configured = parseCalendarList(this.config.calendars);
        const list = configured.length ? configured : [{ id: 'primary', calendar: null }];
        return list.map(({ id, calendar }) => ({
            id,
            name: id,
            writable: this.canWrite,
            calendar: calendar || (id === 'primary' ? this.address : id),
        }));
    }

    // Cursor shape: { syncToken } after the first full pass, or
    // { pageToken, syncToken: null } mid-initial-sync. Stored as JSON string.
    async fetchChanges(container, cursor) {
        const state = this.#parseCursor(cursor);
        const params = {
            maxResults: PAGE_SIZE,
            // Recurring series come back as single events with RRULE — the
            // Event schema's envelope model wants the series, not instances.
            singleEvents: false,
        };
        if (state.syncToken) params.syncToken = state.syncToken;
        else {
            const initialDays = Number(this.config.initialSyncDays) || 365;
            params.timeMin = new Date(Date.now() - initialDays * 86_400_000).toISOString();
        }
        if (state.pageToken) params.pageToken = state.pageToken;

        let page;
        try {
            page = await this.#get(`/calendars/${encodeURIComponent(container.id)}/events`, params);
        } catch (err) {
            if (err.gone) {
                // Expired sync token — restart the incremental stream.
                return { documents: [], nextCursor: this.#cursor({ syncToken: null, pageToken: null }), done: false };
            }
            throw err;
        }

        const documents = [];
        for (const event of page.items || []) {
            if (event.status === 'cancelled') continue;
            const doc = this.#toDocument(container, event);
            if (doc) documents.push(doc);
        }

        const nextCursor = page.nextPageToken
            ? this.#cursor({ ...state, pageToken: page.nextPageToken })
            : this.#cursor({ syncToken: page.nextSyncToken || state.syncToken, pageToken: null });
        return { documents, nextCursor, done: !page.nextPageToken };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write-back
    // ─────────────────────────────────────────────────────────────────────────

    async #send(method, pathname, body) {
        const token = await this.#token();
        const res = await fetch(`${API}${pathname}`, {
            method,
            headers: { 'Authorization': `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (method === 'DELETE' && (res.status === 204 || res.status === 404 || res.status === 410)) return null;
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const reason = json?.error?.message || `HTTP ${res.status}`;
            throw new Error(res.status === 403 && /scope/i.test(reason)
                ? 'Google refused the change: the refresh token only covers reading. Sign in with Google again in the connector settings with "Create and edit events from Canvas" enabled.'
                : `gcal ${res.status} ${method} ${pathname}: ${reason}`);
        }
        return json;
    }

    /** Create an event. `data` follows the Event schema ({title, start, end?, allDay?, description?, location?, recurrence?}). */
    async createDocument(container, data = {}) {
        if (!data.title || !data.start) throw new Error('event requires title and start');
        const event = await this.#send('POST', `/calendars/${encodeURIComponent(container.id)}/events`, this.#eventBody(data));
        return { uid: event.iCalUID || event.id, href: event.htmlLink, document: this.#toDocument(container, event) };
    }

    /** gcal://<calendar id>/<event id> → container id <calendar id>. */
    containerIdFromProvenance(provenanceUrl) {
        const m = /^gcal:\/\/(.+)\/[^/]+$/.exec(String(provenanceUrl || ''));
        return m ? m[1] : null;
    }

    #eventPath(container, provenanceUrl) {
        const eventId = String(provenanceUrl || '').split('/').filter(Boolean).pop();
        if (!eventId) throw new Error(`Cannot resolve the event id from ${provenanceUrl}`);
        return `/calendars/${encodeURIComponent(container.id)}/events/${encodeURIComponent(eventId)}`;
    }

    /**
     * Change the event behind a gcal:// provenance URL. `patch` uses the
     * Event data keys: a value sets the field, null or '' clears it, an absent
     * key leaves it alone. Only fields that differ from the event as Google
     * has it are sent.
     */
    async updateDocument(container, provenanceUrl, patch = {}) {
        const pathname = this.#eventPath(container, provenanceUrl);
        const current = await this.#get(pathname);
        const changed = changedFields(patch, this.#toDocument(container, current)?.data || {}, [['start', 'end', 'allDay']]);
        const body = this.#eventBody(changed);
        const event = Object.keys(body).length ? await this.#send('PATCH', pathname, body) : current;
        return { remote: { id: event.id, status: event.status }, document: this.#toDocument(container, event) };
    }

    /** Delete the event. No mirror remains; the caller drops the local document. */
    async deleteDocument(container, provenanceUrl) {
        await this.#send('DELETE', this.#eventPath(container, provenanceUrl));
        return { removedRemote: true };
    }

    // Event data → Google event resource, for the keys `data` carries.
    #eventBody(data) {
        const has = (key) => Object.hasOwn(data, key);
        const empty = (value) => value === undefined || value === null || value === '' || value === false;
        const body = {};
        if (has('title') && !empty(data.title)) body.summary = data.title;
        if (has('description')) body.description = empty(data.description) ? '' : data.description;
        if (has('location')) body.location = empty(data.location) ? '' : data.location;
        if (has('recurrence')) body.recurrence = empty(data.recurrence) ? [] : [`RRULE:${data.recurrence}`];
        if (has('start') && !empty(data.start)) {
            const allDay = data.allDay === true;
            const start = new Date(data.start);
            // Google requires an end: an hour (or the one day) when none is given.
            const end = empty(data.end) ? new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000)) : new Date(data.end);
            // The unused one of date/dateTime is nulled so a patch can switch
            // an event between timed and all-day.
            const when = (date) => allDay
                ? { date: date.toISOString().slice(0, 10), dateTime: null, timeZone: null }
                : { dateTime: date.toISOString(), date: null, timeZone: 'UTC' };
            body.start = when(start);
            body.end = when(end);
        }
        return body;
    }

    #parseCursor(cursor) {
        if (!cursor) return { syncToken: null, pageToken: null };
        try { return JSON.parse(cursor); } catch { return { syncToken: cursor, pageToken: null }; }
    }

    #cursor(state) { return JSON.stringify({ syncToken: state.syncToken || null, pageToken: state.pageToken || null }); }

    #toDocument(container, event) {
        const start = this.#when(event.start);
        if (!event.id || !start) return null; // an event without a position is not an event
        const rrule = (event.recurrence || []).find((r) => /^RRULE:/i.test(r));

        return this.document({
            schema: 'data/schema/event/calendar',
            data: {
                title: event.summary || '(untitled)',
                description: event.description || undefined,
                start,
                end: this.#when(event.end) ?? undefined,
                allDay: Boolean(event.start?.date && !event.start?.dateTime) || undefined,
                location: event.location || undefined,
                recurrence: rrule ? rrule.replace(/^RRULE:/i, '') : undefined,
                calendar: container.calendar,
                // Connector extras (Event data schema is passthrough)
                calendarId: container.id,
                organizer: event.organizer?.email || undefined,
                attendees: event.attendees?.map((a) => a.email).filter(Boolean),
                htmlLink: event.htmlLink || undefined,
                eventStatus: event.status || undefined,
            },
            metadata: {
                remoteId: event.iCalUID || event.id,
                remoteUpdatedAt: event.updated,
            },
            provenanceUrl: this.provenance(container.id, event.id),
            links: [event.htmlLink],
            containerSegment: container.id,
        });
    }

    // Google gives {dateTime} for timed events and {date} for all-day ones;
    // the Event schema wants an ISO datetime, so all-day dates pin to midnight
    // UTC (approximation noted in docs/connectors.md).
    #when(when) {
        if (!when) return null;
        if (when.dateTime) return new Date(when.dateTime).toISOString();
        if (when.date) return `${when.date}T00:00:00.000Z`;
        return null;
    }
}
