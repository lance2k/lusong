import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  HIDDEN_FLOOR,
  HIDDEN_PARTS,
  HIDDEN_READINGS_SCHEMA,
  normalizeReadings,
  READINGS_SCHEMA,
  toGrid,
  withHiddenFloor,
  type LabelledObject,
  type RawReadings,
} from "./readings";
import { decideVerdict, PERSON_LANDMARKS } from "./verdict";

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

describe("readers", () => {
  const image = { width: 1280, height: 960 };
  const pair: LabelledObject[] = [
    { label: "P1", kind: "person", box: { left: 100, top: 50, right: 300, bottom: 700 } },
    { label: "C1", kind: "car", box: { left: 400, top: 300, right: 1200, bottom: 800 } },
  ];

  it("the landmark reader's prompt is byte for byte the one measured on 2026-10-29", () => {
    expect(buildPrompt(pair, image)).toBe(readFileSync("test/fixtures/muse/landmark-prompt-2026-10-29.txt", "utf8"));
    expect(buildPrompt(pair, image, "landmark")).toBe(buildPrompt(pair, image));
  });

  it("the guided reader adds the hidden-legs guidance and no new field; the hidden reader adds both", () => {
    const guided = buildPrompt(pair, image, "guided");
    const hidden = buildPrompt(pair, image, "hidden");
    expect(guided).toContain("the lowest part of a person you can see is often not their feet");
    expect(guided).not.toContain("hidden_under_water");
    expect(hidden).toContain("the lowest part of a person you can see is often not their feet");
    expect(hidden).toContain("hidden_under_water");
  });

  it("only the hidden reader's schema requires hidden_under_water, with exactly the fixed parts", () => {
    const item = HIDDEN_READINGS_SCHEMA.properties.readings.items;
    expect(item.required).toContain("hidden_under_water");
    expect(item.properties.hidden_under_water.enum).toEqual(HIDDEN_PARTS);
    expect(READINGS_SCHEMA.properties.readings.items.required).not.toContain("hidden_under_water");
  });
});

describe("hidden floor", () => {
  const RANK = (l: string) => PERSON_LANDMARKS.indexOf(l as (typeof PERSON_LANDMARKS)[number]);

  it("hidden floor: each submerged part raises the pick to exactly the landmark it proves, never past it", () => {
    expect(HIDDEN_FLOOR).toEqual({
      feet: "ankle",
      shins: "below_knee",
      knees: "knee",
      thighs: "hip",
      hips: "hip",
      waist: "waist",
      chest: "chest",
    });
    for (const picked of PERSON_LANDMARKS) {
      for (const hidden of HIDDEN_PARTS) {
        const result = withHiddenFloor(picked, hidden);
        if (hidden === "none" || hidden === "cannot_tell") {
          expect(result).toBe(picked);
          continue;
        }
        const floor = HIDDEN_FLOOR[hidden];
        expect(RANK(result)).toBe(Math.max(RANK(picked), RANK(floor)));
      }
    }
  });

  function hiddenRaw(...rows: [string, string, string, Partial<{ in_water: boolean; is_child: boolean }>?][]) {
    return {
      is_flooded_street: true,
      caveats: "",
      readings: rows.map(([label, waterline, hidden, extra]) => ({
        label,
        waterline,
        hidden_under_water: hidden,
        in_water: extra?.in_water ?? true,
        is_child: extra?.is_child ?? false,
        note: "",
      })),
    };
  }
  const people: LabelledObject[] = [
    { label: "P1", kind: "person", box },
    { label: "P2", kind: "person", box },
    { label: "C1", kind: "car", box },
  ];

  it("raises an ankle pick on a person whose knees are under the water, and keeps the pick in the detail", () => {
    const { readings, details, problems } = normalizeReadings(
      hiddenRaw(["P1", "ankle", "knees"], ["P2", "waist", "shins"], ["C1", "tyre_half", "cannot_tell"]),
      people,
      "hidden",
    );
    expect(problems).toEqual([]);
    expect(readings.map((r) => r.landmark)).toEqual(["knee", "waist", "tyre_half"]);
    expect(details.P1).toEqual({ picked: "ankle", hidden: "knees" });
  });

  it("never makes a not_visible, dry, child or vehicle reading count, and never changes a vehicle's pick", () => {
    const { readings } = normalizeReadings(
      hiddenRaw(["P1", "not_visible", "thighs"], ["P2", "ankle", "waist", { is_child: true }], ["C1", "tyre_quarter", "knees"]),
      people,
      "hidden",
    );
    expect(readings.map((r) => r.landmark)).toEqual(["not_visible", "ankle", "tyre_quarter"]);
    const dry = normalizeReadings(hiddenRaw(["P1", "ankle", "waist", { in_water: false }], ["P2", "ankle", "none"], ["C1", "tyre_half", "none"]), people, "hidden");
    expect(dry.readings[0]).toMatchObject({ landmark: "ankle", inWater: false });
    const v = decideVerdict({ readings: dry.readings, readingsComplete: true, waterFound: true, modelSaysFlooded: true });
    expect(v.kind === "measured" && v.decidedBy.landmark).toBe("tyre_half");
  });

  it("a missing or unknown hidden_under_water is a contract problem, and the pick stands", () => {
    const reply = hiddenRaw(["P1", "ankle", "ribs"], ["P2", "ankle", "none"], ["C1", "tyre_half", "none"]);
    delete (reply.readings[1] as Partial<(typeof reply.readings)[number]>).hidden_under_water;
    const { readings, problems } = normalizeReadings(reply, people, "hidden");
    expect(problems).toEqual(["P1: unknown hidden_under_water ribs", "P2: unknown hidden_under_water undefined"]);
    expect(readings.map((r) => r.landmark)).toEqual(["ankle", "ankle", "tyre_half"]);
  });

  it("the landmark and guided readers ignore a hidden_under_water field", () => {
    for (const reader of ["landmark", "guided"] as const) {
      const { readings, details, problems } = normalizeReadings(hiddenRaw(["P1", "ankle", "chest"], ["P2", "ankle", "chest"], ["C1", "tyre_half", "none"]), people, reader);
      expect(problems).toEqual([]);
      expect(readings.map((r) => r.landmark)).toEqual(["ankle", "ankle", "tyre_half"]);
      expect(details.P1.hidden).toBeNull();
    }
  });
});
