import { messageError } from './outbox.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Only embedded bytes, never URLs/paths supplied by a caller. */
export function messageImages(input = []) {
    if (!Array.isArray(input) || input.length > 8) throw messageError('Up to 8 pictures are allowed');
    let total = 0;
    return input.map((image, index) => {
        if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
            || typeof image.base64 !== 'string' || image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) throw messageError('Invalid picture data');
        const content = Buffer.from(image.base64, 'base64');
        const hex = content.subarray(0, 12).toString('hex');
        const valid = image.mimeType === 'image/png' ? hex.startsWith('89504e470d0a1a0a')
            : image.mimeType === 'image/jpeg' ? hex.startsWith('ffd8ff')
            : image.mimeType === 'image/gif' ? /^(474946383761|474946383961)/.test(hex)
            : hex.startsWith('52494646') && hex.slice(16) === '57454250';
        total += content.length;
        if (!valid || total > MAX_IMAGE_BYTES) throw messageError('Pictures must be valid images and total at most 8 MB');
        return { content, contentType: image.mimeType, filename: String(image.name || `picture-${index + 1}`).replace(/[\r\n/\\]/g, '_').slice(0, 200), cid: `canvas-picture-${index}` };
    });
}
