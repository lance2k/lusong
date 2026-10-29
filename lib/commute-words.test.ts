import { describe, expect, it } from "vitest";
import { ageWords, depthWords, detourWords, passabilityLine, phtTime, voiceDepthWords, voiceHeard, voicePassabilityLine } from "./commute-words";
import type { Verdict } from "./verdict";

const measured = (low: number, high: number, passability: "NPLV" | "NPATV" | "shallow" | "unsure"): Verdict => ({
  kind: "measured",
  rangeCm: { low, high },
  passability,
  confidence: "low",
  readingsComplete: true,
  decidedBy: { label: "P1", landmark: "knee", interval: { low, high } },
  readingsUsed: ["P1"],
});

describe("a report's reading in body-part words", () => {
  it.each([
    { range: [5, 10], words: "ankle-deep (5–10 cm)" },
    { range: [18, 27], words: "half-knee-deep (18–27 cm)" },
    { range: [27, 39], words: "half-knee- to knee-deep (27–39 cm)" },
    { range: [38, 54], words: "knee-deep (38–54 cm)" },
    { range: [5, 72], words: "ankle- to thigh-deep (5–72 cm)" },
    { range: [84, 112], words: "waist-deep (84–112 cm)" },
    { range: [100, 133], words: "waist- to chest-deep (100–133 cm)" },
    { range: [114, 140], words: "chest-deep (114–140 cm)" },
  ])("$range cm ⇒ $words", ({ range, words }) => {
    expect(depthWords(measured(range[0], range[1], "NPLV"))).toBe(words);
  });

  it("an unmeasured photo has no depth words", () => {
    expect(depthWords({ kind: "cannot_measure" })).toBe("depth not measured");
    expect(depthWords({ kind: "no_flood" })).toBe("no flood water seen");
  });

  it("credits the passability lines to Metro Manila's MMDA gauge and never says 'passable to all types of vehicles'", () => {
    const lines = [
      passabilityLine(measured(38, 54, "NPLV")),
      passabilityLine(measured(66, 112, "NPATV")),
      passabilityLine(measured(5, 10, "shallow")),
      passabilityLine(measured(5, 10, "unsure")),
      passabilityLine({ kind: "cannot_measure" }),
      passabilityLine({ kind: "no_flood" }),
    ];
    expect(lines[0]).toBe("Not passable to light vehicles (MMDA gauge, Metro Manila)");
    expect(lines[1]).toBe("Not passable to any vehicle (MMDA gauge, Metro Manila)");
    for (const line of lines) expect(line.toLowerCase()).not.toContain("passable to all types of vehicles");
  });
});

describe("times", () => {
  it.each([
    { min: 0.5, words: "just now" },
    { min: 25, words: "25 min ago" },
    { min: 60, words: "1 h ago" },
    { min: 140, words: "2 h 20 min ago" },
    { min: 200, words: "3 h 20 min ago" },
  ])("$min min ⇒ $words", ({ min, words }) => {
    expect(ageWords(min * 60_000)).toBe(words);
  });

  it("writes a CAP time in Manila time", () => {
    expect(phtTime("2026-10-25T17:27:04+08:00")).toBe("25 Oct, 5:27 p.m. PHT");
    expect(phtTime("2026-10-25T21:27:04Z")).toBe("26 Oct, 5:27 a.m. PHT");
  });
});

describe("the other way, against the usual one", () => {
  it("says how much longer the Banilad → IT Park detour is, in km and minutes", () => {
    expect(detourWords({ extraKm: 0.7, extraMin: 4 })).toBe("0.7 km and 4 min longer than your usual way");
  });

  it("says when it is no slower or shorter", () => {
    expect(detourWords({ extraKm: 0.3, extraMin: 0 })).toBe("0.3 km longer than your usual way, about the same time");
    expect(detourWords({ extraKm: -0.2, extraMin: -1 })).toBe("0.2 km and 1 min shorter than your usual way");
  });
});

describe("a voice report in fixed sentences built from its claim's choices, never the speaker's or the model's wording", () => {
  it.each([
    ["dry", "no flood water"],
    ["below_knee", "below the knee"],
    ["knee_or_deeper", "knee-deep or deeper"],
    ["not_said", null],
  ] as const)("depth %s ⇒ %s", (depth, words) => {
    expect(voiceDepthWords(depth)).toBe(words);
  });

  it.each([
    ["knee_deep_or_deeper", "Not passable, says a voice report"],
    ["not_passable", "Not passable, says a voice report"],
    ["passable", "Passable, says a voice report, but only a recent photo can mark a street clear"],
    ["unsure", "A voice report that doesn't say whether vehicles can pass"],
  ] as const)("%s ⇒ %s", (says, line) => {
    expect(voicePassabilityLine(says)).toBe(line);
  });

  it.each([
    [{ depth: "knee_or_deeper", passable: "no" }, "Lusong heard that the water is knee-deep or deeper and vehicles can't pass."],
    [{ depth: "dry", passable: "yes" }, "Lusong heard that there is no flood water and vehicles can pass."],
    [{ depth: "below_knee", passable: "not_said" }, "Lusong heard that the water is below the knee."],
    [{ depth: "not_said", passable: "no" }, "Lusong heard that vehicles can't pass."],
    [{ depth: "not_said", passable: "not_said" }, "Lusong couldn't tell from your note how deep the water is or whether vehicles can pass."],
  ] as const)("the reporter is told what was heard: %o", (claim, sentence) => {
    expect(voiceHeard({ place: null, ...claim })).toBe(sentence);
  });
});
