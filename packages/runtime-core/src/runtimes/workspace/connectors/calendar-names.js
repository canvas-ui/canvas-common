'use strict';

/**
 * Calendar connector config: the `calendars` list names which calendars to
 * sync, and each entry may also choose the calendar's name in Canvas —
 * `<id>` alone, or `<id> = <name>`. The name becomes `data.calendar` on every
 * event, which synapsd turns into a timeline of that name and a
 * `data/calendar/<name>` facet (see Event.js).
 */

/** @returns {Array<{ id: string, calendar: string|null }>} */
export function parseCalendarList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const entry = String(raw ?? '').trim();
        if (!entry) continue;
        const eq = entry.indexOf('=');
        if (eq < 0) { out.push({ id: entry, calendar: null }); continue; }
        const id = entry.slice(0, eq).trim();
        const calendar = entry.slice(eq + 1).trim();
        if (!id) continue;
        out.push({ id, calendar: calendar || null });
    }
    return out;
}
