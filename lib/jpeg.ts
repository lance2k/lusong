export class JpegError extends Error {}

const SOI = 0xd8;
const EOI = 0xd9;
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

function isDropped(marker: number): boolean {
  const isApp = marker >= APP0 && marker <= 0xef;
  return marker === COM || (isApp && marker !== APP0 && marker !== APP14);
}

type Part =
  | { type: "marker"; marker: number; start: number; lengthAt: number; end: number }
  | { type: "scan"; start: number; end: number };

/**
 * Walks every marker segment and every scan's entropy-coded data up to EOI, so segments between
 * scans of a progressive JPEG are seen too. Throws on anything malformed, or no EOI.
 */
function* walkJpeg(bytes: Uint8Array): Generator<Part> {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) throw new JpegError("not a JPEG");
  let pos = 2;
  for (;;) {
    if (pos >= n || bytes[pos] !== 0xff) throw new JpegError("corrupt or truncated JPEG");
    const start = pos;
    while (pos < n && bytes[pos] === 0xff) pos++;
    if (pos >= n) throw new JpegError("truncated JPEG");
    const marker = bytes[pos++];
    if (marker === EOI) {
      yield { type: "marker", marker, start, lengthAt: pos, end: pos };
      return;
    }
    if (hasNoLength(marker)) {
      yield { type: "marker", marker, start, lengthAt: pos, end: pos };
      continue;
    }
    if (pos + 2 > n) throw new JpegError("truncated JPEG");
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > n) throw new JpegError("truncated JPEG");
    const lengthAt = pos;
    pos += length;
    yield { type: "marker", marker, start, lengthAt, end: pos };

    if (marker === SOS) {
      const scanStart = pos;
      while (pos < n) {
        if (bytes[pos] !== 0xff || pos + 1 >= n) {
          pos++;
          continue;
        }
        const next = bytes[pos + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) pos += 2;
        else if (next === 0xff) pos += 1;
        else break;
      }
      yield { type: "scan", start: scanStart, end: pos };
    }
  }
}

/**
 * Validates an uploaded JPEG and rebuilds it without metadata: every APPn segment except APP0
 * (JFIF) and APP14 (Adobe colour transform), every comment, and anything after EOI are dropped,
 * so EXIF, GPS and XMP never leave the server even when a client skipped the canvas.
 */
export function sanitizeJpeg(bytes: Uint8Array): { width: number; height: number; bytes: Uint8Array } {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let size: { width: number; height: number } | null = null;
  for (const part of walkJpeg(bytes)) {
    if (part.type === "marker" && isStartOfFrame(part.marker) && size === null) {
      const at = part.lengthAt;
      if (part.end - at < 8) throw new JpegError("JPEG frame header too short");
      const height = (bytes[at + 3] << 8) | bytes[at + 4];
      const width = (bytes[at + 5] << 8) | bytes[at + 6];
      if (width === 0 || height === 0) throw new JpegError("JPEG has no size");
      size = { width, height };
    }
    if (part.type === "marker" && isDropped(part.marker)) continue;
    kept.push(bytes.subarray(part.start, part.end));
  }
  if (size === null) throw new JpegError("JPEG has no frame header");

  const out = new Uint8Array(kept.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of kept) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { ...size, bytes: out };
}
