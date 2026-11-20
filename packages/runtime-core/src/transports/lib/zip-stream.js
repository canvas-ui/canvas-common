'use strict';

import { crc32 } from 'node:zlib';

/**
 * A zip archive written as it is read: entries are stored uncompressed and
 * their size and checksum follow the bytes (data descriptor), so nothing is
 * buffered or read twice. Classic zip only, no zip64: the caller keeps an
 * archive under ZIP_MAX_BYTES and ZIP_MAX_ENTRIES.
 */
export const ZIP_MAX_BYTES = 0xffffffff;
export const ZIP_MAX_ENTRIES = 0xffff;

// Bit 3: sizes and crc follow the data. Bit 11: the name is UTF-8.
const FLAGS = 0x0808;
const VERSION = 20;

function dosDateTime(date) {
  const d = date instanceof Date && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {AsyncIterable<{name: string, mtime?: Date, content: Buffer|AsyncIterable<Buffer>}>|Iterable} entries
 *   `content` is read while the entry is written, so a lazily produced entry
 *   holds its source open only for its own turn.
 * @yields {Buffer} archive bytes
 */
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;

  for await (const entry of entries) {
    if (central.length >= ZIP_MAX_ENTRIES) throw new Error(`A zip archive holds at most ${ZIP_MAX_ENTRIES} files`);
    const name = Buffer.from(entry.name, 'utf-8');
    const { time, date } = dosDateTime(entry.mtime);
    const start = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local; yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    const chunks = Buffer.isBuffer(entry.content) ? [entry.content] : entry.content;
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32(bytes, crc);
      size += bytes.length;
      yield bytes;
    }
    offset += size;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;
    if (offset > ZIP_MAX_BYTES) throw new Error('A zip archive holds at most 4 GiB');

    central.push({ name, time, date, crc, size, start });
  }

  const directoryStart = offset;
  for (const file of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(FLAGS, 8);
    header.writeUInt16LE(file.time, 12);
    header.writeUInt16LE(file.date, 14);
    header.writeUInt32LE(file.crc, 16);
    header.writeUInt32LE(file.size, 20);
    header.writeUInt32LE(file.size, 24);
    header.writeUInt16LE(file.name.length, 28);
    header.writeUInt32LE(file.start, 42);
    yield header; yield file.name;
    offset += header.length + file.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  yield end;
}
