'use strict';

import BaseFetcher from '../../BaseFetcher.js';
import path from 'node:path';
import { listFiles, runTool, USER_AGENT } from '../../lib.js';

const MAX_DEPTH = 5;

/** Run a recursive wget mirror and return the entry HTML. */
async function wgetInto(url, { workDir, timeoutMs, logger, depth = 2 }) {
    const level = Math.min(Math.max(1, Number(depth) || 2), MAX_DEPTH);
    const args = [
        '--quiet', '--no-verbose', '--adjust-extension', '--convert-links', '--page-requisites', '--no-parent',
        '--timeout=30', '--tries=2', `--user-agent=${USER_AGENT}`,
        '-e', 'robots=off',
        '--recursive', `--level=${level}`,
        '-P', workDir,
        url,
    ];
    // wget exits 8 on any 4xx/5xx among requisites even when the page itself
    // downloaded — judge by what landed on disk instead.
    await runTool('wget', args, { cwd: workDir, timeoutMs, logger, label: 'wget' }).catch((err) => {
        logger?.debug(`fetch: wget finished with ${err.message}`);
    });
    const html = listFiles(workDir).filter((f) => /\.html?$/i.test(f));
    if (!html.length) { throw new Error('wget produced no HTML page'); }
    const depthOf = (f) => f.split(path.sep).length;
    const wanted = (() => { try { return path.posix.basename(new URL(url).pathname); } catch { return ''; } })();
    return html.sort((a, b) => {
        const score = (f) => (path.basename(f).startsWith(wanted && wanted !== '/' ? wanted : 'index.html') ? 0 : 1);
        return score(a) - score(b) || depthOf(a) - depthOf(b);
    })[0];
}

/**
 * website — recursive mirror, `depth` levels deep (default 2, max 5). Never
 * auto-selected; a rule has to ask for `kind: website` explicitly.
 */
class WebsiteFetcher extends BaseFetcher {
    static kind = 'website';
    static layout = 'tree';

    static async fetch(url, ctx) {
        return wgetInto(url, { ...ctx, depth: ctx.action?.depth });
    }
}

export default WebsiteFetcher;
