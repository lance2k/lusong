import { waterlineY } from "./overlay";
import { placeRaster, type Box, type PlacedRaster, type SamObject } from "./sam";
import type { Interval } from "./verdict";

/** UNVERIFIED: a passenger-car tyre's outer diameter (plan line 115); a 155/80R13 is about 58 cm, SUVs exceed 70. */
const TYRE_DIAMETER_CM: Interval = { low: 58, high: 70 };
/** UNVERIFIED: below this width one pixel of mask error moves the estimate by more than about 6 %. */
const MIN_TYRE_WIDTH_PX = 16;
/**
 * UNVERIFIED: a wheel seen side-on is round, so its mask is never much taller than wide. A taller one is seen at an
 * angle, its width is foreshortened and is not the diameter. 6 of Shah Alam's 8 tyre masks are 1.3–3.8 times taller.
 * This rejects some angled wheels; it cannot prove a wheel is side-on (a 40 × 80 px ellipse 60 % under water leaves
 * a 40 × 32 box and reads about 11–14 cm instead of 34–42). So the estimate is only ever allowed to deepen the verdict.
 */
const MAX_HEIGHT_PER_WIDTH = 1.1;

/**
 * How deep the water stands on a tyre whose mask is cut by the waterline. With half or more showing, the widest
 * part is the diameter; with less, the visible width is a chord and the diameter comes from the cap's height. Null
 * when the tyre is too small, seen at an angle, or shows nothing hidden (a dry side-on tyre and an angled one half
 * under water both leave a round box). All the hidden height is taken as water, so a top hidden by the wheel arch
 * reads deeper, never shallower. Rounded outwards to whole centimetres.
 */
export function tyreDepthCm(visible: { width: number; height: number }): Interval | null {
  const { width, height } = visible;
  if (width < MIN_TYRE_WIDTH_PX || height <= 0 || height > width * MAX_HEIGHT_PER_WIDTH) return null;
  const diameter = height >= width / 2 ? width : (width * width) / 4 / height + height;
  const hiddenShare = (diameter - height) / diameter;
  if (hiddenShare <= 0) return null;
  return { low: Math.floor(hiddenShare * TYRE_DIAMETER_CM.low), high: Math.ceil(hiddenShare * TYRE_DIAMETER_CM.high) };
}

const contains = (box: Box, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
const area = (box: Box) => (box.right - box.left) * (box.bottom - box.top);

/**
 * One estimate per car, from the deepest of its tyres that touch the water. A tyre belongs to the smallest car box
 * holding its centre (UNVERIFIED: in a jam a far car's tyre can sit inside a near car's box), and to no car otherwise.
 */
export function tyreEstimates(
  cars: readonly { label: string; box: Box }[],
  tyres: readonly SamObject[],
  water: readonly PlacedRaster[],
): { label: string; interval: Interval }[] {
  const deepest = new Map<string, Interval>();
  for (const tyre of tyres) {
    const { box } = tyre;
    const car = cars
      .filter((c) => contains(c.box, (box.left + box.right) / 2, (box.top + box.bottom) / 2))
      .sort((a, b) => area(a.box) - area(b.box))[0];
    if (!car || waterlineY(placeRaster(tyre.mask), box, water) === null) continue;
    const interval = tyreDepthCm({ width: box.right - box.left, height: box.bottom - box.top });
    const known = deepest.get(car.label);
    if (interval && (!known || interval.high > known.high)) deepest.set(car.label, interval);
  }
  return cars.flatMap((c) => {
    const interval = deepest.get(c.label);
    return interval ? [{ label: c.label, interval }] : [];
  });
}
