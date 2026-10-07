import { randomUUID } from 'node:crypto';

export function generateUUID(length, prefix, delimiter = '-') {
    const uuid = randomUUID();
    const id = length ? uuid.replace(/-/g, '').slice(0, length) : uuid;
    return prefix ? `${prefix}${delimiter}${id}` : id;
}
