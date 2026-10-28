export const PERSON_LANDMARKS = [
  "ankle",
  "half_knee",
  "below_knee",
  "knee",
  "mid_thigh",
  "hip",
  "waist",
  "chest",
] as const;
export const TYRE_LANDMARKS = [
  "tyre_quarter",
  "tyre_half",
  "tyre_three_quarter",
  "tyre_full",
  "above_tyre",
] as const;

export type PersonLandmark = (typeof PERSON_LANDMARKS)[number];
export type TyreLandmark = (typeof TYRE_LANDMARKS)[number];
export type Landmark = PersonLandmark | TyreLandmark | "not_visible";
export type ObjectKind = "person" | "car";

export interface Interval {
  low: number;
  high: number;
}

/**
 * Water depth in cm implied by the waterline sitting at each landmark.
 * UNVERIFIED: rows without an MMDA anchor are estimates from adult stature 145–180 cm and
 * passenger-car tyres 58–70 cm across; the labelled test set (plan slice 3) measures them.
 * MMDA anchors: half-knee 25, knee 48, waist 94, chest 114, half tire 33, tire 66.
 */
export const LANDMARK_CM: Record<PersonLandmark | TyreLandmark, Interval> = {
  ankle: { low: 5, high: 10 },
  half_knee: { low: 18, high: 27 },
  below_knee: { low: 30, high: 45 },
  knee: { low: 38, high: 54 },
  mid_thigh: { low: 50, high: 72 },
  hip: { low: 65, high: 86 },
  waist: { low: 84, high: 112 },
  chest: { low: 100, high: 133 },
  tyre_quarter: { low: 13, high: 20 },
  tyre_half: { low: 27, high: 39 },
  tyre_three_quarter: { low: 40, high: 55 },
  tyre_full: { low: 55, high: 75 },
  above_tyre: { low: 66, high: 140 },
};

export type Passability = "PATV" | "NPLV" | "NPATV";
export type Confidence = "low" | "medium" | "high";

export interface GaugeRow {
  inches: number;
  cm: number;
  name: string;
  passability: Passability;
}

/** The MMDA flood gauge, as quoted in strategy.md §6c (topgear.com.ph, 2024-07-16). */
export const MMDA_GAUGE: readonly GaugeRow[] = [
  { inches: 8, cm: 20, name: "Gutter deep", passability: "PATV" },
  { inches: 10, cm: 25, name: "Half-knee deep", passability: "PATV" },
  { inches: 13, cm: 33, name: "Half tire deep", passability: "NPLV" },
  { inches: 19, cm: 48, name: "Knee deep", passability: "NPLV" },
  { inches: 26, cm: 66, name: "Tire deep", passability: "NPATV" },
  { inches: 37, cm: 94, name: "Waist deep", passability: "NPATV" },
  { inches: 45, cm: 114, name: "Chest deep", passability: "NPATV" },
];

export interface Reading {
  label: string;
  kind: ObjectKind;
  inWater: boolean;
  landmark: Landmark;
  isChild: boolean;
}

export type Verdict =
  | {
      kind: "measured";
      rangeCm: Interval;
      /**
       * "unsure" replaces PATV when confidence is low or the reading set is incomplete: missing
       * readings can only hide a deeper spot, so PATV is the one class they can make wrong.
       */
      passability: Passability | "unsure";
      confidence: Confidence;
      readingsComplete: boolean;
      /** The reading whose interval set the upper bound. */
      decidedBy: { label: string; landmark: PersonLandmark | TyreLandmark; interval: Interval };
      readingsUsed: string[];
    }
  | { kind: "cannot_measure" }
  | { kind: "no_flood" };

export function passabilityFor(upperCm: number): Passability {
  if (upperCm < 33) return "PATV";
  if (upperCm < 66) return "NPLV";
  return "NPATV";
}

export function landmarkFitsKind(landmark: Landmark, kind: ObjectKind): boolean {
  if (kind === "person") return (PERSON_LANDMARKS as readonly string[]).includes(landmark);
  return (TYRE_LANDMARKS as readonly string[]).includes(landmark);
}

export function isUsable(r: Reading): boolean {
  if (!r.inWater || r.landmark === "not_visible") return false;
  if (r.kind === "person" && r.isChild) return false;
  return landmarkFitsKind(r.landmark, r.kind);
}

function confidenceFor(count: number, width: number): Confidence {
  if (count >= 3 && width <= 25) return "high";
  if (count >= 2 && width <= 40) return "medium";
  return "low";
}

/** Gauge rows inside an interval; when none fall inside, the nearest row on each side. */
export function gaugeRowsFor(interval: Interval): { within: GaugeRow[]; below: GaugeRow | null; above: GaugeRow | null } {
  const within = MMDA_GAUGE.filter((row) => row.cm >= interval.low && row.cm <= interval.high);
  if (within.length > 0) return { within, below: null, above: null };
  return {
    within,
    below: [...MMDA_GAUGE].reverse().find((row) => row.cm < interval.low) ?? null,
    above: MMDA_GAUGE.find((row) => row.cm > interval.high) ?? null,
  };
}

export function decideVerdict(input: {
  readings: readonly Reading[];
  /** False when the model skipped, duplicated or mis-kinded any object it was asked about. */
  readingsComplete: boolean;
  waterFound: boolean;
  modelSaysFlooded: boolean;
}): Verdict {
  const usable = input.readings.filter(isUsable);
  if (usable.length === 0) {
    return !input.waterFound && !input.modelSaysFlooded ? { kind: "no_flood" } : { kind: "cannot_measure" };
  }

  const measured = usable.map((r) => {
    const landmark = r.landmark as PersonLandmark | TyreLandmark;
    return { label: r.label, landmark, interval: LANDMARK_CM[landmark] };
  });
  const deepest = measured.reduce((a, b) => (b.interval.high > a.interval.high ? b : a));
  const rangeCm = { low: Math.min(...measured.map((m) => m.interval.low)), high: deepest.interval.high };
  const confidence = confidenceFor(usable.length, rangeCm.high - rangeCm.low);
  const cls = passabilityFor(rangeCm.high);

  const doubtful = confidence === "low" || !input.readingsComplete;
  return {
    kind: "measured",
    rangeCm,
    passability: cls === "PATV" && doubtful ? "unsure" : cls,
    confidence,
    readingsComplete: input.readingsComplete,
    decidedBy: deepest,
    readingsUsed: usable.map((r) => r.label),
  };
}
