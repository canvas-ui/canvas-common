const SIGNATURE_TYPES = new Set([
    'application/pgp-signature',
    'application/pkcs7-signature',
    'application/x-pkcs7-signature',
]);

/** Detached signatures belong to the email, not its standalone file collection.
 * Match MIME type rather than .asc/.p7s filenames: keys and other user files
 * must remain eligible for ingestion and extraction.
 */
export function isEmailSignature(attachment) {
    return SIGNATURE_TYPES.has(String(attachment?.contentType || '').split(';')[0].trim().toLowerCase());
}
