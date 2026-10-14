/** Resolve an email attachment through its content identity after a move.
 * The per-message filename/CID/URL remain unchanged on the email record.
 * Only a URL already declared by that record can select an attachment.
 */
export async function documentContentLocations(doc, { url, getByChecksumString }) {
    if (!url) return Array.isArray(doc?.locations) ? doc.locations : [];
    const attachment = doc?.data?.attachments?.find(item => item?.url === url);
    if (typeof attachment?.checksum === 'string' && attachment.checksum.includes('/')) {
        const file = await getByChecksumString(attachment.checksum, { parse: true, schema: 'data/schema/file' });
        if (file?.locations?.length) return file.locations;
    }
    return [{ url }];
}
