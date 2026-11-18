'use strict';

const blank = (value) => value === undefined || value === null || value === '' || value === false;

/**
 * The part of a write-back `patch` that differs from `before`, the document
 * data the source currently holds. Drivers send only this, so an edit of one
 * field never rewrites another the source stores in its own form (a start
 * time with a time zone). `groups` lists fields a source writes together:
 * when one of them changed, all of them are included.
 */
export function changedFields(patch, before, groups = []) {
    const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !same(value, before[key])));
    for (const group of groups) {
        if (!group.some((key) => Object.hasOwn(changed, key))) continue;
        for (const key of group) {
            if (!Object.hasOwn(changed, key)) changed[key] = Object.hasOwn(patch, key) ? patch[key] : before[key];
        }
    }
    return changed;
}
