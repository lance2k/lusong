export class JpegError extends Error {}

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP14 = 0xee;
const COM = 0xfe;

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function hasNoLength(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

interface Segment {
  marker: number;
  start: number;
  end: number;
}

/** Walks the header segments up to (not including) the start of scan. */
function* headerSegments(bytes: Uint8Array): Generator<Segment, number> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) throw new JpegError("not a JPEG");
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw new JpegError("corrupt JPEG header");
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos];
    const start = pos - 1;
    pos++;
    if (marker === SOS) return start;
    if (hasNoLength(marker)) {
      yield { marker, start, end: pos };
      continue;
    }
    if (pos + 2 > bytes.length) throw new JpegError("truncated JPEG");
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) throw new JpegError("truncated JPEG");
    pos += length;
    yield { marker, start, end: pos };
  }
  throw new JpegError("JPEG has no image data");
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const walk = headerSegments(bytes);
  for (let step = walk.next(); !step.done; step = walk.next()) {
    const { marker, start } = step.value;
    if (isStartOfFrame(marker)) {
      const at = start + 4;
      return { height: (bytes[at + 1] << 8) | bytes[at + 2], width: (bytes[at + 3] << 8) | bytes[at + 4] };
    }
  }
  throw new JpegError("JPEG has no frame header");
}

/**
 * Drops every APPn segment except APP0 (JFIF) and APP14 (Adobe colour transform), and every
 * comment, so EXIF, GPS and XMP never leave the server even when a client skipped the canvas.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  const walk = headerSegments(bytes);
  let step = walk.next();
  for (; !step.done; step = walk.next()) {
    const { marker, start, end } = step.value;
    const isApp = marker >= APP0 && marker <= 0xef;
    const dropped = marker === COM || (isApp && marker !== APP0 && marker !== APP14);
    if (!dropped) kept.push(bytes.subarray(start, end));
  }
  kept.push(bytes.subarray(step.value));
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
