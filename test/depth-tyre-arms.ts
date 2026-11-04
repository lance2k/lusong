import type { Verdict } from "../lib/verdict";
import { judgeDepthDraw, type DepthPhoto, type Outcome } from "./depth-report";

/** A record of a depth run, as `test/depth-set.test.ts` writes it to results.json. */
export interface RunRecord {
  file: string;
  draw?: number;
  reader?: string;
  sam?: string;
  result?: { verdict: Verdict } & Record<string, unknown>;
  error?: string;
}

/** What one record replays to: both geometries' verdicts from the same SAM replies and Muse readings. */
export interface ArmPair {
  v1: Verdict;
  v2: Verdict;
  /** v2 tyre estimates found in this draw (0 when the photo has no usable tyre). */
  v2Tyres: number;
}

/** The earlier evaluations each split has already decided, so a later replay on it is not a first use. */
export const PRIOR_USES: Record<string, readonly string[]> = {
  heldout: ["the head-height candidate's held-out run 2026-11-04T14-56-37-720Z (plans/depth-accuracy.md), which it failed"],
};

type Tally = Record<Outcome, number> & { draws: number };
const emptyTally = (): Tally => ({ draws: 0, too_shallow: 0, matched: 0, too_deep: 0, cannot_measure: 0, no_flood: 0, error: 0 });

const sameVerdict = (a: Verdict, b: Verdict) =>
  a.kind === b.kind &&
  (a.kind !== "measured" ||
    (b.kind === "measured" &&
      a.passability === b.passability &&
      a.decidedBy.interval.low === b.decidedBy.interval.low &&
      a.decidedBy.interval.high === b.decidedBy.interval.high));

/**
 * Both tyre geometries over one recorded run, per scene. It expects every photo of the split × every draw exactly once
 * for the reader (a missing or duplicated pair throws when `requireComplete`), counts an error record as an error in
 * both arms, and throws on a record whose v1 replay does not reproduce the verdict the run recorded, since that means
 * the replay is not reading the masks the run read.
 */
export function replayTyreArms(input: {
  photos: readonly (DepthPhoto & { split: string })[];
  split: string;
  draws: number;
  reader: string;
  records: readonly RunRecord[];
  replay: (record: RunRecord & { result: { verdict: Verdict } }, photo: DepthPhoto) => ArmPair;
  requireComplete: boolean;
}): {
  tally: Record<string, { v1: Tally; v2: Tally }>;
  missing: string[];
  photosWithTyre: Record<string, string[]>;
  use: string;
} {
  const photos = new Map(input.photos.filter((p) => p.split === input.split).map((p) => [p.file, p]));
  const seen = new Map<string, RunRecord>();
  for (const r of input.records) {
    if (r.reader !== input.reader || r.draw === undefined || !photos.has(r.file)) continue;
    const key = `${r.file} d${r.draw}`;
    if (seen.has(key)) throw new Error(`run holds ${key} twice`);
    seen.set(key, r);
  }
  const missing = [...photos.keys()].flatMap((file) =>
    Array.from({ length: input.draws }, (_, i) => `${file} d${i + 1}`).filter((key) => !seen.has(key)),
  );
  if (input.requireComplete && missing.length > 0) throw new Error(`run is missing ${missing.length} photo-draws: ${missing.join(", ")}`);

  const tally: Record<string, { v1: Tally; v2: Tally }> = {};
  const withTyre: Record<string, Set<string>> = {};
  for (const [key, r] of seen) {
    const photo = photos.get(r.file)!;
    const t = (tally[photo.scene] ??= { v1: emptyTally(), v2: emptyTally() });
    t.v1.draws++;
    t.v2.draws++;
    if (!r.result) {
      t.v1.error++;
      t.v2.error++;
      continue;
    }
    const arms = input.replay(r as RunRecord & { result: { verdict: Verdict } }, photo);
    if (!sameVerdict(arms.v1, r.result.verdict)) throw new Error(`${key}: the v1 replay does not reproduce the verdict the run recorded`);
    t.v1[judgeDepthDraw(photo, arms.v1)]++;
    t.v2[judgeDepthDraw(photo, arms.v2)]++;
    if (arms.v2Tyres > 0) (withTyre[photo.scene] ??= new Set()).add(r.file);
  }
  const prior = PRIOR_USES[input.split] ?? [];
  return {
    tally,
    missing,
    photosWithTyre: Object.fromEntries(Object.entries(withTyre).map(([scene, files]) => [scene, [...files].sort()])),
    use: prior.length === 0 ? "first use" : `exploratory: this split already decided ${prior.join("; ")}`,
  };
}
