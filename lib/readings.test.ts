import { describe, expect, it } from "vitest";
import { buildPrompt, normalizeReadings, toGrid, type LabelledObject, type RawReadings } from "./readings";
import { decideVerdict } from "./verdict";

const box = { left: 0, top: 0, right: 10, bottom: 10 };
const objects: LabelledObject[] = [
  { label: "P1", kind: "person", box },
  { label: "P2", kind: "person", box },
  { label: "P3", kind: "person", box },
];

function raw(...readings: [string, string][]): RawReadings {
  return {
    is_flooded_street: true,
    caveats: "",
    readings: readings.map(([label, waterline]) => ({ label, waterline, in_water: true, is_child: false, note: "" })),
  };
}

/** The reply as the route would judge it: normalised, then decided. */
function verdictFor(reply: RawReadings) {
  const { readings, problems } = normalizeReadings(reply, objects);
  return decideVerdict({ readings, readingsComplete: problems.length === 0, waterFound: true, modelSaysFlooded: true });
}

describe("normalizeReadings + decideVerdict: a broken reply is never 'shallow'", () => {
  it("baseline: three agreeing half-knee readings are 'shallow'", () => {
    const v = verdictFor(raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "half_knee"]));
    expect(v.kind === "measured" && v.passability).toBe("shallow");
  });

  it("an omitted object", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"]);
    expect(normalizeReadings(reply, objects).problems).toEqual(["P3 missing"]);
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("unsure");
  });

  it("a duplicate reading keeps the deeper landmark", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "half_knee"], ["P1", "waist"]);
    const { readings, problems } = normalizeReadings(reply, objects);
    expect(problems).toEqual(["P1 reported twice"]);
    expect(readings.find((r) => r.label === "P1")?.landmark).toBe("waist");
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("NPATV");
  });

  it("a tyre landmark on a person", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "tyre_full"]);
    expect(normalizeReadings(reply, objects).problems).toEqual(["P3: tyre_full does not fit a person"]);
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("unsure");
  });

  it("the deepest reading with in_water missing", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "waist"]);
    delete (reply.readings[2] as Partial<(typeof reply.readings)[number]>).in_water;
    expect(normalizeReadings(reply, objects).problems).toEqual(["a reading with missing or mistyped fields", "P3 missing"]);
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("unsure");
  });

  it("the deepest reading with is_child as a string", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "waist"]);
    (reply.readings[2] as unknown as Record<string, unknown>).is_child = "false";
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("unsure");
  });

  it("a missing deepest reading above 33 cm leaves 'unsure', never NPLV", () => {
    expect(verdictFor(raw(["P1", "knee"], ["P2", "knee"], ["P3", "waist"]))).toMatchObject({ passability: "NPATV" });

    const omitted = raw(["P1", "knee"], ["P2", "knee"]);
    expect(verdictFor(omitted)).toMatchObject({ passability: "unsure", readingsComplete: false });

    const mistyped = raw(["P1", "knee"], ["P2", "knee"], ["P3", "waist"]);
    (mistyped.readings[2] as unknown as Record<string, unknown>).is_child = "false";
    expect(verdictFor(mistyped)).toMatchObject({ passability: "unsure", readingsComplete: false });
  });

  it("an incomplete set that still reads NPATV keeps NPATV", () => {
    expect(verdictFor(raw(["P1", "knee"], ["P2", "waist"]))).toMatchObject({ passability: "NPATV", readingsComplete: false });
  });

  it("a missing only reading is 'cannot measure', never 'no flood', even when nothing else saw water", () => {
    const dry = { waterFound: false, modelSaysFlooded: false };
    const decide = (reply: RawReadings) => {
      const { readings, problems } = normalizeReadings(reply, objects);
      return decideVerdict({ readings, readingsComplete: problems.length === 0, ...dry });
    };
    expect(decide(raw(["P1", "waist"], ["P2", "not_visible"], ["P3", "not_visible"]))).toMatchObject({ passability: "NPATV" });

    expect(decide(raw(["P2", "not_visible"], ["P3", "not_visible"]))).toEqual({ kind: "cannot_measure" });

    const mistyped = raw(["P1", "waist"], ["P2", "not_visible"], ["P3", "not_visible"]);
    (mistyped.readings[0] as unknown as Record<string, unknown>).is_child = "false";
    expect(decide(mistyped)).toEqual({ kind: "cannot_measure" });

    expect(decide(raw(["P1", "not_visible"], ["P2", "not_visible"], ["P3", "not_visible"]))).toEqual({ kind: "no_flood" });
  });

  it("a reply with no readings array", () => {
    const { readings, problems } = normalizeReadings({ is_flooded_street: true }, objects);
    expect(readings).toEqual([]);
    expect(problems[0]).toBe("readings missing");
  });

  it("a label nobody asked about", () => {
    const reply = raw(["P1", "half_knee"], ["P2", "half_knee"], ["P3", "half_knee"], ["P9", "chest"]);
    expect(normalizeReadings(reply, objects).problems).toEqual(["unexpected label P9"]);
    const v = verdictFor(reply);
    expect(v.kind === "measured" && v.passability).toBe("unsure");
  });
});

describe("prompt", () => {
  it("lists every object with its box on the 0–1000 grid", () => {
    const image = { width: 1280, height: 960 };
    expect(toGrid({ left: 128, top: 96, right: 640, bottom: 480 }, image)).toEqual([100, 100, 500, 500]);
    const prompt = buildPrompt([{ label: "C1", kind: "car", box: { left: 0, top: 480, right: 1280, bottom: 960 } }], image);
    expect(prompt).toContain("C1 car [0, 500, 1000, 1000]");
  });
});
