import { waterCut, waterlineY } from "./overlay";
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

/**
 * Which tyre geometry the check runs. "v1" is the shipped one (`tyreDepthCm`, tyres inside a car box). "v2" is the
 * candidate in plans/depth-tyre.md (`tyreEstimatesV2`), which ships only if it passes that plan's frozen criteria.
 */
export const TYRE_GEOMETRY: "v1" | "v2" = "v1";

/**
 * UNVERIFIED which sizes are in any photo: arithmetic on the ISO size code (rim inches × 2.54 + 2 × section width ×
 * aspect ratio). Cars: 155/80R13 ≈ 57.8 cm to 205/55R16 ≈ 63.2 cm, larger SUV sizes past 70; v1's 58–70 holds the
 * plan's 60–65. A tyre outside every car box belongs to an unknown vehicle, so its range runs from a 70/90-14 scooter
 * tyre (≈ 48.2 cm, rounded down to 45) to the car high. The verdict reads the high bound either way.
 */
export const CAR_TYRE_CM: Interval = TYRE_DIAMETER_CM;
export const UNKNOWN_TYRE_CM: Interval = { low: 45, high: 70 };
/** Below this cap height, or a fifth of the chord, one pixel of mask error moves the circle's radius by over a fifth. */
const MIN_CAP_PX = 6;
const MIN_CAP_PER_CHORD = 0.2;
/** At least this share of the cut edge's columns must have water at them; the rest may be a leg, a kerb or a wave. */
const MIN_WET_SHARE = 0.5;
/** UNVERIFIED: a whole dry tyre on the same car squashed past this shows a view from above or below, not side-on. */
const SIDE_ON_RATIO = { low: 0.85, high: 1.15 };

/**
 * v2: the fraction of a round tyre's diameter under water, from its visible cap, and that fraction of the tyre's
 * assumed diameter in cm. With half or more showing, the widest width is the diameter. With less, the chord (the cut
 * edge's measured width, never wider than the box) and cap height give the circle: R = (w²/4 + h²) / 2h. Null when
 * the tyre is too small, taller than wide (angled), shows nothing hidden, or its cap is too flat to fix a radius.
 */
export function tyreCapDepth(
  visible: { width: number; height: number; chord: number },
  diameterCm: Interval = CAR_TYRE_CM,
): { fraction: number; interval: Interval } | null {
  const { width, height } = visible;
  const chord = Math.min(visible.chord, width);
  if (width < MIN_TYRE_WIDTH_PX || height <= 0 || height > width * MAX_HEIGHT_PER_WIDTH) return null;
  let diameter = width;
  if (height < width / 2) {
    if (height < Math.max(MIN_CAP_PX, MIN_CAP_PER_CHORD * chord)) return null;
    diameter = (chord * chord) / 4 / height + height;
  }
  const fraction = (diameter - height) / diameter;
  if (fraction <= 0) return null;
  return { fraction, interval: { low: Math.floor(fraction * diameterCm.low), high: Math.ceil(fraction * diameterCm.high) } };
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
  options: { geometry?: "v1" | "v2" } = {},
): { label: string; interval: Interval }[] {
  if ((options.geometry ?? TYRE_GEOMETRY) === "v2") {
    return tyreEstimatesV2(cars, tyres.map((t) => ({ box: t.box, mask: placeRaster(t.mask) })), water).map(({ label, interval }) => ({ label, interval }));
  }
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

/**
 * v2: one estimate per car from the deepest of its tyres cut by water, and one per cut tyre outside every car box
 * (labelled T1, T2… in SAM's order). A tyre counts only when at least half its cut edge lies on SAM's water; a car with
 * a whole dry tyre that is not round is seen at an angle and gives none.
 */
export function tyreEstimatesV2(
  cars: readonly { label: string; box: Box }[],
  tyres: readonly { box: Box; mask: PlacedRaster }[],
  water: readonly PlacedRaster[],
): { label: string; fraction: number; interval: Interval }[] {
  const owner = (box: Box) =>
    cars
      .filter((c) => contains(c.box, (box.left + box.right) / 2, (box.top + box.bottom) / 2))
      .sort((a, b) => area(a.box) - area(b.box))[0]?.label ?? null;
  const measured = tyres.map((t) => ({ ...t, car: owner(t.box), cut: waterCut(t.mask, t.box, water) }));
  const angled = new Set(
    measured
      .filter((t) => t.car !== null && waterlineY(t.mask, t.box, water) === null)
      .filter((t) => {
        const ratio = (t.box.bottom - t.box.top) / (t.box.right - t.box.left);
        return ratio < SIDE_ON_RATIO.low || ratio > SIDE_ON_RATIO.high;
      })
      .map((t) => t.car),
  );
  const deepest = new Map<string, { fraction: number; interval: Interval }>();
  let unboxed = 0;
  const loose: { label: string; fraction: number; interval: Interval }[] = [];
  for (const t of measured) {
    if (t.car === null) unboxed += 1;
    if (!t.cut || t.cut.wetShare < MIN_WET_SHARE || (t.car !== null && angled.has(t.car))) continue;
    const estimate = tyreCapDepth(
      { width: t.box.right - t.box.left, height: t.box.bottom - t.box.top, chord: t.cut.chordPx },
      t.car === null ? UNKNOWN_TYRE_CM : CAR_TYRE_CM,
    );
    if (!estimate) continue;
    if (t.car === null) {
      loose.push({ label: `T${unboxed}`, ...estimate });
      continue;
    }
    const known = deepest.get(t.car);
    if (!known || estimate.interval.high > known.interval.high) deepest.set(t.car, estimate);
  }
  return [
    ...cars.flatMap((c) => {
      const e = deepest.get(c.label);
      return e ? [{ label: c.label, ...e }] : [];
    }),
    ...loose,
  ];
}
