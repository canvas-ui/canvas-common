'use strict';

/**
 * `Content-Disposition: attachment` for any filename.
 *
 * A header value is latin1, so a name outside it (`Faktúra č. 12.pdf`) cannot
 * be written raw. `filename=` carries an ASCII approximation for old clients
 * and `filename*=` (RFC 5987) the exact UTF-8 name, which every current browser
 * prefers.
 */
export function attachmentDisposition(filename) {
  const name = String(filename || 'download');
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
