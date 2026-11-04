import { describe, expect, it } from "vitest";
import type { Verdict } from "../lib/verdict";
import type { DepthPhoto } from "./depth-report";
import { replayTyreArms, type RunRecord } from "./depth-tyre-arms";

const photo = (file: string, split: string): DepthPhoto & { split: string } =>
  ({ file, split, scene: "flood", captionDepth: "knee" }) as unknown as DepthPhoto & { split: string };
const measured = (low: number, high: number): Verdict => ({
  kind: "measured",
  rangeCm: { low, high },
  passability: "NPLV",
  confidence: "medium",
  readingsComplete: true,
  decidedBy: { label: "P1", landmark: "knee", interval: { low, high } },
  readingsUsed: ["P1"],
});
const knee = measured(38, 54);
const ankle = measured(5, 10);
const photos = [photo("a.jpg", "heldout"), photo("b.jpg", "heldout"), photo("c.jpg", "tuning")];
const rec = (file: string, draw: number, verdict: Verdict | null): RunRecord =>
  verdict ? { file, draw, reader: "landmark", result: { verdict } } : { file, draw, reader: "landmark", error: "Muse: timeout" };
const base = { photos, split: "heldout", draws: 2, reader: "landmark", requireComplete: true };
const full = [rec("a.jpg", 1, ankle), rec("a.jpg", 2, ankle), rec("b.jpg", 1, knee), rec("b.jpg", 2, knee)];

describe("replayTyreArms", () => {
  it("tallies both arms per scene from the same records", () => {
    const out = replayTyreArms({ ...base, records: full, replay: (r) => ({ v1: r.result.verdict, v2: knee, v2Tyres: r.file === "a.jpg" ? 1 : 0 }) });
    expect(out.tally.flood.v1).toMatchObject({ draws: 4, too_shallow: 2, matched: 2 });
    expect(out.tally.flood.v2).toMatchObject({ draws: 4, too_shallow: 0, matched: 4 });
    expect(out.photosWithTyre).toEqual({ flood: ["a.jpg"] });
  });

  it("refuses a record whose v1 replay differs from the verdict the run recorded", () => {
    expect(() => replayTyreArms({ ...base, records: full, replay: () => ({ v1: knee, v2: knee, v2Tyres: 0 }) })).toThrow(/does not reproduce/);
  });

  it("refuses a run missing a photo-draw or holding one twice", () => {
    const replay = (r: RunRecord & { result: { verdict: Verdict } }) => ({ v1: r.result.verdict, v2: r.result.verdict, v2Tyres: 0 });
    expect(() => replayTyreArms({ ...base, records: full.slice(1), replay })).toThrow(/missing 1 photo-draws: a.jpg d1/);
    expect(() => replayTyreArms({ ...base, records: [...full, rec("b.jpg", 2, knee)], replay })).toThrow(/b.jpg d2 twice/);
    expect(replayTyreArms({ ...base, requireComplete: false, records: full.slice(1), replay }).missing).toEqual(["a.jpg d1"]);
  });

  it("counts an error record as an error in both arms", () => {
    const records = [rec("a.jpg", 1, null), ...full.slice(1)];
    const out = replayTyreArms({ ...base, records, replay: (r) => ({ v1: r.result.verdict, v2: r.result.verdict, v2Tyres: 0 }) });
    expect(out.tally.flood.v1.error).toBe(1);
    expect(out.tally.flood.v2.error).toBe(1);
    expect(out.tally.flood.v2.draws).toBe(4);
  });

  it("labels a held-out replay on a split already used as exploratory", () => {
    const replay = (r: RunRecord & { result: { verdict: Verdict } }) => ({ v1: r.result.verdict, v2: r.result.verdict, v2Tyres: 0 });
    expect(replayTyreArms({ ...base, records: full, replay }).use).toMatch(/^exploratory: this split already decided the head-height candidate/);
    const tuning = replayTyreArms({ ...base, split: "tuning", requireComplete: false, records: [], replay });
    expect(tuning.use).toBe("first use");
  });
});
