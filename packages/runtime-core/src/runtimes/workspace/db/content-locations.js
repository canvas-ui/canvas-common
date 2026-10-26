import { availableLocations, isAvailableLocation } from 'canvas-synapsd/src/utils/document-locations.js';
/** Resolve an email attachment through its content identity after a move.
 * The per-message filename/CID/URL remain unchanged on the email record.
 * Only a URL already declared by that record can select an attachment.
 */
export async function documentContentLocations(doc, { url, getByChecksumString }) {
    if (!url) return availableLocations(doc);
    const attachment = doc?.data?.attachments?.find(item => item?.url === url);
    if (typeof attachment?.checksum === 'string' && attachment.checksum.includes('/')) {
        const file = await getByChecksumString(attachment.checksum, { parse: true, schema: 'data/schema/file' });
        if (file) return availableLocations(file);
    }
    const declared = doc?.locations?.find(location => location.url === url);
    if (declared && !isAvailableLocation(declared)) return [];
    return [{ url }];
}
