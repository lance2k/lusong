import { LANDMARK_CM, type Interval, type Landmark, type Verdict } from "../lib/verdict";
import type { AcceptancePhoto, Depth } from "./acceptance-gate";

/** A photo in test/fixtures/depth-set/: an acceptance-style label whose caption always states a depth. */
export interface DepthPhoto extends AcceptancePhoto {
  captionDepth: Depth;
  /** "wading": people standing in a river, the sea or a pool rather than a flooded street. */
  scene: "flood" | "wading";
  reviewedByLance: boolean;
}

export type DepthDraw = { file: string; draw: number; verdict: Verdict } | { file: string; draw: number; error: string };

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
