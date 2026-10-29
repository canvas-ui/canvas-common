import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
export const VIDEO_THUMBNAIL_MAX_BYTES = 256 * 1024 * 1024;
let active = 0;

/** Decode one local frame. Unsupported media or unavailable ffmpeg yields no poster. */
export async function renderVideoThumbnail(bytes, edge) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > VIDEO_THUMBNAIL_MAX_BYTES || active >= 2) return null;
    active++;
    let directory;
    try {
        directory = await mkdtemp(path.join(tmpdir(), 'canvas-video-thumb-'));
        const input = path.join(directory, 'source');
        await writeFile(input, bytes);
        const size = Math.max(64, Math.min(1024, Math.round(Number(edge) || 256)));
        const { stdout } = await exec('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpeg,mpegts,ogg,flv', '-threads', '1', '-i', input,
            '-an', '-sn', '-frames:v', '1', '-filter_threads', '1',
            '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
            '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
        ], { encoding: 'buffer', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        return stdout.length ? stdout : null;
    } catch { return null; }
    finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        active--;
    }
}
