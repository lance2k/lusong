import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { outputTextOf, type Box, type PlacedRaster } from "../lib/sam";
import { runPlateProbe, scorePlates } from "./plate-recall";

/** A filled mask raster over `bounds`, `scale` source pixels per raster pixel. */
function filled(bounds: Box, scale = 1): { box: Box; placed: PlacedRaster } {
  const width = Math.round((bounds.right - bounds.left) / scale);
  const height = Math.round((bounds.bottom - bounds.top) / scale);
  return { box: bounds, placed: { raster: new Uint8Array(width * height).fill(1), width, height, bounds, scaleX: scale, scaleY: scale } };
}

const plate = { box: { left: 100, top: 50, right: 140, bottom: 70 }, sure: true };

describe("scorePlates", () => {
  it("finds a plate whose box a mask covers, and counts no false mask", () => {
    const score = scorePlates([plate], [filled({ left: 98, top: 48, right: 142, bottom: 72 })]);
    expect(score.plates).toEqual([{ found: true, coverage: 1, sure: true }]);
    expect(score.falseMasks).toBe(0);
  });

  it("misses a plate when the only mask is elsewhere, and counts that mask as false", () => {
    const score = scorePlates([plate], [filled({ left: 300, top: 300, right: 340, bottom: 320 })]);
    expect(score.plates).toEqual([{ found: false, coverage: 0, sure: true }]);
    expect(score.falseMasks).toBe(1);
  });

  it("reads coverage through a downscaled mask raster: the left half of the plate is 0.5, below the 0.6 bar", () => {
    const score = scorePlates([plate], [filled({ left: 100, top: 50, right: 120, bottom: 70 }, 2)], 0.6);
    expect(score.plates[0]).toEqual({ found: false, coverage: 0.5, sure: true });
  });

  it("adds up coverage across masks, so two halves find the plate", () => {
    const halves = [filled({ left: 100, top: 50, right: 120, bottom: 70 }), filled({ left: 120, top: 50, right: 140, bottom: 70 })];
    expect(scorePlates([plate], halves).plates[0].found).toBe(true);
  });

  it("counts every mask on a photo with no labelled plate as false", () => {
    expect(scorePlates([], [filled({ left: 0, top: 0, right: 10, bottom: 10 }), filled({ left: 20, top: 0, right: 30, bottom: 10 })]).falseMasks).toBe(2);
  });
});

describe("runPlateProbe, offline on a recorded SAM reply", () => {
  const carText = outputTextOf(JSON.parse(readFileSync("test/fixtures/sam/shah-alam-2021__car.json", "utf8")));
  const carCutBetweenObjects = carText.slice(0, carText.indexOf("|>,") + 2);
  const completed = (text: string) => ({ text, status: "completed" });
  const labels = {
    positives: [{ file: "acceptance/shah-alam-2021.jpg", plates: [{ box: { left: 10, top: 880, right: 98, bottom: 925 }, sure: true }, { box: { left: 0, top: 0, right: 20, bottom: 20 }, sure: true }] }],
    negatives: [{ file: "acceptance/new-orleans-2018.jpg" }],
  };

  it("makes one call per photo and prompt, scores each prompt and both together, and keeps the raw replies", async () => {
    const calls: string[] = [];
    const summary = await runPlateProbe(labels, ["license plate", "number plate"], async (file, prompt) => {
      calls.push(`${file}|${prompt}`);
      return completed(carText);
    });
    expect(calls).toEqual([
      "acceptance/shah-alam-2021.jpg|license plate",
      "acceptance/shah-alam-2021.jpg|number plate",
      "acceptance/new-orleans-2018.jpg|license plate",
      "acceptance/new-orleans-2018.jpg|number plate",
    ]);
    expect(summary.samCalls).toBe(4);
    const [shahAlam, newOrleans] = summary.photos;
    // The car masks of the recorded reply cover the Mazda's plate, and nothing is at the top-left corner.
    expect(shahAlam.calls[0].masks).toHaveLength(12);
    expect(shahAlam.both.plates.map((p) => p.found)).toEqual([true, false]);
    expect(shahAlam.calls[0].rawText).toBe(carText);
    expect(newOrleans.both.falseMasks).toBe(24);
    expect(summary.result).toMatchObject({
      platePhotos: 1,
      surePlates: 2,
      both: { surePlatesFound: 1, photosWithEverySurePlateFound: 0, photosWithAnyPlateFound: 1 },
      negativePhotos: 1,
      negativeFalseMasks: { "license plate": 12, "number plate": 12 },
      negativeCalls: { "license plate": { succeeded: 1, failed: 0 }, "number plate": { succeeded: 1, failed: 0 } },
      positiveCalls: { "license plate": { succeeded: 1, failed: 0 }, "number plate": { succeeded: 1, failed: 0 } },
      malformedReplies: 0,
    });
  });

  it("records a positive reply cut between two objects as a malformed, failed call that finds no plate", async () => {
    const summary = await runPlateProbe(labels, ["license plate"], async (file) =>
      completed(file.startsWith("acceptance/shah") ? carCutBetweenObjects : ""),
    );
    expect(summary.photos[0].calls[0]).toMatchObject({ ok: false, error: "malformed reply: unterminated", masks: [], rawText: carCutBetweenObjects });
    expect(summary.photos[0].both.plates.map((p) => p.found)).toEqual([false, false]);
    expect(summary.result).toMatchObject({
      both: { surePlatesFound: 0 },
      positiveCalls: { "license plate": { succeeded: 0, failed: 1 } },
      negativeCalls: { "license plate": { succeeded: 1, failed: 0 } },
      malformedReplies: 1,
    });
  });

  it("does not count a malformed negative reply as a clean zero-mask negative", async () => {
    const summary = await runPlateProbe(labels, ["license plate"], async (file) =>
      file.startsWith("acceptance/shah") ? completed(carText) : completed("No licence plate is visible.\n"),
    );
    expect(summary.photos[1].calls[0]).toMatchObject({ ok: false, error: "malformed reply: stray_text", masks: [] });
    expect(summary.result).toMatchObject({
      negativeFalseMasks: { "license plate": 0 },
      negativeCalls: { "license plate": { succeeded: 0, failed: 1 } },
      malformedReplies: 1,
    });
  });

  it("counts a negative call that failed apart from the negatives that ran, so its zero false masks are not read as clean", async () => {
    const summary = await runPlateProbe(labels, ["license plate"], async (file) => {
      if (file.startsWith("acceptance/shah")) return completed(carText);
      throw new Error("Meta API /responses failed with HTTP 500");
    });
    expect(summary.result).toMatchObject({
      negativeFalseMasks: { "license plate": 0 },
      negativeCalls: { "license plate": { succeeded: 0, failed: 1 } },
      positiveCalls: { "license plate": { succeeded: 1, failed: 0 } },
      malformedReplies: 0,
    });
  });

  it("records a reply Meta did not mark completed as malformed, with its status", async () => {
    const summary = await runPlateProbe(labels, ["license plate"], async () => ({ text: carText, status: "incomplete" }));
    expect(summary.photos[0].calls[0]).toMatchObject({ ok: false, error: "malformed reply: not_completed", status: "incomplete" });
  });

  it("records a failed call and counts its photo as not found", async () => {
    const summary = await runPlateProbe(labels, ["license plate"], async () => {
      throw new Error("Meta API /responses failed with HTTP 500");
    });
    expect(summary.photos[0].calls[0]).toMatchObject({ ok: false, error: "Meta API /responses failed with HTTP 500", masks: [] });
    expect(summary.result.both.surePlatesFound).toBe(0);
  });
});

describe("the plate labels", () => {
  const labels = JSON.parse(readFileSync("test/fixtures/sam/plates-labels.json", "utf8")) as {
    positives: { file: string; plates: { box: Box; sure: boolean; readable: boolean }[] }[];
    negatives: { file: string }[];
  };

  it("name fixture photos that exist, and every plate box lies inside its photo", async () => {
    for (const { file, plates } of labels.positives) {
      const { width = 0, height = 0 } = await sharp(`test/fixtures/${file}`).metadata();
      for (const { box } of plates) {
        expect(box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height && box.left < box.right && box.top < box.bottom, `${file} ${JSON.stringify(box)}`).toBe(true);
      }
    }
    for (const { file } of labels.negatives) expect(existsSync(`test/fixtures/${file}`), file).toBe(true);
  });

  it("hold at most 10 plate photos with at least one sure plate each, and 2 negatives", () => {
    expect(labels.positives.length).toBeLessThanOrEqual(10);
    expect(labels.positives.every((p) => p.plates.some((plate) => plate.sure))).toBe(true);
    expect(labels.negatives).toHaveLength(2);
  });
});
