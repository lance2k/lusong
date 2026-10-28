import { describe, expect, it } from "vitest";
import { decideVerdict, gaugeRowsFor, passabilityFor, type Landmark, type Reading } from "./verdict";

function person(label: string, landmark: Landmark, extra: Partial<Reading> = {}): Reading {
  return { label, kind: "person", inWater: true, landmark, isChild: false, ...extra };
}
function car(label: string, landmark: Landmark): Reading {
  return { label, kind: "car", inWater: true, landmark, isChild: false };
}
const flooded = { waterFound: true, modelSaysFlooded: true, readingsComplete: true };

describe("passabilityFor", () => {
  it("splits on the MMDA lines at 33 and 66 cm", () => {
    expect(passabilityFor(32.9)).toBe("PATV");
    expect(passabilityFor(33)).toBe("NPLV");
    expect(passabilityFor(65.9)).toBe("NPLV");
    expect(passabilityFor(66)).toBe("NPATV");
  });
});

describe("gaugeRowsFor", () => {
  it("names the gauge rows inside an interval", () => {
    expect(gaugeRowsFor({ low: 38, high: 54 }).within.map((r) => r.name)).toEqual(["Knee deep"]);
    expect(gaugeRowsFor({ low: 18, high: 27 }).within.map((r) => r.name)).toEqual(["Gutter deep", "Half-knee deep"]);
  });

  it("falls back to the nearest rows on each side, or past the end of the gauge", () => {
    const between = gaugeRowsFor({ low: 50, high: 60 });
    expect([between.below?.name, between.above?.name]).toEqual(["Knee deep", "Tire deep"]);
    const shallow = gaugeRowsFor({ low: 5, high: 10 });
    expect([shallow.below, shallow.above?.name]).toEqual([null, "Gutter deep"]);
  });
});

describe("decideVerdict", () => {
  it("agreeing readings whose intervals cross 33 cm are not PATV", () => {
    const v = decideVerdict({
      readings: [person("P1", "below_knee"), person("P2", "below_knee"), person("P3", "below_knee")],
      ...flooded,
    });
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.rangeCm).toEqual({ low: 30, high: 45 });
    expect(v.passability).toBe("NPLV");
  });

  it("zero usable readings gives no passability", () => {
    expect(decideVerdict({ readings: [], ...flooded })).toEqual({ kind: "cannot_measure" });
    const hidden = [person("P1", "not_visible"), person("P2", "knee", { inWater: false })];
    expect(decideVerdict({ readings: hidden, ...flooded })).toEqual({ kind: "cannot_measure" });
  });

  it("single half-knee reading is Unsure, not PATV", () => {
    const v = decideVerdict({ readings: [person("P1", "half_knee")], ...flooded });
    expect(v.kind === "measured" && v.passability).toBe("unsure");
    expect(v.kind === "measured" && v.confidence).toBe("low");
  });

  it("an incomplete reading set never yields PATV, but keeps a not-passable class", () => {
    const shallow = decideVerdict({ readings: [person("P1", "half_knee"), person("P2", "half_knee")], ...flooded, readingsComplete: false });
    expect(shallow.kind === "measured" && shallow.passability).toBe("unsure");
    const deep = decideVerdict({ readings: [person("P1", "knee"), person("P2", "knee")], ...flooded, readingsComplete: false });
    expect(deep.kind === "measured" && deep.passability).toBe("NPLV");
  });

  it("two half-knee readings are 'shallow', never PATV, even at medium confidence", () => {
    const v = decideVerdict({ readings: [person("P1", "half_knee"), person("P2", "half_knee")], ...flooded });
    expect(v.kind === "measured" && v.passability).toBe("shallow");
    expect(v.kind === "measured" && v.confidence).toBe("medium");
  });

  it("three agreeing ankle readings at high confidence are still not PATV", () => {
    const v = decideVerdict({ readings: ["P1", "P2", "P3"].map((l) => person(l, "ankle")), ...flooded });
    expect(v.kind === "measured" && v.confidence).toBe("high");
    expect(v.kind === "measured" && v.passability).toBe("shallow");
  });

  it("the deepest reading decides, and names itself", () => {
    const v = decideVerdict({
      readings: [person("P1", "half_knee"), person("P2", "half_knee"), car("C1", "tyre_half")],
      ...flooded,
    });
    if (v.kind !== "measured") throw new Error("expected a measurement");
    expect(v.rangeCm).toEqual({ low: 18, high: 39 });
    expect(v.passability).toBe("NPLV");
    expect(v.decidedBy).toEqual({ label: "C1", landmark: "tyre_half", interval: { low: 27, high: 39 } });
    expect(v.confidence).toBe("high");
  });

  it("drops children and landmarks that belong to the other kind of object", () => {
    const v = decideVerdict({
      readings: [person("P1", "waist", { isChild: true }), car("C1", "knee"), person("P2", "tyre_half")],
      ...flooded,
    });
    expect(v).toEqual({ kind: "cannot_measure" });
  });

  it("widely disagreeing readings stay low confidence", () => {
    const v = decideVerdict({ readings: [person("P1", "ankle"), person("P2", "waist")], ...flooded });
    if (v.kind !== "measured") throw new Error("expected a measurement");
    expect(v.confidence).toBe("low");
    expect(v.passability).toBe("NPATV");
  });

  it("says no flood only when SAM found no water and the model agrees", () => {
    expect(decideVerdict({ readings: [], readingsComplete: true, waterFound: false, modelSaysFlooded: false })).toEqual({ kind: "no_flood" });
    expect(decideVerdict({ readings: [], readingsComplete: true, waterFound: false, modelSaysFlooded: true })).toEqual({ kind: "cannot_measure" });
  });
});
