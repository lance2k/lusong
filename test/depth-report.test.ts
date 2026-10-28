import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Verdict } from "../lib/verdict";
import { depthReport, judgeDepthDraw, type DepthPhoto } from "./depth-report";

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

  it("shares no photo with the acceptance set and lists none twice", () => {
    const sources = photos.map((p) => p.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const a of acceptance) expect(sources).not.toContain(a.source);
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
});
