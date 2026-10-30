const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const EXIF_IFD_POINTER = 0x8769;
const DATE_TIME_ORIGINAL = 0x9003;
const ASCII = 2;
const LONG = 4;

/** EXIF times carry no zone. Lusong's reporters are in the Philippines, so a capture time is read as PHT. */
const PHT_OFFSET = "+08:00";

function exifSegment(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1];
    if (marker === SOS || marker === EOI) return null;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (length < 2 || pos + 2 + length > bytes.length) return null;
    const body = bytes.subarray(pos + 4, pos + 2 + length);
    if (marker === APP1 && EXIF_HEADER.every((b, i) => body[i] === b)) return body.subarray(EXIF_HEADER.length);
    pos += 2 + length;
  }
  return null;
}

function tiffReader(tiff: Uint8Array) {
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const inside = (offset: number, size: number) => offset >= 0 && offset + size <= tiff.length;
  const u16 = (o: number) => (inside(o, 2) ? view.getUint16(o, little) : null);
  const u32 = (o: number) => (inside(o, 4) ? view.getUint32(o, little) : null);

  /** The value offset field of `tag` in the IFD at `ifd`, with its type and count. */
  function entry(ifd: number, tag: number): { type: number; count: number; valueAt: number } | null {
    const n = u16(ifd);
    if (n === null) return null;
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + 12 * i;
      if (u16(at) !== tag) continue;
      const type = u16(at + 2);
      const count = u32(at + 4);
      if (type === null || count === null) return null;
      return { type, count, valueAt: at + 8 };
    }
    return null;
  }
  return { u16, u32, entry, inside, magic: u16(2), firstIfd: u32(4) };
}

function dateTimeOriginal(tiff: Uint8Array): string | null {
  const r = tiffReader(tiff);
  if (!r || r.magic !== 42 || r.firstIfd === null) return null;
  const pointer = r.entry(r.firstIfd, EXIF_IFD_POINTER);
  if (!pointer || pointer.type !== LONG) return null;
  const exifIfd = r.u32(pointer.valueAt);
  if (exifIfd === null) return null;
  const date = r.entry(exifIfd, DATE_TIME_ORIGINAL);
  if (!date || date.type !== ASCII || date.count < 19) return null;
  const at = r.u32(date.valueAt);
  if (at === null || !r.inside(at, 19)) return null;
  return String.fromCharCode(...tiff.subarray(at, at + 19));
}

/** "YYYY:MM:DD HH:MM:SS" as PHT; anything else, or an impossible date, is null. */
export function parseExifTime(text: string): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${PHT_OFFSET}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Date rolls 2024-02-30 over into March; a real capture time round-trips.
  const back = new Date(date.getTime() + 8 * 3_600_000).toISOString();
  return back.slice(0, 19) === `${y}-${mo}-${d}T${h}:${mi}:${s}` ? date : null;
}

/**
 * The photo's EXIF DateTimeOriginal, read as Philippine time, or null when the photo has none or it is unreadable.
 * Read before lib/jpeg.ts strips the metadata.
 */
export function readCaptureTime(bytes: Uint8Array): Date | null {
  const text = readExifTimeText(bytes);
  return text === null ? null : parseExifTime(text);
}

/** The photo's EXIF DateTimeOriginal exactly as the camera wrote it, or null. */
export function readExifTimeText(bytes: Uint8Array): string | null {
  const tiff = exifSegment(bytes);
  return tiff ? dateTimeOriginal(tiff) : null;
}

const EXIF_TIME_SHAPE = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Puts a minimal EXIF segment holding only DateTimeOriginal right after SOI. The page's canvas re-encode drops all
 * metadata, GPS included; this carries the one field the server needs to judge a photo's age, and nothing else.
 */
export function withExifTime(jpeg: Uint8Array, text: string, opts: { unchecked?: boolean } = {}): Uint8Array {
  if (!opts.unchecked && !EXIF_TIME_SHAPE.test(text)) throw new Error("not an EXIF date and time");
  if (text.length !== 19) throw new Error("an EXIF date and time is 19 characters");
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== SOI) throw new Error("not a JPEG");
  // Little-endian TIFF: IFD0 at 8 points to the Exif IFD at 26, whose one entry points to the text at 44.
  const tiff = new Uint8Array(64);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49], 0);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, EXIF_IFD_POINTER, true);
  view.setUint16(12, LONG, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, DATE_TIME_ORIGINAL, true);
  view.setUint16(30, ASCII, true);
  view.setUint32(32, 20, true);
  view.setUint32(36, 44, true);
  view.setUint32(40, 0, true);
  for (let i = 0; i < 19; i++) tiff[44 + i] = text.charCodeAt(i) & 0x7f;
  const length = 2 + EXIF_HEADER.length + tiff.length;
  const segment = new Uint8Array([0xff, APP1, length >> 8, length & 0xff, ...EXIF_HEADER, ...tiff]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}
