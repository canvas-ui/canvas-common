import BaseFetcher from '../../BaseFetcher.js';

/** One offline HTML file, captured by this workspace’s canvas-captured service. */
class PageFetcher extends BaseFetcher {
    static kind = 'page';
    static layout = 'file';
    static fallback = true;

    static async fetch(url, ctx) {
        return ctx.workspace.capturePage(url, ctx);
    }
}

export default PageFetcher;
