import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { outputTextOf, type Box, type PlacedRaster } from "../lib/sam";
import { boxCoverage, scoreBlurProbe, type BlurLabels, type RecordedCall } from "./blur-recall";

function rectangle(bounds: Box): PlacedRaster {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return { raster: new Uint8Array(width * height).fill(1), width, height, bounds, scaleX: 1, scaleY: 1 };
}

/** A covered-pixel grid over a width × height photo with `box` set. */
function grid(width: number, height: number, ...boxes: Box[]): Uint8Array {
  const g = new Uint8Array(width * height);
  for (const b of boxes) for (let y = b.top; y < b.bottom; y++) g.fill(1, y * width + b.left, y * width + b.right);
  return g;
}

describe("boxCoverage", () => {
  const plate: Box = { left: 10, top: 10, right: 30, bottom: 20 };

  it("is 1 when every pixel of the box is covered", () => {
    expect(boxCoverage(plate, grid(50, 50, { left: 5, top: 5, right: 40, bottom: 25 }), 50)).toBe(1);
  });

  it("counts a box with one uncovered column as not covered", () => {
    const coverage = boxCoverage(plate, grid(50, 50, { left: 10, top: 10, right: 29, bottom: 20 }), 50);
    expect(coverage).toBeCloseTo(19 / 20);
    expect(coverage < 1).toBe(true);
  });

  it("counts a box over a hole in the mask as not covered", () => {
    const g = grid(50, 50, { left: 0, top: 0, right: 50, bottom: 50 });
    g[15 * 50 + 20] = 0;
    expect(boxCoverage(plate, g, 50)).toBeCloseTo(199 / 200);
  });
});

/** SAM's reply text for one object, built from a recorded reply so the grammar is real: the first object only. */
const carText = outputTextOf(JSON.parse(readFileSync("test/fixtures/sam/shah-alam-2021__car.json", "utf8")));
const oneObject = carText.slice(0, carText.indexOf("|>,") + 2) + "\n";

describe("scoreBlurProbe", () => {
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
  const plateMask = rectangle({ left: 20, top: 60, right: 50, bottom: 70 });
  const personMask = rectangle({ left: 140, top: 5, right: 180, bottom: 95 });
  /** Tags each reply text with the masks it stands for, so the scorer's strict read can be stubbed. */
  const read = (text: string) =>
    text === "fail" ? ({ ok: false, problem: "parse_error" } as const) : { ok: true as const, masks: JSON.parse(text) as PlacedRaster[] };
  const call = (prompt: string, masks: PlacedRaster[] | "fail"): RecordedCall =>
    masks === "fail" ? { prompt, ok: false, error: "HTTP 500" } : { prompt, ok: true, status: "completed", text: JSON.stringify(masks) };
  const reviveMasks = (masks: PlacedRaster[]) => masks.map((m) => ({ ...m, raster: Uint8Array.from(Object.values(m.raster)) }));
  const reader = (text: string) => {
    const r = read(text);
    return r.ok ? { ok: true as const, masks: reviveMasks(r.masks) } : r;
  };

  it("covers a photo when the plate mask covers the plate and the person mask the face", () => {
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("license plate", [plateMask]), call("person", [personMask])],
      "n.jpg": [call("license plate", []), call("person", [])],
    }, reader);
    expect(score.photos[0]).toMatchObject({ publishable: true, allCovered: true });
    expect(score.result).toMatchObject({ positives: 1, allCovered: 1, plates: { all: 1, covered: 1 }, faces: { all: 1, covered: 1 } });
    expect(score.result.negatives).toMatchObject({ photos: 1, publishable: 1, withMasks: 0 });
  });

  it("fails a photo whose plate call failed even when person masks cover every plate", () => {
    const bigPerson = rectangle({ left: 0, top: 0, right: 200, bottom: 100 });
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("license plate", "fail"), call("person", [bigPerson])],
      "n.jpg": [call("license plate", "fail"), call("person", [])],
    }, reader);
    expect(score.photos[0]).toMatchObject({ publishable: false, allCovered: false, failedCalls: ["license plate"] });
    // Per prompt, the plate is not covered by a plate mask; in the union it is, and the union is reported apart.
    expect(score.photos[0].plates[0]).toMatchObject({ byPrompt: 0, union: 1 });
    expect(score.result).toMatchObject({ allCovered: 0, plates: { covered: 0, coveredInUnion: 1 } });
    expect(score.result.negatives).toMatchObject({ publishable: 0 });
  });

  it("does not let a person mask over the plate count as plate coverage, nor a plate mask over the face as face coverage", () => {
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("license plate", [rectangle({ left: 140, top: 5, right: 180, bottom: 40 })]), call("person", [rectangle({ left: 15, top: 55, right: 55, bottom: 75 })])],
      "n.jpg": [call("license plate", []), call("person", [])],
    }, reader);
    expect(score.photos[0]).toMatchObject({ publishable: true, allCovered: false });
    expect(score.photos[0].plates[0].byPrompt).toBe(0);
    expect(score.photos[0].faces[0].byPrompt).toBe(0);
    expect(score.result.misses.map((m) => m.kind)).toEqual(["plate", "face"]);
  });

  it("scores the face prompt as an addition to the person masks, publishable only when it also succeeded", () => {
    const faceMask = rectangle({ left: 150, top: 10, right: 170, bottom: 30 });
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("license plate", [plateMask]), call("person", []), call("face", [faceMask])],
      "n.jpg": [call("license plate", []), call("person", []), call("face", "fail")],
    }, reader);
    expect(score.photos[0]).toMatchObject({ allCovered: false, allCoveredWithFace: true });
    expect(score.photos[0].faces[0]).toMatchObject({ byPrompt: 0, withFace: 1 });
    expect(score.result).toMatchObject({ allCovered: 0, allCoveredWithFace: 1, faces: { covered: 0, coveredWithFace: 1 } });
    expect(score.result.negatives).toMatchObject({ publishable: 1, publishableWithFace: 0 });
  });

  it("leaves the face prompt's masks out of the union, which is what publishPhoto blurs", () => {
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("license plate", []), call("person", [personMask]), call("face", [plateMask])],
      "n.jpg": [call("license plate", []), call("person", [])],
    }, reader);
    expect(score.photos[0].plates[0]).toMatchObject({ byPrompt: 0, union: 0 });
  });

  it("names a required call that was never recorded, and keeps each failure's reason", () => {
    const score = scoreBlurProbe(labels, sizes, {
      "p.jpg": [call("person", [personMask])],
      "n.jpg": [call("license plate", "fail"), { prompt: "person", ok: true, status: "completed", text: "fail" }],
    }, reader);
    expect(score.photos[0]).toMatchObject({ publishable: false, failedCalls: ["license plate"], failures: [{ prompt: "license plate", problem: "not recorded" }] });
    expect(score.photos[1].failures).toEqual([{ prompt: "license plate", problem: "HTTP 500" }, { prompt: "person", problem: "parse_error" }]);
  });

  it("holds the bar against unsure labels too, and reports the sure-only bar beside it", () => {
    const withUnsure: BlurLabels = {
      ...labels,
      positives: [{ ...labels.positives[0], plates: [...labels.positives[0].plates, { box: { left: 100, top: 80, right: 110, bottom: 85 }, sure: false }] }],
    };
    const score = scoreBlurProbe(withUnsure, sizes, {
      "p.jpg": [call("license plate", [plateMask]), call("person", [personMask])],
      "n.jpg": [call("license plate", []), call("person", [])],
    }, reader);
    expect(score.photos[0]).toMatchObject({ allCovered: false, allSureCovered: true });
  });

  it("reads real SAM text through the strict reader by default, and grows the mask as the blur does", () => {
    const box = { left: 0, top: 0, right: 1600, bottom: 1200 };
    const realLabels: BlurLabels = { positives: [{ file: "r.jpg", plates: [], faces: [{ box: { left: 700, top: 700, right: 701, bottom: 701 }, sure: true }] }], negatives: [] };
    const score = scoreBlurProbe(realLabels, { "r.jpg": { width: box.right, height: box.bottom } }, {
      "r.jpg": [{ prompt: "license plate", ok: true, status: "completed", text: "" }, { prompt: "person", ok: true, status: "completed", text: oneObject }],
    });
    expect(score.photos[0].publishable).toBe(true);
    expect(score.photos[0].masks).toEqual({ "license plate": 0, person: 1 });
    const cut = scoreBlurProbe(realLabels, { "r.jpg": { width: 1600, height: 1200 } }, {
      "r.jpg": [{ prompt: "license plate", ok: true, status: "completed", text: "" }, { prompt: "person", ok: true, status: "completed", text: oneObject.slice(0, -1) }],
    });
    expect(cut.photos[0]).toMatchObject({ publishable: false, failedCalls: ["person"] });
  });
});

describe("the blur labels", () => {
  const load = () => JSON.parse(readFileSync("test/fixtures/sam/blur-labels.json", "utf8")) as BlurLabels;

  it("name fixture photos that exist, under 1 MB and at most 1600 px, and every box lies inside its photo", async () => {
    const labels = load();
    for (const { file, plates, faces, identifiers = [] } of labels.positives) {
      const { width = 0, height = 0, size = 0 } = await sharp(readFileSync(`test/fixtures/${file}`)).metadata();
      expect(Math.max(width, height), file).toBeLessThanOrEqual(1600);
      expect(size || readFileSync(`test/fixtures/${file}`).length, file).toBeLessThan(1_000_000);
      for (const { box } of [...plates, ...faces, ...identifiers]) {
        expect(box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height && box.left < box.right && box.top < box.bottom, `${file} ${JSON.stringify(box)}`).toBe(true);
      }
    }
    for (const { file } of labels.negatives) expect(existsSync(`test/fixtures/${file}`), file).toBe(true);
  });

  it("hold 30 to 50 photos with a labelled plate or face each (the bar counts unsure ones too), and 4 to 8 negatives, every blur-set photo credited", () => {
    const labels = load();
    expect(labels.positives.length).toBeGreaterThanOrEqual(30);
    expect(labels.positives.length).toBeLessThanOrEqual(50);
    expect(labels.positives.every((p) => p.plates.length + p.faces.length > 0)).toBe(true);
    expect(labels.negatives.length).toBeGreaterThanOrEqual(4);
    expect(labels.negatives.length).toBeLessThanOrEqual(8);
    const credits = readFileSync("test/fixtures/blur-set/ATTRIBUTION.txt", "utf8");
    for (const { file } of [...labels.positives, ...labels.negatives].filter((p) => p.file.startsWith("blur-set/"))) {
      expect(credits.includes(file.slice("blur-set/".length)), file).toBe(true);
    }
  });
});
