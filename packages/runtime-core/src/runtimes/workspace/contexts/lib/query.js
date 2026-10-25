// Only query constraints are accepted here: never let a live client replace
// context paths, ownership, pagination or applyContextSpec through this object.
export function normalizeQueryOptions(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid context query options');
    const ids = value.ids ?? null;
    if (ids !== null && (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw new Error('Invalid live document IDs');
    const queries = value.queries ?? [];
    if (!Array.isArray(queries) || queries.length > 32 || queries.some(q => typeof q !== 'string' || q.length > 4096)) throw new Error('Invalid live search queries');
    if (value.sortBy != null && (typeof value.sortBy !== 'string' || value.sortBy.length > 256)) throw new Error('Invalid live sort');
    if (value.order != null && !['asc', 'desc'].includes(value.order)) throw new Error('Invalid live order');
    const geoSelection = value.geoSelection ?? null;
    if (geoSelection) {
        const point = p => p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
        if (geoSelection.kind === 'polygon') {
            if (!Array.isArray(geoSelection.points) || geoSelection.points.length < 3 || geoSelection.points.length > 1024 || !geoSelection.points.every(point)) throw new Error('Invalid live polygon');
        } else if (geoSelection.kind === 'rect') {
            const b = geoSelection.bbox;
            if (!b || !point({ lat: b.minLat, lon: b.minLon }) || !point({ lat: b.maxLat, lon: b.maxLon }) || b.minLat > b.maxLat || b.minLon > b.maxLon) throw new Error('Invalid live map area');
        } else throw new Error('Invalid live map selection');
    }
    return { ids: ids === null ? null : [...new Set(ids)], queries: queries.map(q => q.trim()).filter(Boolean), sortBy: value.sortBy ?? '', order: value.order ?? 'desc', geoSelection, includeUnlocated: value.includeUnlocated === true };
}

export function normalizeLiveQuery(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid live context query');
    const { filters } = value;
    if (!filters?.features || !filters?.timeline || !filters?.geo || !filters?.lens || !filters?.sort) throw new Error('Incomplete live filters');
    const features = {};
    for (const key of ['allOf', 'anyOf', 'noneOf']) {
        const values = filters.features[key];
        if (!Array.isArray(values) || values.length > 1024 || values.some(t => typeof t !== 'string' || t.length > 4096)) throw new Error('Invalid live features');
        features[key] = [...values];
    }
    const timeline = filters.timeline;
    if (timeline.quickFilter != null && (typeof timeline.quickFilter !== 'string' || timeline.quickFilter.length > 256)) throw new Error('Invalid live time filter');
    for (const key of ['indexCreated', 'indexUpdated', 'indexDeleted', 'contentEvents']) {
        if (typeof timeline[key] !== 'boolean') throw new Error('Invalid live timeline switch');
    }
    const names = timeline.selectedTimelines;
    if (!Array.isArray(names) || names.length > 32 || names.some(n => typeof n !== 'string' || n.length > 256)) throw new Error('Invalid live timelines');
    const ranges = timeline.customRanges ?? (timeline.customRange ? [timeline.customRange] : []);
    if (!Array.isArray(ranges) || ranges.length > 32 || ranges.some(r => typeof r?.start !== 'string' || typeof r?.end !== 'string' || r.start.length > 256 || r.end.length > 256)) throw new Error('Invalid live time ranges');
    const bbox = filters.geo.bbox ?? null;
    if (bbox) normalizeQueryOptions({ geoSelection: { kind: 'rect', bbox } });
    const gps = filters.lens.gps ?? null;
    if (gps && (!Number.isFinite(gps.lat) || Math.abs(gps.lat) > 90 || !Number.isFinite(gps.lon) || Math.abs(gps.lon) > 180 || !Number.isFinite(gps.radiusM) || gps.radiusM <= 0)) throw new Error('Invalid live GPS fix');
    const queryOptions = normalizeQueryOptions({
        ids: filters.lens.ids, sortBy: filters.sort.sortBy, order: filters.sort.order,
        queries: value.queries, geoSelection: value.geoSelection, includeUnlocated: filters.geo.includeUnlocated,
    });
    const specs = ranges.length ? ranges.map(r => `${r.start}..${r.end}`) : timeline.quickFilter ? [timeline.quickFilter] : [];
    const timelines = [ ...(timeline.indexCreated ? ['crud:created'] : []), ...(timeline.indexUpdated ? ['crud:updated'] : []), ...(timeline.indexDeleted ? ['crud:deleted'] : []), ...(timeline.contentEvents ? ['content'] : []), ...names ];
    const tokens = timelines.flatMap(name => specs.map(spec => `t:${name}:${spec}`));
    if (bbox) tokens.push(`geo:bbox:${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`);
    if (gps) tokens.push(`geo:near:${gps.lat},${gps.lon},${Math.max(1, Math.round(gps.radiusM))}m`);
    if ((bbox || gps) && queryOptions.includeUnlocated) tokens.push('geo:missing');
    // Derive the effective query server-side from the UI state, so clients
    // cannot publish a different camera/geo/time binding to other devices.
    return structuredClone({
        filters: { features, timeline: { ...timeline, customRanges: ranges }, geo: { bbox, includeUnlocated: queryOptions.includeUnlocated }, lens: { gps, ids: queryOptions.ids }, sort: { sortBy: queryOptions.sortBy, order: queryOptions.order } },
        geoSelection: queryOptions.geoSelection, queries: queryOptions.queries,
        binding: { features, filters: tokens, queryOptions },
    });
}

export function documentInSelection(doc, selection, includeUnlocated = false) {
    const geo = doc?.metadata?.geo;
    const lat = geo?.lat == null || geo.lat === '' ? NaN : Number(geo.lat);
    const lon = geo?.lon == null || geo.lon === '' ? NaN : Number(geo.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return includeUnlocated;
    if (selection.kind === 'rect') {
        const b = selection.bbox;
        return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
    }
    let inside = false;
    const ring = selection.points;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.lat > lat) !== (b.lat > lat) && lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
    }
    return inside;
}
