import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Box, PlacedRaster } from "../lib/sam";
import type { BlurLabels, RecordedCall } from "./blur-recall";
import { billedUpperBound, compareSets, ImageAllowance, scoreWholeBlur, subsetsOf } from "./whole-blur";

function rectangle(bounds: Box): PlacedRaster {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return { raster: new Uint8Array(width * height).fill(1), width, height, bounds, scaleX: 1, scaleY: 1 };
}

// A 200 × 100 photo: a plate at the left, a face at the right. Masks are injected through a reader stub.
const labels: BlurLabels = {
  positives: [
    {
      file: "p.jpg",
      plates: [{ box: { left: 20, top: 60, right: 50, bottom: 70 }, sure: true, where: "plate" }],
      faces: [{ box: { left: 150, top: 10, right: 170, bottom: 30 }, sure: true, where: "face" }],
    },
  ],
  negatives: [{ file: "n.jpg" }],
};
const sizes = { "p.jpg": { width: 200, height: 100 }, "n.jpg": { width: 200, height: 100 } };
const plateBox = { left: 20, top: 60, right: 50, bottom: 70 };
const carMask = rectangle({ left: 10, top: 40, right: 70, bottom: 80 });
const personMask = rectangle({ left: 140, top: 5, right: 180, bottom: 95 });

const call = (prompt: string, masks: PlacedRaster[] | "fail"): RecordedCall =>
  masks === "fail" ? { prompt, ok: false, error: "HTTP 500" } : { prompt, ok: true, status: "completed", text: JSON.stringify(masks) };
const reader = (text: string) => {
  if (text === "fail") return { ok: false as const, problem: "parse_error" };
  const masks = (JSON.parse(text) as PlacedRaster[]).map((m) => ({ ...m, raster: Uint8Array.from(Object.values(m.raster)) }));
  return { ok: true as const, masks };
};
const negatives = { "n.jpg": [call("license plate", []), call("person", []), call("car", [])] };

describe("scoreWholeBlur", () => {
  it("lets a vehicle mask in the set cover a plate the plate prompt missed, and only when the vehicle is in the set", () => {
    const recorded = { "p.jpg": [call("license plate", []), call("person", [personMask]), call("car", [carMask])], ...negatives };
    const withCar = scoreWholeBlur(labels, sizes, recorded, ["car"], reader);
    expect(withCar.photos[0]).toMatchObject({ publishable: true, allCovered: true, allSureCovered: true });
    expect(withCar.photos[0].plates[0]).toMatchObject({ assigned: 1, union: 1 });
    const today = scoreWholeBlur(labels, sizes, recorded, [], reader);
    expect(today.photos[0]).toMatchObject({ publishable: true, allCovered: false });
    expect(today.photos[0].plates[0].assigned).toBe(0);
  });

  it("never lets a person mask rescue a plate, but reports it in the union", () => {
    const bigPerson = rectangle({ left: 0, top: 0, right: 200, bottom: 100 });
    const recorded = { "p.jpg": [call("license plate", []), call("person", [bigPerson])], ...negatives };
    const score = scoreWholeBlur(labels, sizes, recorded, [], reader);
    expect(score.photos[0].plates[0]).toMatchObject({ assigned: 0, union: 1 });
    expect(score.photos[0].allCovered).toBe(false);
  });

  it("lets a vehicle mask cover a face inside it", () => {
    const recorded = { "p.jpg": [call("license plate", [rectangle(plateBox)]), call("person", []), call("jeepney", [rectangle({ left: 130, top: 0, right: 200, bottom: 60 })])], ...negatives };
    const score = scoreWholeBlur(labels, sizes, recorded, ["jeepney"], reader);
    expect(score.photos[0].faces[0].assigned).toBe(1);
    expect(score.photos[0].allCovered).toBe(true);
  });

  it("hides a photo whose vehicle call in the set failed or was never recorded, and ignores a failed call outside the set", () => {
    const recorded = { "p.jpg": [call("license plate", [rectangle(plateBox)]), call("person", [personMask]), call("car", "fail")], ...negatives };
    expect(scoreWholeBlur(labels, sizes, recorded, ["car"], reader).photos[0]).toMatchObject({ publishable: false, allCovered: false, failedCalls: ["car"] });
    expect(scoreWholeBlur(labels, sizes, recorded, ["motorcycle"], reader).photos[0]).toMatchObject({
      publishable: false,
      failures: [{ prompt: "motorcycle", problem: "not recorded" }],
    });
    expect(scoreWholeBlur(labels, sizes, recorded, [], reader).photos[0]).toMatchObject({ publishable: true, allCovered: true });
  });

  it("measures the share of the photo left unblurred from the blur's own grown regions", () => {
    const recorded = { "p.jpg": [call("license plate", [rectangle(plateBox)]), call("person", [])], ...negatives };
    // A 30 × 10 plate mask grows by max(6, ceil(0.1 × 30)) = 6 px each way: 42 × 22 = 924 pixels.
    expect(scoreWholeBlur(labels, sizes, recorded, [], reader).photos[0].unblurredShare).toBeCloseTo(1 - 924 / 20_000, 10);
  });

  it("measures the water left unblurred and the water touching people and vehicles, from the raw water mask", () => {
    // Water across the bottom 20 rows; the car's grown mask (60 × 40 grown by 6) reaches row 86, so rows 80–85 of
    // columns 4–75 are blurred: 72 × 6 = 432 of 4,000 water pixels.
    const water = rectangle({ left: 0, top: 80, right: 200, bottom: 100 });
    const recorded = { "p.jpg": [call("license plate", []), call("person", []), call("car", [carMask]), call("flood water", [water])], ...negatives };
    const score = scoreWholeBlur(labels, sizes, recorded, ["car"], reader, { bandPrompts: ["person", "car"] });
    expect(score.photos[0].water).toMatchObject({ pixels: 4000, share: 0.2 });
    expect(score.photos[0].water!.unblurredShare).toBeCloseTo(1 - 432 / 4000, 10);
    // The band: water within 6 px of the raw car mask (bottom 80, columns 10–69): rows 80–85, columns 4–75. All blurred.
    expect(score.photos[0].water).toMatchObject({ band: 432, bandUnblurredShare: 0 });
    const today = scoreWholeBlur(labels, sizes, recorded, [], reader, { bandPrompts: ["person", "car"] });
    expect(today.photos[0].water).toMatchObject({ unblurredShare: 1, band: 432, bandUnblurredShare: 1 });
  });

  it("reports no water when the water call is missing or failed, with the reason", () => {
    const missing = scoreWholeBlur(labels, sizes, { "p.jpg": [call("license plate", []), call("person", [])], ...negatives }, [], reader);
    expect(missing.photos[0].water).toBeNull();
    expect(missing.photos[0].waterProblem).toBe("not recorded");
    const failed = scoreWholeBlur(labels, sizes, { "p.jpg": [call("license plate", []), call("person", []), call("flood water", "fail")], ...negatives }, [], reader);
    expect(failed.photos[0].waterProblem).toBe("HTTP 500");
  });
});

describe("scoreWholeBlur evidence figures", () => {
  const water = rectangle({ left: 0, top: 80, right: 200, bottom: 100 });

  it("gives no evidence figures for a photo the set would hide, so a failed call can't look like evidence kept", () => {
    const recorded = { "p.jpg": [call("license plate", []), call("person", []), call("car", "fail"), call("flood water", [water])], ...negatives };
    const photo = scoreWholeBlur(labels, sizes, recorded, ["car"], reader).photos[0];
    expect(photo.publishable).toBe(false);
    expect(photo.unblurredShare).toBeNull();
    expect(photo.water).toBeNull();
    expect(photo.waterProblem).toBe("photo hidden");
  });

  it("reports a water reply with no mask as no water, and an empty band as unavailable rather than kept", () => {
    const recorded = { "p.jpg": [call("license plate", []), call("person", []), call("flood water", [])], ...negatives };
    expect(scoreWholeBlur(labels, sizes, recorded, [], reader, { bandPrompts: ["person"] }).photos[0].water).toEqual({ pixels: 0, share: 0, unblurredShare: null, band: 0, bandUnblurredShare: null });
  });

  it("gives no band when a band prompt's reply is missing or unreadable", () => {
    const recorded = { "p.jpg": [call("license plate", []), call("person", []), call("car", "fail"), call("flood water", [water])], ...negatives };
    const photo = scoreWholeBlur(labels, sizes, recorded, [], reader, { bandPrompts: ["person", "car"] }).photos[0];
    expect(photo.water).toMatchObject({ pixels: 4000, unblurredShare: 1, band: null, bandUnblurredShare: null });
  });
});

describe("subsetsOf", () => {
  it("lists every subset, the empty one first", () => {
    expect(subsetsOf(["a", "b"])).toEqual([[], ["a"], ["b"], ["a", "b"]]);
  });
});

describe("compareSets", () => {
  it("counts a photo as meeting the bar only when it does in every draw, and names the old misses a set closes in all of them", () => {
    const drawCovered = { "p.jpg": [call("license plate", []), call("person", [personMask]), call("car", [carMask])], ...negatives };
    const drawMissed = { "p.jpg": [call("license plate", []), call("person", [personMask]), call("car", [])], ...negatives };
    const both = compareSets(labels, sizes, [drawCovered, drawCovered], ["car"], reader);
    const today = both.find((s) => s.set.length === 0)!;
    const car = both.find((s) => s.set.join() === "car")!;
    expect(today).toMatchObject({ photosMeetingBar: [0, 0], photosMeetingBarEveryDraw: 0, extraImagesPerReport: 0 });
    expect(car).toMatchObject({ photosMeetingBar: [1, 1], photosMeetingBarEveryDraw: 1, closesEveryDraw: ["p.jpg plate 0 (plate)"] });
    const mixed = compareSets(labels, sizes, [drawCovered, drawMissed], ["car"], reader).find((s) => s.set.join() === "car")!;
    expect(mixed).toMatchObject({ photosMeetingBar: [1, 0], photosMeetingBarEveryDraw: 0, closesEveryDraw: [] });
  });

  it("tallies a label by its kind, not by words in its description", () => {
    const tricky: BlurLabels = { ...labels, positives: [{ ...labels.positives[0], faces: [{ ...labels.positives[0].faces[0], where: "rider above the plate holder" }] }] };
    const recorded = { "p.jpg": [call("license plate", []), call("person", [personMask])], ...negatives };
    const today = compareSets(tricky, sizes, [recorded], [], reader)[0];
    expect(today.plates[0]).toMatchObject({ all: 1, covered: 0 });
    expect(today.faces[0]).toMatchObject({ all: 1, covered: 1 });
  });

  it("charges car nothing extra, since the photo check already calls it, and every other phrase one image", () => {
    const sets = compareSets(labels, sizes, [negatives], ["car", "motorcycle"], reader);
    expect(sets.map((s) => [s.set.join("+"), s.extraImagesPerReport])).toEqual([["", 0], ["car", 0], ["motorcycle", 1], ["car+motorcycle", 1]]);
  });
});

describe("billedUpperBound", () => {
  it("is the metered image for a clean call, and both attempts for anything else", () => {
    expect(billedUpperBound({ threw: false, metered: 1, complete: true })).toBe(1);
    // A first attempt that failed (maybe billed) before a retry that succeeded: the meter shows 1, incomplete.
    expect(billedUpperBound({ threw: false, metered: 1, complete: false })).toBe(2);
    // A reply with no usage block is read as incomplete with 0 images.
    expect(billedUpperBound({ threw: false, metered: 0, complete: false })).toBe(2);
    expect(billedUpperBound({ threw: true, metered: 0, complete: false })).toBe(2);
  });
});

describe("ImageAllowance", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "allowance-")), "spend.json");

  it("reserves two images before each call, refuses a call the cap can't hold, and settles to the upper bound", () => {
    const path = fresh();
    const allowance = new ImageAllowance(path, 4);
    expect(allowance.admit()).toBe(true);
    allowance.settle({ threw: false, metered: 1, complete: true });
    expect(allowance.admit()).toBe(true);
    allowance.settle({ threw: false, metered: 1, complete: false });
    expect(allowance.state()).toMatchObject({ upperBoundImages: 3, calls: 2, refused: 0 });
    expect(allowance.admit()).toBe(false);
    expect(allowance.state()).toMatchObject({ upperBoundImages: 3, refused: 1 });
  });

  it("keeps the whole reservation while a call is unsettled, and carries the total across a restart", () => {
    const path = fresh();
    const first = new ImageAllowance(path, 6);
    expect(first.admit()).toBe(true);
    // The process dies here: the reservation stays on disk.
    const again = new ImageAllowance(path, 6);
    expect(again.state()).toMatchObject({ upperBoundImages: 2, open: 1 });
    expect(again.admit()).toBe(true);
    again.settle({ threw: false, metered: 1, complete: true });
    expect(again.admit()).toBe(true);
    expect(again.admit()).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cap: 6, upperBoundImages: 5, open: 2 });
  });

  it("refuses to start against a file written with a different cap", () => {
    const path = fresh();
    new ImageAllowance(path, 6).admit();
    expect(() => new ImageAllowance(path, 10)).toThrow(/cap/);
  });
});
