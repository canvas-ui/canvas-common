'use strict';

const UNITS = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/**
 * A byte count from config: `53687091200`, `50G`, `50GB`, `50GiB`, `512m`
 * (binary units). Returns `fallback` for an empty value; throws on garbage so
 * a typo fails at startup instead of silently capping uploads.
 */
export function parseByteSize(value, fallback) {
    if (value == null || String(value).trim() === '') return fallback;
    const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i.exec(String(value));
    if (!match) throw new Error(`Invalid byte size: ${value}`);
    return Math.floor(Number(match[1]) * UNITS[match[2].toLowerCase()]);
}
