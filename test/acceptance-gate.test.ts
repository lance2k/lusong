import { describe, expect, it } from "vitest";
import type { Verdict } from "../lib/verdict";
import { judgeAcceptance, type AcceptancePhoto, type Depth } from "./acceptance-gate";

function photo(file: string, captionDepth: Depth | null, refs: number, overrides: Partial<AcceptancePhoto> = {}): AcceptancePhoto {
  const deep = captionDepth !== null && ["knee", "thigh", "waist", "chest"].includes(captionDepth);
  return {
    file,
    source: `https://commons.wikimedia.org/wiki/File:${file}`,
    licence: "CC BY-SA 4.0",
    author: "someone",
    caption: `${captionDepth ?? "no"} deep`,
    captionDepth,
    refs,
    expect: refs === 0 ? "cannot_measure" : deep ? "not_patv" : "any",
    ...overrides,
  };
}

const MANIFEST: AcceptancePhoto[] = [
  photo("knee-crowd.jpg", "knee", 5),
  photo("knee-pair.jpg", "knee", 2),
  photo("waist-group.jpg", "waist", 3),
  photo("waist-one.jpg", "waist", 1),
  photo("chest-one.jpg", "chest", 1),
  photo("thigh-one.jpg", "thigh", 1),
  photo("ankle-crowd.jpg", "ankle", 4),
  photo("empty-street.jpg", "knee", 0),
  photo("empty-road.jpg", null, 0),
];

const measured = (passability: "shallow" | "NPLV" | "NPATV" | "unsure"): Verdict => ({
  kind: "measured",
  rangeCm: { low: 38, high: 54 },
  passability,
  confidence: "medium",
  readingsComplete: true,
  decidedBy: { label: "P1", landmark: "knee", interval: { low: 38, high: 54 } },
  readingsUsed: ["P1"],
});

function cleanRun(): { file: string; draw: number; verdict: Verdict }[] {
  return MANIFEST.flatMap((p) =>
    [1, 2].map((draw) => ({
      file: p.file,
      draw,
      verdict: p.expect === "cannot_measure" ? ({ kind: "cannot_measure" } as const) : measured("NPLV"),
    })),
  );
}

describe("the acceptance gate", () => {
  it("passes a run with every deep photo measured and every no-reference photo unmeasured", () => {
    expect(judgeAcceptance(MANIFEST, cleanRun())).toEqual({ pass: true, problems: [], failures: [], underReads: [] });
  });

  it("'shallow' on a knee-deep photo is reported as an under-read, not a failure", () => {
    const run = cleanRun().map((r) => (r.file === "knee-pair.jpg" && r.draw === 2 ? { ...r, verdict: measured("shallow") } : r));
    const verdict = judgeAcceptance(MANIFEST, run);
    expect(verdict.pass).toBe(true);
    expect(verdict.underReads).toEqual(["knee-pair.jpg draw 2: shallow, 38-54 cm, on a photo captioned knee deep"]);
  });

  it("'no flood found' on a knee-deep photo fails the gate", () => {
    const run = cleanRun().map((r) => (r.file === "knee-crowd.jpg" && r.draw === 1 ? { ...r, verdict: { kind: "no_flood" } as const } : r));
    expect(judgeAcceptance(MANIFEST, run).failures).toEqual(["knee-crowd.jpg draw 1: no_flood on a photo captioned knee deep"]);
  });

  it("a measurement on a photo with no reference fails the gate", () => {
    const run = cleanRun().map((r) => (r.file === "empty-road.jpg" && r.draw === 1 ? { ...r, verdict: measured("NPLV") } : r));
    expect(judgeAcceptance(MANIFEST, run).failures).toEqual(["empty-road.jpg draw 1: measured, expected cannot_measure"]);
  });

  it("a photo with fewer than two draws fails the gate", () => {
    const run = cleanRun().filter((r) => !(r.file === "waist-one.jpg" && r.draw === 2));
    expect(judgeAcceptance(MANIFEST, run).failures).toEqual(["waist-one.jpg: 1 of 2 draws"]);
  });

  it("a manifest missing a required category is rejected before any result counts", () => {
    const oneEmpty = MANIFEST.filter((p) => p.file !== "empty-road.jpg");
    const verdict = judgeAcceptance(oneEmpty, cleanRun());
    expect(verdict.pass).toBe(false);
    expect(verdict.problems).toEqual(["2 photos with no person or car needed, 1 found"]);
  });

  it("needs six deep photos, three of them with two or more references", () => {
    const shallow = MANIFEST.filter((p) => !["knee-crowd.jpg", "waist-group.jpg"].includes(p.file));
    expect(judgeAcceptance(shallow, cleanRun()).problems).toEqual([
      "6 photos captioned knee deep or deeper needed, 4 found",
      "3 deep photos with 2 or more people or cars needed, 1 found",
    ]);
  });

  it("a deep photo not labelled not_patv is rejected", () => {
    const mislabelled = MANIFEST.map((p) => (p.file === "chest-one.jpg" ? { ...p, expect: "any" as const } : p));
    expect(judgeAcceptance(mislabelled, cleanRun()).problems).toEqual(["chest-one.jpg: captioned chest deep but expects any"]);
  });

  it("a manifest listing one photo twice is rejected", () => {
    const doubled = [...MANIFEST, MANIFEST[0]];
    expect(judgeAcceptance(doubled, cleanRun()).problems).toEqual(["knee-crowd.jpg: listed twice"]);
  });

  it("the same draw reported twice counts once", () => {
    const run = cleanRun().map((r) => (r.file === "waist-one.jpg" && r.draw === 2 ? { ...r, draw: 1 } : r));
    expect(judgeAcceptance(MANIFEST, run).failures).toEqual(["waist-one.jpg: 1 of 2 draws"]);
  });

  it("a photo whose licence is not on the open list is rejected", () => {
    const closed = MANIFEST.map((p) => (p.file === "thigh-one.jpg" ? { ...p, licence: "All rights reserved" } : p));
    expect(judgeAcceptance(closed, cleanRun()).problems).toEqual(["thigh-one.jpg: licence All rights reserved"]);
  });
});
