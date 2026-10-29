import sharp, { type OutputInfo } from "sharp";
import type { PlacedRaster } from "./sam";

/** The photo could not be decoded or re-encoded; the caller shows no photo. */
export class BlurError extends Error {}

/** Every mask grows by this share of its longer side, at least MIN_MARGIN_PX, to cover SAM's ragged edges. */
const MARGIN_SHARE = 0.1;
const MIN_MARGIN_PX = 6;
/**
 * Each mask is cut into blocks of a quarter of its longer side (at least MIN_BLOCK_PX), and every pixel under the
 * mask takes its block's mean. On a plate that is a block wider than one character, so no character survives as
 * a shape to match a guess against; on a person, a face is one or two blocks.
 */
const BLOCKS_ACROSS = 4;
const MIN_BLOCK_PX = 16;
const JPEG_QUALITY = 85;

/** Which pixels of the region [x0, x1) × [y0, y1) the mask covers, read at pixel centres. */
function rasterise(mask: PlacedRaster, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const width = x1 - x0;
  const grid = new Uint8Array(width * (y1 - y0));
  const { bounds } = mask;
  for (let y = Math.max(y0, Math.floor(bounds.top)); y < Math.min(y1, Math.ceil(bounds.bottom)); y++) {
    const row = Math.floor((y + 0.5 - bounds.top) / mask.scaleY);
    if (row < 0 || row >= mask.height) continue;
    for (let x = Math.max(x0, Math.floor(bounds.left)); x < Math.min(x1, Math.ceil(bounds.right)); x++) {
      const col = Math.floor((x + 0.5 - bounds.left) / mask.scaleX);
      if (col >= 0 && col < mask.width && mask.raster[row * mask.width + col]) grid[(y - y0) * width + (x - x0)] = 1;
    }
  }
  return grid;
}

/** Square dilation by `r` pixels, as two running-window passes. */
function dilate(grid: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, len: number, lines: number, at: (line: number, i: number) => number) => {
    const out = new Uint8Array(src.length);
    for (let line = 0; line < lines; line++) {
      let count = 0;
      for (let i = 0; i < Math.min(r, len); i++) count += src[at(line, i)];
      for (let i = 0; i < len; i++) {
        if (i + r < len) count += src[at(line, i + r)];
        if (i - r - 1 >= 0) count -= src[at(line, i - r - 1)];
        if (count > 0) out[at(line, i)] = 1;
      }
    }
    return out;
  };
  const across = pass(grid, width, height, (y, x) => y * width + x);
  return pass(across, height, width, (x, y) => y * width + x);
}

function pixelate(pixels: Buffer, width: number, height: number, channels: number, mask: PlacedRaster): void {
  const { bounds } = mask;
  const side = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top);
  const margin = Math.max(MIN_MARGIN_PX, Math.ceil(MARGIN_SHARE * side));
  const block = Math.max(MIN_BLOCK_PX, Math.ceil(side / BLOCKS_ACROSS));
  const x0 = Math.max(0, Math.floor(bounds.left) - margin);
  const y0 = Math.max(0, Math.floor(bounds.top) - margin);
  const x1 = Math.min(width, Math.ceil(bounds.right) + margin);
  const y1 = Math.min(height, Math.ceil(bounds.bottom) + margin);
  if (x0 >= x1 || y0 >= y1) return;
  const regionWidth = x1 - x0;
  const covered = dilate(rasterise(mask, x0, y0, x1, y1), regionWidth, y1 - y0, margin);

  const mean = new Float64Array(channels);
  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const ex = Math.min(bx + block, x1);
      const ey = Math.min(by + block, y1);
      let any = false;
      mean.fill(0);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          if (covered[(y - y0) * regionWidth + (x - x0)]) any = true;
          for (let c = 0; c < channels; c++) mean[c] += pixels[(y * width + x) * channels + c];
        }
      }
      if (!any) continue;
      const n = (ex - bx) * (ey - by);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          if (!covered[(y - y0) * regionWidth + (x - x0)]) continue;
          for (let c = 0; c < channels; c++) pixels[(y * width + x) * channels + c] = Math.round(mean[c] / n);
        }
      }
    }
  }
}

/**
 * Decodes the photo, pixelates every pixel under each mask (grown by a margin) to its block's mean, and encodes a
 * new JPEG from the pixels alone: no EXIF, XMP, ICC profile or comment, and no byte of the original file. Masks are
 * in the photo's stored pixel grid, as SAM saw it; EXIF orientation is not applied. Throws BlurError.
 */
export async function blurMasked(jpeg: Uint8Array, masks: readonly PlacedRaster[]): Promise<Uint8Array> {
  let decoded: { data: Buffer; info: OutputInfo };
  try {
    decoded = await sharp(jpeg, { failOn: "error" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new BlurError("the photo could not be decoded");
  }
  const { data, info } = decoded;
  for (const mask of masks) pixelate(data, info.width, info.height, info.channels, mask);
  try {
    const raw = { width: info.width, height: info.height, channels: info.channels };
    return new Uint8Array(await sharp(data, { raw }).jpeg({ quality: JPEG_QUALITY }).toBuffer());
  } catch {
    throw new BlurError("the blurred photo could not be encoded");
  }
}
