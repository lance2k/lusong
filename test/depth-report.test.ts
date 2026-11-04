import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Verdict } from "../lib/verdict";
import {
  depthManifestProblems,
  depthReport,
  gapCm,
  groupsOf,
  groupTallies,
  judgeDepthDraw,
  rankError,
  SpendCap,
  transitions,
  type DepthPhoto,
  type DepthSplit,
} from "./depth-report";

const photo = (file: string, captionDepth: DepthPhoto["captionDepth"], scene: DepthPhoto["scene"] = "flood"): DepthPhoto => ({
  file,
  source: `https://commons.wikimedia.org/wiki/File:${file}`,
  licence: "CC0",
  author: "someone",
  caption: `${captionDepth}-deep`,
  captionDepth,
  refs: 2,
  expect: "not_patv",
  scene,
  reviewedByLance: false,
});

const deciding = (low: number, high: number, passability: "shallow" | "unsure" | "NPLV" | "NPATV" = "NPLV"): Verdict => ({
  kind: "measured",
  rangeCm: { low, high },
  passability,
  confidence: "medium",
  readingsComplete: true,
  decidedBy: { label: "P1", landmark: "knee", interval: { low, high } },
  readingsUsed: ["P1", "P2"],
});

describe("judgeDepthDraw: the deciding reading against the caption's depth", () => {
  it("a knee caption read at the ankle is too shallow", () => {
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(5, 10, "shallow"))).toBe("too_shallow");
  });

  it("a knee caption read mid-thigh overlaps it, so it matches", () => {
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(50, 72))).toBe("matched");
  });

  it("a knee caption read at the waist is too deep", () => {
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(84, 112, "NPATV"))).toBe("too_deep");
  });

  it("a reading that only touches the caption's interval at an end still matches", () => {
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(30, 38))).toBe("matched");
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(54, 60))).toBe("matched");
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(30, 37))).toBe("too_shallow");
    expect(judgeDepthDraw(photo("a.jpg", "knee"), deciding(55, 60))).toBe("too_deep");
  });

  it("'can't measure', including too crowded, and 'no flood' are their own outcomes", () => {
    expect(judgeDepthDraw(photo("a.jpg", "waist"), { kind: "cannot_measure" })).toBe("cannot_measure");
    expect(judgeDepthDraw(photo("a.jpg", "waist"), { kind: "cannot_measure", reason: "too_crowded" })).toBe("cannot_measure");
    expect(judgeDepthDraw(photo("a.jpg", "waist"), { kind: "no_flood" })).toBe("no_flood");
  });
});

describe("the committed depth set", () => {
  const dir = "test/fixtures/depth-set";
  const photos = JSON.parse(readFileSync(`${dir}/labels.json`, "utf8")) as DepthPhoto[];
  const attribution = readFileSync(`${dir}/ATTRIBUTION.txt`, "utf8");
  const acceptance = JSON.parse(readFileSync("test/fixtures/acceptance/labels.json", "utf8")) as { source: string }[];

  it("has a photo, an open licence, a caption depth and an attribution line for every label, and nothing else", () => {
    expect(photos.length).toBeGreaterThanOrEqual(40);
    for (const p of photos) {
      expect(existsSync(`${dir}/${p.file}`), p.file).toBe(true);
      expect(p.licence, p.file).toMatch(/^(CC0|CC BY(-SA)? \d\.\d|Public domain)$/);
      expect(p.captionDepth, p.file).toBeTruthy();
      expect(attribution, p.file).toContain(`${p.file}: ${p.source}`);
      expect(p.reviewedByLance, p.file).toBe(false);
    }
    const jpgs = readdirSync(dir).filter((f) => f.endsWith(".jpg"));
    expect(jpgs.sort()).toEqual(photos.map((p) => p.file).sort());
  });

  it("passes the manifest check the paid runner makes first", () => {
    expect(depthManifestProblems(photos)).toEqual([]);
  });

  it("shares no photo with the acceptance set and lists none twice", () => {
    const sources = photos.map((p) => p.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const a of acceptance) expect(sources).not.toContain(a.source);
  });
});

describe("depthManifestProblems", () => {
  it("rejects a depth word or a scene the report cannot place, and a photo listed twice", () => {
    const bad = [
      { ...photo("a.jpg", "knee"), captionDepth: "kneee" as DepthPhoto["captionDepth"] },
      { ...photo("b.jpg", "knee"), scene: "river" as DepthPhoto["scene"] },
      photo("c.jpg", "waist"),
      photo("c.jpg", "waist"),
    ];
    expect(depthManifestProblems(bad)).toEqual([
      "a.jpg: caption depth kneee is not one the report knows",
      "b.jpg: scene river is neither flood nor wading",
      "c.jpg: listed twice",
    ]);
  });
});

describe("depthReport", () => {
  it("counts draws, not photos, splits flood from wading, and lists failed draws as errors", () => {
    const photos = [photo("k.jpg", "knee"), photo("w.jpg", "waist", "wading")];
    const report = depthReport(photos, [
      { file: "k.jpg", draw: 1, verdict: deciding(5, 10, "shallow") },
      { file: "k.jpg", draw: 2, verdict: deciding(38, 54) },
      { file: "w.jpg", draw: 1, verdict: deciding(84, 112, "NPATV") },
      { file: "w.jpg", draw: 2, error: "Error: Meta API /responses failed with HTTP 500" },
    ]);
    expect(report.totals.all).toEqual({ draws: 4, too_shallow: 1, matched: 2, too_deep: 0, cannot_measure: 0, no_flood: 0, error: 1 });
    expect(report.totals.flood.draws).toBe(2);
    expect(report.totals.wading).toMatchObject({ draws: 2, matched: 1, error: 1 });
    expect(report.rows).toHaveLength(4);
    expect(report.rows[0]).toMatchObject({ file: "k.jpg", captionDepth: "knee", captionCm: { low: 38, high: 54 }, outcome: "too_shallow" });
    expect(report.markdown).toContain("| k.jpg | 1 | knee (38–54 cm) | 5–10 cm, shallow | too shallow |");
  });

  it("marks a draw the tyre estimate decided", () => {
    const measured = deciding(46, 56) as Extract<Verdict, { kind: "measured" }>;
    const byTyre: Verdict = { ...measured, decidedBy: { label: "C1", landmark: "tyre_geometry", interval: { low: 46, high: 56 } } };
    const report = depthReport([photo("k.jpg", "knee")], [{ file: "k.jpg", draw: 1, verdict: byTyre }]);
    expect(report.markdown).toContain("| k.jpg | 1 | knee (38–54 cm) | 46–56 cm, NPLV (tyre, C1) | matched |");
  });

  it("tallies every outcome by caption depth as well", () => {
    const photos = [photo("k.jpg", "knee"), photo("c.jpg", "chest")];
    const report = depthReport(photos, [
      { file: "k.jpg", draw: 1, verdict: { kind: "cannot_measure", reason: "too_crowded" } },
      { file: "k.jpg", draw: 2, verdict: { kind: "no_flood" } },
      { file: "c.jpg", draw: 1, verdict: deciding(84, 112, "NPATV") },
      { file: "c.jpg", draw: 2, verdict: deciding(100, 133, "NPATV") },
    ]);
    expect(report.byDepth.knee).toEqual({ draws: 2, too_shallow: 0, matched: 0, too_deep: 0, cannot_measure: 1, no_flood: 1, error: 0 });
    expect(report.byDepth.chest).toEqual({ draws: 2, too_shallow: 0, matched: 2, too_deep: 0, cannot_measure: 0, no_flood: 0, error: 0 });
    expect(report.markdown).toContain("can't measure (too crowded)");
  });
});

describe("measures beside overlap (plan duck P2)", () => {
  const atLandmark = (landmark: "ankle" | "knee" | "hip" | "chest" | "tyre_half", low: number, high: number): Verdict => ({
    kind: "measured",
    rangeCm: { low, high },
    passability: "NPATV",
    confidence: "medium",
    readingsComplete: true,
    decidedBy: { label: "P1", landmark, interval: { low, high } },
    readingsUsed: ["P1"],
  });

  it("gap and rank error: a chest reading on a waist caption scores a match but a positive rank error", () => {
    const waist = photo("w.jpg", "waist");
    const chest = atLandmark("chest", 100, 133);
    expect(judgeDepthDraw(waist, chest)).toBe("matched");
    expect(gapCm(waist, chest)).toBe(0);
    expect(rankError(waist, chest)).toBe(1);
  });

  it("gap is negative by the cm between intervals when too shallow, positive when too deep, null when not measured", () => {
    const knee = photo("k.jpg", "knee");
    expect(gapCm(knee, atLandmark("ankle", 5, 10))).toBe(10 - 38);
    expect(rankError(knee, atLandmark("ankle", 5, 10))).toBe(-3);
    expect(gapCm(knee, atLandmark("chest", 100, 133))).toBe(100 - 54);
    expect(gapCm(knee, { kind: "cannot_measure" })).toBeNull();
    expect(rankError(knee, atLandmark("tyre_half", 27, 39))).toBeNull();
  });

  it("paired transitions count each photo and draw once, old outcome to new", () => {
    const photos = [photo("a.jpg", "knee"), photo("b.jpg", "knee")];
    const before = [
      { file: "a.jpg", draw: 1, verdict: atLandmark("ankle", 5, 10) },
      { file: "a.jpg", draw: 2, verdict: atLandmark("knee", 38, 54) },
      { file: "b.jpg", draw: 1, error: "boom" },
    ];
    const after = [
      { file: "a.jpg", draw: 1, verdict: atLandmark("knee", 38, 54) },
      { file: "a.jpg", draw: 2, verdict: atLandmark("chest", 100, 133) },
      { file: "b.jpg", draw: 1, verdict: atLandmark("knee", 38, 54) },
    ];
    expect(transitions(photos, before, after)).toEqual({
      "too_shallow → matched": 1,
      "matched → too_deep": 1,
      "error → matched": 1,
    });
  });
});

describe("split groups (plan duck P3)", () => {
  const split: DepthSplit = {
    split: { "h1.jpg": "heldout", "h2.jpg": "heldout", "t1.jpg": "tuning", "w1.jpg": "heldout" },
    exposedHeldout: ["h2.jpg"],
  };

  it("split tallies: exposed held-out photos are counted apart", () => {
    const photos = [photo("h1.jpg", "knee"), photo("h2.jpg", "knee"), photo("t1.jpg", "knee"), photo("w1.jpg", "knee", "wading")];
    expect(groupsOf(photos[0], split)).toEqual(["all", "flood", "held-out", "held-out flood", "held-out flood, unexposed"]);
    expect(groupsOf(photos[1], split)).toEqual(["all", "flood", "held-out", "held-out flood"]);
    expect(groupsOf(photos[2], split)).toEqual(["all", "flood", "tuning", "tuning flood"]);
    expect(groupsOf(photos[3], split)).toEqual(["all", "wading", "held-out"]);
    const draws = photos.map((p) => ({ file: p.file, draw: 1, verdict: deciding(5, 10, "shallow") }));
    const t = groupTallies(photos, draws, split);
    expect(t.get("held-out flood")?.outcomes.too_shallow).toBe(2);
    expect(t.get("held-out flood, unexposed")?.draws).toBe(1);
    expect(t.get("tuning flood")?.draws).toBe(1);
    expect(t.get("all")).toMatchObject({ draws: 4, measured: 4, meanGapCm: -28, meanAbsGapCm: 28 });
  });

  it("a photo missing from the split is an error, not silently uncounted", () => {
    expect(() => groupsOf(photo("x.jpg", "knee"), split)).toThrow("not in the split");
  });

  it("the committed split covers every labelled photo, and its exposed list is held-out only", () => {
    const labels = JSON.parse(readFileSync("test/fixtures/depth-set/labels.json", "utf8")) as DepthPhoto[];
    const committed = JSON.parse(readFileSync("test/fixtures/depth-set/split.json", "utf8")) as DepthSplit;
    expect(Object.keys(committed.split).sort()).toEqual(labels.map((p) => p.file).sort());
    expect(committed.exposedHeldout.every((f) => committed.split[f] === "heldout")).toBe(true);
  });
});

describe("SpendCap (plan duck P4)", () => {
  it("spend cap: a draw whose reserve would cross the cap does not start", () => {
    const cap = new SpendCap(100);
    expect(cap.tryReserve(60)).toBe(true);
    expect(cap.tryReserve(50)).toBe(false);
    cap.settle(60, 10);
    expect(cap.spentMicros).toBe(10);
    expect(cap.tryReserve(90)).toBe(true);
    expect(cap.tryReserve(1)).toBe(false);
  });
});
