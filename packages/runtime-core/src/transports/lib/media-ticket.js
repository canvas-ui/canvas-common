'use strict';

/**
 * The workspace routes the media-ticket cookie opens, as the path after
 * `/workspaces/:id`: document content, a document as a file, and an archive of
 * a selection. A browser fetches these itself (<video src>, a download, a drag
 * out of the page) and cannot send an Authorization header. Every hop in front
 * of the route (hub forwarders, the runtime host) lets exactly these through
 * to the route's own ticket check.
 */
export const MEDIA_TICKET_SUFFIX = /^\/documents\/(\d+\/(content|file)|archive)$/;
