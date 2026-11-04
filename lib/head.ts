import { waterlineY } from "./overlay";
import { placeRaster, type Box, type PlacedRaster, type SamObject } from "./sam";
import type { Interval } from "./verdict";

/** UNVERIFIED: an adult stands 7 to 8 head-heights tall (crown to chin), the usual figure-drawing canon. */
const HEADS_PER_STATURE = { low: 7, high: 8 };
/** The same adult stature range as the landmark table (lib/verdict.ts). */
const STATURE_CM: Interval = { low: 145, high: 180 };
/** UNVERIFIED: below this a head's mask is a few pixels of hair and face, and one pixel moves the count by over 6 %. */
const MIN_HEAD_PX = 16;

/**
 * How deep the water stands on a person, from how many of their own head-heights show above it. Everything below
 * the visible body is taken as water, so a stooping person or a hat reads deeper, never shallower. Null when the head
 * is too small or more than a whole body shows.
 */
export function headDepthCm(visiblePx: number, headPx: number): Interval | null {
  if (headPx < MIN_HEAD_PX || visiblePx <= headPx) return null;
  const heads = visiblePx / headPx;
  const high = Math.ceil(Math.max(0, 1 - heads / HEADS_PER_STATURE.high) * STATURE_CM.high);
  if (high <= 0) return null;
  const low = Math.floor(Math.max(0, 1 - heads / HEADS_PER_STATURE.low) * STATURE_CM.low);
  return { low, high };
}

const contains = (box: Box, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/**
 * One estimate per person whose mask meets the water, from the head SAM found at the top of that person's box. A head
 * belongs to a person when its centre lies in the top third of their box and its top within half a head of the box's
 * top; the nearest such head wins. A person whose box starts at the photo's top edge may have lost their crown to the
 * frame and gets none.
 */
export function headEstimates(
  people: readonly { label: string; box: Box; mask: PlacedRaster }[],
  heads: readonly SamObject[],
  water: readonly PlacedRaster[],
): { label: string; interval: Interval; heads: number }[] {
  return people.flatMap((p) => {
    const { box } = p;
    if (box.top <= 1) return [];
    const height = box.bottom - box.top;
    const head = heads
      .map((h) => h.box)
      .filter((h) => {
        const hh = h.bottom - h.top;
        return contains({ ...box, bottom: box.top + height / 3 }, (h.left + h.right) / 2, (h.top + h.bottom) / 2) && Math.abs(h.top - box.top) <= hh / 2;
      })
      .sort((a, b) => Math.abs(a.top - box.top) - Math.abs(b.top - box.top))[0];
    if (!head) return [];
    const line = waterlineY(p.mask, box, water);
    if (line === null) return [];
    const headPx = head.bottom - head.top;
    const interval = headDepthCm(line - box.top, headPx);
    return interval ? [{ label: p.label, interval, heads: Math.round(((line - box.top) / headPx) * 10) / 10 }] : [];
  });
}

