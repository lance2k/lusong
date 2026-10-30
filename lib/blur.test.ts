import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BlurError, blurMasked } from "./blur";
import { readExifTimeText } from "./exif";
import type { Box, PlacedRaster } from "./sam";

const photo = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1-exif.jpg"));
/** The group of waders at the left of quiapo-1: faces, umbrellas and shirt prints, the most detail in the photo. */
const waders: Box = { left: 120, top: 400, right: 360, bottom: 560 };

function rectangle(bounds: Box, scale = 1): PlacedRaster {
  const width = Math.round((bounds.right - bounds.left) / scale);
  const height = Math.round((bounds.bottom - bounds.top) / scale);
  return { raster: new Uint8Array(width * height).fill(1), width, height, bounds, scaleX: scale, scaleY: scale };
}

interface Grey {
  data: Buffer;
  width: number;
  height: number;
}

async function grey(jpeg: Uint8Array): Promise<Grey> {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function meanAbsDiff(a: Grey, b: Grey, box: Box): number {
  let sum = 0;
  for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) sum += Math.abs(a.data[y * a.width + x] - b.data[y * b.width + x]);
  return sum / ((box.right - box.left) * (box.bottom - box.top));
}

/** Mean absolute step between neighbouring pixels: high where there are edges and texture, near 0 on a flat fill. */
function detail(g: Grey, box: Box): number {
  let sum = 0;
  let n = 0;
  for (let y = box.top; y < box.bottom - 1; y++) {
    for (let x = box.left; x < box.right - 1; x++) {
      const here = g.data[y * g.width + x];
      sum += Math.abs(here - g.data[y * g.width + x + 1]) + Math.abs(here - g.data[(y + 1) * g.width + x]);
      n += 2;
    }
  }
  return sum / n;
}

describe("blurMasked", () => {
  it("wipes the detail under a mask, leaves the rest of the photo as it was, and keeps no EXIF", async () => {
    expect(readExifTimeText(photo)).not.toBeNull();
    const out = await blurMasked(photo, [rectangle(waders)]);
    const before = await grey(photo);
    const after = await grey(out);
    expect([after.width, after.height]).toEqual([before.width, before.height]);

    expect(meanAbsDiff(before, after, waders)).toBeGreaterThan(15);
    expect(detail(after, waders)).toBeLessThan(0.25 * detail(before, waders));

    const farAway: Box = { left: 700, top: 600, right: 1200, bottom: 900 };
    expect(meanAbsDiff(before, after, farAway)).toBeLessThan(3);

    expect(readExifTimeText(out)).toBeNull();
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it("wipes a margin around the mask too, so SAM's ragged edge leaves nothing at the border", async () => {
    const before = await grey(photo);
    const after = await grey(await blurMasked(photo, [rectangle(waders)]));
    const justRight: Box = { left: waders.right, top: waders.top, right: waders.right + 6, bottom: waders.bottom };
    expect(detail(after, justRight)).toBeLessThan(0.25 * detail(before, justRight));
  });

  it("places a downscaled SAM raster on the source pixels it stands for", async () => {
    // 120 × 80 raster pixels at 2 source pixels each: the same waders box.
    const before = await grey(photo);
    const after = await grey(await blurMasked(photo, [rectangle(waders, 2)]));
    expect(detail(after, waders)).toBeLessThan(0.25 * detail(before, waders));
  });

  it("wipes only a mask's filled pixels, not its whole box", async () => {
    // A mask over the waders whose raster fills only its left half.
    const half = rectangle(waders);
    for (let row = 0; row < half.height; row++) half.raster.fill(0, row * half.width + half.width / 2, (row + 1) * half.width);
    const before = await grey(photo);
    const after = await grey(await blurMasked(photo, [half]));
    // Beyond the margin (10 % of the 240 px side is 24 px) and the edge block, the right part keeps its detail.
    const rightPart: Box = { left: 300, top: waders.top, right: waders.right, bottom: waders.bottom };
    expect(meanAbsDiff(before, after, rightPart)).toBeLessThan(3);
    expect(detail(after, { ...waders, right: 240 })).toBeLessThan(0.25 * detail(before, { ...waders, right: 240 }));
  });

  it("copies no run of the original file's bytes into the new one", async () => {
    const out = Buffer.from(await blurMasked(photo, []));
    const original = Buffer.from(photo);
    for (let at = 1024; at + 32 < original.length; at += Math.floor(original.length / 64)) {
      expect(out.indexOf(original.subarray(at, at + 32))).toBe(-1);
    }
  });

  it("re-encodes a photo with no masks without its EXIF and otherwise unchanged", async () => {
    const out = await blurMasked(photo, []);
    expect(readExifTimeText(out)).toBeNull();
    expect(meanAbsDiff(await grey(photo), await grey(out), { left: 0, top: 0, right: 1280, bottom: 960 })).toBeLessThan(3);
  });

  it("clips a mask that runs past the photo's edge", async () => {
    const before = await grey(photo);
    const edge: Box = { left: 1200, top: 900, right: 1400, bottom: 1100 };
    const after = await grey(await blurMasked(photo, [rectangle(edge)]));
    const inside: Box = { left: 1200, top: 900, right: 1280, bottom: 960 };
    expect(meanAbsDiff(before, after, inside)).toBeGreaterThan(0);
    expect(detail(after, inside)).toBeLessThan(0.25 * detail(before, inside));
  });

  it("throws BlurError on bytes that are not a photo", async () => {
    await expect(blurMasked(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), [])).rejects.toBeInstanceOf(BlurError);
  });
});
