'use strict';

// Dependency-free NEF preview extraction. The original NEF Buffer is never mutated.
// extractNefPreview(Buffer) -> { jpeg, width, height, orientation, offset }
// jpegDimensions(Buffer) -> { width, height } or null for an invalid JPEG.
// A platform image decoder should still confirm decodeability before import.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const SOI = Buffer.from([0xff, 0xd8]);
const EXIF_SIGNATURE = Buffer.from('Exif\0\0', 'binary');

function parseJpeg(buffer, start = 0) {
  if (!Buffer.isBuffer(buffer) || start < 0 || start + 4 > buffer.length || buffer[start] !== 0xff || buffer[start + 1] !== 0xd8) return null;
  let cursor = start + 2;
  let width = 0, height = 0, scans = 0, entropyBytes = 0;
  const segments = [];
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0xff) return null;
    const markerStart = cursor;
    while (cursor < buffer.length && buffer[cursor] === 0xff) cursor++;
    if (cursor >= buffer.length) return null;
    const marker = buffer[cursor++];
    if (marker === 0xd9) return width && height && scans && entropyBytes ? { width, height, end: cursor, segments } : null;
    // Stuffed bytes and restart markers are only valid inside a scan.
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (marker === 0x01) continue;
    if (cursor + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(cursor);
    if (length < 2 || cursor + length > buffer.length) return null;
    const dataStart = cursor + 2;
    const end = cursor + length;
    segments.push({ marker, markerStart, dataStart, end });
    if (SOF_MARKERS.has(marker)) {
      if (length < 11) return null;
      const components = buffer[dataStart + 5];
      const nextHeight = buffer.readUInt16BE(dataStart + 1);
      const nextWidth = buffer.readUInt16BE(dataStart + 3);
      if (components < 1 || components > 4 || length !== 8 + 3 * components || !nextWidth || !nextHeight) return null;
      if (width && (nextWidth !== width || nextHeight !== height)) return null;
      width = nextWidth; height = nextHeight;
    }
    cursor = end;
    if (marker === 0xda) {
      if (!width || length < 8) return null;
      const components = buffer[dataStart];
      if (components < 1 || components > 4 || length !== 6 + 2 * components) return null;
      scans++;
      const scanStart = cursor;
      // Entropy-coded data may contain FF00, restart markers and runs of FF.
      // Only an unescaped marker ends a scan; FFD8 inside APP data is not a JPEG.
      while (cursor < buffer.length) {
        if (buffer[cursor] !== 0xff) { cursor++; continue; }
        const escapeStart = cursor;
        while (cursor < buffer.length && buffer[cursor] === 0xff) cursor++;
        if (cursor >= buffer.length) return null;
        const code = buffer[cursor];
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) { cursor++; continue; }
        entropyBytes += escapeStart - scanStart;
        cursor = escapeStart;
        break;
      }
      if (cursor >= buffer.length) return null;
    }
  }
  return null;
}

function jpegDimensions(buffer) {
  const parsed = parseJpeg(buffer);
  return parsed ? { width: parsed.width, height: parsed.height } : null;
}

function tiffReader(buffer) {
  if (buffer.length < 8) throw new Error('NEF TIFF header is incomplete');
  const order = buffer.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('NEF is not a TIFF file');
  const little = order === 'II';
  const bounds = (offset, size) => Number.isSafeInteger(offset) && offset >= 0 && offset + size <= buffer.length;
  const u16 = (offset) => { if (!bounds(offset, 2)) throw new Error('Invalid TIFF offset'); return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset); };
  const u32 = (offset) => { if (!bounds(offset, 4)) throw new Error('Invalid TIFF offset'); return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset); };
  if (u16(2) !== 42) throw new Error('Unsupported TIFF format');
  const ifd = (offset) => {
    if (!offset || !bounds(offset, 2)) return null;
    const count = u16(offset);
    if (count > 4096 || !bounds(offset + 2, count * 12 + 4)) return null;
    const entries = [];
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      entries.push({ offset: entry, tag: u16(entry), type: u16(entry + 2), count: u32(entry + 4) });
    }
    return { offset, count, entries, next: u32(offset + 2 + count * 12) };
  };
  const values = (entry) => {
    const size = entry.type === 3 ? 2 : (entry.type === 4 || entry.type === 13) ? 4 : 0;
    if (!size || entry.count > 4096) return [];
    const offset = entry.count * size <= 4 ? entry.offset + 8 : u32(entry.offset + 8);
    if (!bounds(offset, size * entry.count)) return [];
    return Array.from({ length: entry.count }, (_, index) => size === 2 ? u16(offset + index * size) : u32(offset + index * size));
  };
  return { little, u16, u32, ifd, values, root: u32(4) };
}

function nefOrientation(buffer) {
  const reader = tiffReader(buffer);
  const pending = [reader.root];
  const visited = new Set();
  while (pending.length && visited.size < 256) {
    const offset = pending.shift();
    if (!offset || visited.has(offset)) continue;
    visited.add(offset);
    const directory = reader.ifd(offset);
    if (!directory) continue;
    for (const entry of directory.entries) {
      if (entry.tag === 0x0112) {
        const orientation = reader.values(entry)[0];
        if (orientation >= 1 && orientation <= 8) return orientation;
      }
      if (entry.tag === 0x014a || entry.tag === 0x8769 || entry.tag === 0xa005) pending.push(...reader.values(entry));
    }
    if (directory.next) pending.push(directory.next);
  }
  return 1;
}

function minimalExif(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  return Buffer.concat([EXIF_SIGNATURE, tiff]);
}

function exifWithOrientation(payload, orientation) {
  if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF_SIGNATURE)) return null;
  const tiff = payload.subarray(6);
  let reader, directory;
  try { reader = tiffReader(tiff); directory = reader.ifd(reader.root); } catch { return null; }
  if (!directory) return null;
  const write16 = (target, value, offset) => reader.little ? target.writeUInt16LE(value, offset) : target.writeUInt16BE(value, offset);
  const write32 = (target, value, offset) => reader.little ? target.writeUInt32LE(value, offset) : target.writeUInt32BE(value, offset);
  const found = directory.entries.find((entry) => entry.tag === 0x0112);
  if (found) {
    const updated = Buffer.from(payload);
    const entry = 6 + found.offset;
    write16(updated, 3, entry + 2); write32(updated, 1, entry + 4);
    write16(updated, orientation, entry + 8); write16(updated, 0, entry + 10);
    return updated;
  }
  // Append a replacement IFD0, preserving all original TIFF-relative offsets.
  // Moving the old directory in place would corrupt thumbnail/Exif pointers.
  const newOffset = (tiff.length + 1) & ~1;
  const newLength = 6 + newOffset + 2 + (directory.count + 1) * 12 + 4;
  if (directory.count >= 4096 || newLength > 65533) return null;
  const updated = Buffer.alloc(newLength);
  payload.copy(updated);
  write32(updated, newOffset, 10);
  const newDirectory = 6 + newOffset;
  write16(updated, directory.count + 1, newDirectory);
  const entryData = directory.entries.map((entry) => ({ tag: entry.tag, bytes: tiff.subarray(entry.offset, entry.offset + 12) }));
  const orientationEntry = Buffer.alloc(12);
  write16(orientationEntry, 0x0112, 0); write16(orientationEntry, 3, 2);
  write32(orientationEntry, 1, 4); write16(orientationEntry, orientation, 8);
  entryData.push({ tag: 0x0112, bytes: orientationEntry });
  entryData.sort((first, second) => first.tag - second.tag);
  entryData.forEach((entry, index) => entry.bytes.copy(updated, newDirectory + 2 + index * 12));
  write32(updated, directory.next, newDirectory + 2 + entryData.length * 12);
  return updated;
}

function app1(payload) {
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function orientJpeg(jpeg, parsed, orientation) {
  for (const segment of parsed.segments) {
    if (segment.marker !== 0xe1 || !jpeg.subarray(segment.dataStart, segment.dataStart + 6).equals(EXIF_SIGNATURE)) continue;
    const updated = exifWithOrientation(jpeg.subarray(segment.dataStart, segment.end), orientation);
    if (updated) return Buffer.concat([jpeg.subarray(0, segment.markerStart), app1(updated), jpeg.subarray(segment.end)]);
  }
  return Buffer.concat([jpeg.subarray(0, 2), app1(minimalExif(orientation)), jpeg.subarray(2)]);
}

function extractNefPreview(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('extractNefPreview expects a Buffer');
  const orientation = nefOrientation(buffer);
  let best = null;
  let offset = buffer.indexOf(SOI);
  while (offset !== -1) {
    const parsed = parseJpeg(buffer, offset);
    if (parsed && (!best || parsed.width * parsed.height > best.width * best.height || (parsed.width * parsed.height === best.width * best.height && parsed.end - offset > best.end - best.offset))) best = { ...parsed, offset };
    offset = buffer.indexOf(SOI, offset + 2);
  }
  if (!best) throw new Error('NEF contains no complete supported JPEG preview');
  const original = buffer.subarray(best.offset, best.end);
  const parsed = parseJpeg(original);
  return { jpeg: orientJpeg(original, parsed, orientation), width: best.width, height: best.height, orientation, offset: best.offset };
}

module.exports = { extractNefPreview, jpegDimensions };