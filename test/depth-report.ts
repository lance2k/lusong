import { LANDMARK_CM, PERSON_LANDMARKS, type Interval, type Landmark, type Verdict } from "../lib/verdict";
import type { AcceptancePhoto, Depth } from "./acceptance-gate";

/** A photo in test/fixtures/depth-set/: an acceptance-style label whose caption always states a depth. */
export interface DepthPhoto extends AcceptancePhoto {
  captionDepth: Depth;
  /** "wading": people standing in a river, the sea or a pool rather than a flooded street. */
  scene: "flood" | "wading";
  reviewedByLance: boolean;
}

export type DepthDraw = ({ file: string; draw: number; verdict: Verdict } | { file: string; draw: number; error: string }) & {
  /** Which reader produced it, when a run compares readers. */
  reader?: string;
};

/** test/fixtures/depth-set/split.json */
export interface DepthSplit {
  split: Record<string, "tuning" | "heldout">;
  /** Held-out photos whose earlier per-photo outcomes were read before the split was fixed. */
  exposedHeldout: string[];
}

export type Outcome = "too_shallow" | "matched" | "too_deep" | "cannot_measure" | "no_flood" | "error";

/**
 * The caption's depth word as an interval from Lusong's own landmark table, so the report measures whether the
 * model picked the right landmark, not whether the table's centimetres are right (they are UNVERIFIED estimates).
 */
const CAPTION_LANDMARK: Record<Depth, Landmark> = {
  ankle: "ankle",
  half_knee: "half_knee",
  knee: "knee",
  thigh: "mid_thigh",
  waist: "waist",
  chest: "chest",
};

/** Checked before any paid call, so a label the report cannot place never costs a run. */
export function depthManifestProblems(photos: readonly DepthPhoto[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of photos) {
    if (!Object.hasOwn(CAPTION_LANDMARK, p.captionDepth)) problems.push(`${p.file}: caption depth ${p.captionDepth} is not one the report knows`);
    if (p.scene !== "flood" && p.scene !== "wading") problems.push(`${p.file}: scene ${p.scene} is neither flood nor wading`);
    if (seen.has(p.file)) problems.push(`${p.file}: listed twice`);
    seen.add(p.file);
  }
  return problems;
}

export function captionCm(depth: Depth): Interval {
  return LANDMARK_CM[CAPTION_LANDMARK[depth] as keyof typeof LANDMARK_CM];
}

/** Compares the reading that decided the verdict (the deepest) with the caption's interval; overlap is a match. */
export function judgeDepthDraw(photo: DepthPhoto, verdict: Verdict): Exclude<Outcome, "error"> {
  if (verdict.kind === "cannot_measure") return "cannot_measure";
  if (verdict.kind === "no_flood") return "no_flood";
  const caption = captionCm(photo.captionDepth);
  const read = verdict.decidedBy.interval;
  if (read.high < caption.low) return "too_shallow";
  if (read.low > caption.high) return "too_deep";
  return "matched";
}

type Tally = { draws: number } & Record<Outcome, number>;

const emptyOutcomes = (): Record<Outcome, number> => ({ too_shallow: 0, matched: 0, too_deep: 0, cannot_measure: 0, no_flood: 0, error: 0 });

const emptyTally = (): Tally => ({ draws: 0, too_shallow: 0, matched: 0, too_deep: 0, cannot_measure: 0, no_flood: 0, error: 0 });

const OUTCOME_WORDS: Record<Outcome, string> = {
  too_shallow: "too shallow",
  matched: "matched",
  too_deep: "too deep",
  cannot_measure: "can't measure",
  no_flood: "no flood found",
  error: "error",
};

function lusongWords(d: DepthDraw): string {
  if ("error" in d) return "error";
  const v = d.verdict;
  if (v.kind === "cannot_measure") return v.reason === "too_crowded" ? "can't measure (too crowded)" : "can't measure";
  if (v.kind === "no_flood") return "no flood found";
  const tyre = v.decidedBy.landmark === "tyre_geometry" ? ` (tyre, ${v.decidedBy.label})` : "";
  return `${v.decidedBy.interval.low}–${v.decidedBy.interval.high} cm, ${v.passability}${tyre}`;
}

export function depthReport(photos: readonly DepthPhoto[], draws: readonly DepthDraw[]) {
  const byFile = new Map(photos.map((p) => [p.file, p]));
  const totals = { all: emptyTally(), flood: emptyTally(), wading: emptyTally() };
  const byDepth = new Map<Depth, Tally>();
  const rows = [...draws]
    .sort((a, b) => a.file.localeCompare(b.file) || a.draw - b.draw)
    .map((d) => {
      const photo = byFile.get(d.file);
      if (!photo) throw new Error(`${d.file} is not in the depth set`);
      const outcome: Outcome = "error" in d ? "error" : judgeDepthDraw(photo, d.verdict);
      const depthTally = byDepth.get(photo.captionDepth) ?? emptyTally();
      byDepth.set(photo.captionDepth, depthTally);
      for (const tally of [totals.all, totals[photo.scene], depthTally]) {
        tally.draws++;
        tally[outcome]++;
      }
      return { file: d.file, draw: d.draw, scene: photo.scene, captionDepth: photo.captionDepth, captionCm: captionCm(photo.captionDepth), lusong: lusongWords(d), outcome };
    });

  const tallyLine = (name: string, t: Tally) =>
    `| ${name} | ${t.draws} | ${t.too_shallow} | ${t.matched} | ${t.too_deep} | ${t.cannot_measure} | ${t.no_flood} | ${t.error} |`;
  const markdown = [
    "| Draws | n | too shallow | matched | too deep | can't measure | no flood | error |",
    "|---|---|---|---|---|---|---|---|",
    tallyLine("all", totals.all),
    tallyLine("flood scenes", totals.flood),
    tallyLine("wading scenes", totals.wading),
    ...[...byDepth].map(([depth, t]) => tallyLine(`caption: ${depth}`, t)),
    "",
    "| Photo | Draw | Caption | Lusong (deciding reading, class) | Outcome |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.file} | ${r.draw} | ${r.captionDepth} (${r.captionCm.low}–${r.captionCm.high} cm) | ${r.lusong} | ${OUTCOME_WORDS[r.outcome]} |`),
  ].join("\n");
  return { rows, totals, byDepth: Object.fromEntries(byDepth), markdown };
}

/**
 * How far the deciding interval sits from the caption's, in cm: negative when too shallow, positive when too deep, 0
 * when they overlap. Overlap alone rewards wide deep landmarks (chest overlaps a waist caption), so the report shows
 * this beside it.
 */
export function gapCm(photo: DepthPhoto, verdict: Verdict): number | null {
  if (verdict.kind !== "measured") return null;
  const caption = captionCm(photo.captionDepth);
  const read = verdict.decidedBy.interval;
  if (read.high < caption.low) return read.high - caption.low;
  if (read.low > caption.high) return read.low - caption.high;
  return 0;
}

/** Steps along the person landmarks from the caption's to the deciding one; null when a vehicle reading decided. */
export function rankError(photo: DepthPhoto, verdict: Verdict): number | null {
  if (verdict.kind !== "measured") return null;
  const read = PERSON_LANDMARKS.indexOf(verdict.decidedBy.landmark as (typeof PERSON_LANDMARKS)[number]);
  if (read < 0) return null;
  return read - PERSON_LANDMARKS.indexOf(CAPTION_LANDMARK[photo.captionDepth] as (typeof PERSON_LANDMARKS)[number]);
}

export type Group = "all" | "flood" | "wading" | "tuning flood" | "held-out flood" | "held-out flood, unexposed" | "held-out" | "tuning";

/** The groups a photo is counted in. "unexposed" leaves out held-out photos whose old outcomes were read before the split. */
export function groupsOf(photo: DepthPhoto, split: DepthSplit): Group[] {
  const side = split.split[photo.file];
  if (!side) throw new Error(`${photo.file} is not in the split`);
  const groups: Group[] = ["all", photo.scene, side === "heldout" ? "held-out" : "tuning"];
  if (photo.scene === "flood") {
    groups.push(side === "heldout" ? "held-out flood" : "tuning flood");
    if (side === "heldout" && !split.exposedHeldout.includes(photo.file)) groups.push("held-out flood, unexposed");
  }
  return groups;
}

export interface GroupTally {
  draws: number;
  outcomes: Record<Outcome, number>;
  /** Over measured draws: the mean signed gap and the mean absolute gap in cm, and how many were measured. */
  measured: number;
  meanGapCm: number | null;
  meanAbsGapCm: number | null;
  /** Mean signed landmark-rank error over draws a person reading decided. */
  meanRankError: number | null;
}

export function outcomeOf(photo: DepthPhoto, d: DepthDraw): Outcome {
  return "error" in d ? "error" : judgeDepthDraw(photo, d.verdict);
}

export function groupTallies(photos: readonly DepthPhoto[], draws: readonly DepthDraw[], split: DepthSplit): Map<Group, GroupTally> {
  const byFile = new Map(photos.map((p) => [p.file, p]));
  const acc = new Map<Group, { draws: number; outcomes: Record<Outcome, number>; gaps: number[]; ranks: number[] }>();
  for (const d of draws) {
    const photo = byFile.get(d.file);
    if (!photo) throw new Error(`${d.file} is not in the depth set`);
    const outcome = outcomeOf(photo, d);
    const gap = "error" in d ? null : gapCm(photo, d.verdict);
    const rank = "error" in d ? null : rankError(photo, d.verdict);
    for (const g of groupsOf(photo, split)) {
      const a = acc.get(g) ?? { draws: 0, outcomes: emptyOutcomes(), gaps: [], ranks: [] };
      acc.set(g, a);
      a.draws++;
      a.outcomes[outcome]++;
      if (gap !== null) a.gaps.push(gap);
      if (rank !== null) a.ranks.push(rank);
    }
  }
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 10) / 10 : null);
  return new Map(
    [...acc].map(([g, a]) => [
      g,
      {
        draws: a.draws,
        outcomes: a.outcomes,
        measured: a.gaps.length,
        meanGapCm: mean(a.gaps),
        meanAbsGapCm: mean(a.gaps.map(Math.abs)),
        meanRankError: mean(a.ranks),
      },
    ]),
  );
}

/** Old outcome → new outcome for the same photo and draw (the same SAM replies when the run compared readers). */
export function transitions(
  photos: readonly DepthPhoto[],
  before: readonly DepthDraw[],
  after: readonly DepthDraw[],
  keep: (photo: DepthPhoto) => boolean = () => true,
): Record<string, number> {
  const byFile = new Map(photos.map((p) => [p.file, p]));
  const afterByKey = new Map(after.map((d) => [`${d.file}#${d.draw}`, d]));
  const counts: Record<string, number> = {};
  for (const b of before) {
    const photo = byFile.get(b.file);
    const a = afterByKey.get(`${b.file}#${b.draw}`);
    if (!photo || !a || !keep(photo)) continue;
    const key = `${outcomeOf(photo, b)} → ${outcomeOf(photo, a)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The harness's own spending gate: a draw starts only when what has been spent plus the worst case of every draw in
 * flight, its own included, stays within the cap. Settling replaces a draw's reserve with its metered cost.
 */
export class SpendCap {
  private spent = 0;
  private reserved = 0;

  constructor(readonly capMicros: number) {}

  tryReserve(micros: number): boolean {
    if (this.spent + this.reserved + micros > this.capMicros) return false;
    this.reserved += micros;
    return true;
  }

  /** `actualMicros` is the metered cost; when the meter is incomplete the caller passes the reserve instead. */
  settle(reservedMicros: number, actualMicros: number): void {
    this.reserved -= reservedMicros;
    this.spent += actualMicros;
  }

  get spentMicros(): number {
    return this.spent;
  }
}
