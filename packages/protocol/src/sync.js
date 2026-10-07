'use strict';

/**
 * File-plane sync constants every party must agree on: the hub (canvas-server
 * watcher + objects API), canvas-fuse --mirror and canvas-edge. A file that
 * one side ignores and another uploads would ping-pong forever, so the lists
 * live here, in the wire contract, and nowhere else.
 */

// Directory a workspace keeps its own runtime state in (db/, config/, var/,
// mirror ledgers). Never synced, never indexed.
export const WORKSPACE_INTERNAL_DIRNAME = '.workspace';

// Default exclusions for every synced/indexed backend. Users add on top;
// nothing here can be relaxed by one party alone.
export const DEFAULT_SYNC_EXCLUSIONS = Object.freeze([
    '**/.*',            // dotfiles (also covers .git, .cache, browser profiles…)
    '**/.*/**',         // …and everything below dotdirs
    '**/node_modules/**',
    '**/__pycache__/**',
    '**/bower_components/**',
    '**/vendor/bundle/**', // ruby gems
    '**/target/debug/**',  // cargo
    '**/target/release/**',
    '**/*.swp',
    '**/*.tmp',
    '**/Cache/**',
    '**/Caches/**',
    '**/CachedData/**',
]);

// A workspace's own internals, on top of DEFAULT_SYNC_EXCLUSIONS and
// regardless of layout. Dotfiles are excluded by default anyway; spelled out
// so it survives any future relaxation of the dotfile rule.
export const WORKSPACE_INTERNAL_EXCLUSIONS = Object.freeze([
    '.agent', '.agent/**',
    WORKSPACE_INTERNAL_DIRNAME,
    `${WORKSPACE_INTERNAL_DIRNAME}/**`,
]);
