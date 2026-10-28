import { decodeMaskToSVGPath, type SegmentationMaskRecord } from "@meta-sam/parser";
import type { Box, PlacedRaster } from "./sam";

/** Source-pixel y of the bottom edge of the lowest raster row that holds any of the object. */
export function lowestRowY(p: PlacedRaster): number | null {
  for (let row = p.height - 1; row >= 0; row--) {
    const start = row * p.width;
    for (let col = 0; col < p.width; col++) {
      if (p.raster[start + col]) return p.bounds.top + (row + 1) * p.scaleY;
    }
  }
  return null;
}

function hasPixelIn(p: PlacedRaster, x0: number, x1: number, y0: number, y1: number): boolean {
  const c0 = Math.max(0, Math.floor((x0 - p.bounds.left) / p.scaleX));
  const c1 = Math.min(p.width - 1, Math.ceil((x1 - p.bounds.left) / p.scaleX));
  const r0 = Math.max(0, Math.floor((y0 - p.bounds.top) / p.scaleY));
  const r1 = Math.min(p.height - 1, Math.ceil((y1 - p.bounds.top) / p.scaleY));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (p.raster[row * p.width + col]) return true;
    }
  }
  return false;
}

/** Source-pixel x centres of the columns whose lowest filled pixel ends within `tolerance` of `y`. */
function bottomEdgeXs(p: PlacedRaster, y: number, tolerance: number): number[] {
  const xs: number[] = [];
  for (let col = 0; col < p.width; col++) {
    for (let row = p.height - 1; row >= 0; row--) {
      if (!p.raster[row * p.width + col]) continue;
      if (y - (p.bounds.top + (row + 1) * p.scaleY) <= tolerance) xs.push(p.bounds.left + (col + 0.5) * p.scaleX);
      break;
    }
  }
  return xs;
}

/**
 * Where the object's visible mask ends at the water, or null when its lowest pixels are not next
 * to any water (legs hidden by a car or wall, a person on dry ground). Only a non-null result may
 * be drawn as a waterline. "Next to" means water within the tolerance (3 % of the box height, at
 * least 3 px) of one of the object's own lowest pixels, not merely somewhere inside its box.
 */
export function waterlineY(object: PlacedRaster, box: Box, water: readonly PlacedRaster[]): number | null {
  const y = lowestRowY(object);
  if (y === null) return null;
  const tolerance = Math.max(3, 0.03 * (box.bottom - box.top));
  const touches = bottomEdgeXs(object, y, tolerance).some((x) =>
    water.some((w) => hasPixelIn(w, x - tolerance, x + tolerance, y - tolerance, y + tolerance)),
  );
  return touches ? y : null;
}

export interface PlacedPath {
  d: string;
  /** SVG transform that moves the raster-space path onto the source image. */
  transform: string;
}

/**
 * The parser's contours put pixel centres on integers (a 21-px-wide mask spans −0.5…20.5), so the
 * path is shifted half a raster pixel before scaling onto the mask's half-open source bounds.
 */
export function maskToPlacedPath(mask: SegmentationMaskRecord): PlacedPath {
  const { left, top, right, bottom } = mask.bounds;
  const sx = (right - left) / mask.mask.width;
  const sy = (bottom - top) / mask.mask.height;
  return {
    d: decodeMaskToSVGPath(mask.mask),
    transform: `translate(${left} ${top}) scale(${sx} ${sy}) translate(0.5 0.5)`,
  };
}
