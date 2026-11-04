import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outputTextOf, parseSamText, placeRaster, type Box, type PlacedRaster } from "./sam";
import { TYRE_GEOMETRY, tyreCapDepth, tyreDepthCm, tyreEstimates, tyreEstimatesV2 } from "./tyre";
import type { Interval } from "./verdict";

describe("tyreDepthCm: a round tyre, cut by the waterline", () => {
  it("a tyre with nothing hidden gives no estimate, since a wheel seen at an angle and half under water looks the same", () => {
    // A 40 × 80 px ellipse, half under water, leaves a 40 × 40 box: as round as a dry side-on tyre.
    expect(tyreDepthCm({ width: 40, height: 40 })).toBeNull();
    expect(tyreDepthCm({ width: 60, height: 60 })).toBeNull();
  });

  it("a tyre whose top the car body hides reads deeper than the water, never shallower", () => {
    // A 60 px tyre: 15 px under the wheel arch, 15 px under water, so the water covers 15 / 60 of it (14.5–17.5 cm).
    const estimate = tyreDepthCm({ width: 60, height: 30 })!;
    expect(estimate.low).toBeGreaterThanOrEqual(Math.floor((15 / 60) * 58));
    expect(estimate).toEqual({ low: 29, high: 35 });
  });

  it("with more than half showing, the width is the diameter and the hidden part is the depth", () => {
    // 57 × 36 px: 21 of 57 px hidden, 0.368 of a 58–70 cm tyre.
    expect(tyreDepthCm({ width: 57, height: 36 })).toEqual({ low: 21, high: 26 });
  });

  it("with less than half showing, the diameter comes from the visible cap", () => {
    // Chord 20 px, cap 5 px high: radius (100 + 25) / 10 = 12.5 px, so 20 of 25 px are hidden.
    expect(tyreDepthCm({ width: 20, height: 5 })).toEqual({ low: 46, high: 56 });
  });

  it("a tyre taller than it is wide is seen at an angle, so its width is not its diameter: no estimate", () => {
    expect(tyreDepthCm({ width: 27, height: 35 })).toBeNull();
  });

  it("a tyre too small to measure gives no estimate", () => {
    expect(tyreDepthCm({ width: 10, height: 6 })).toBeNull();
  });
});

describe("tyreEstimates on SAM's recorded masks", () => {
  const load = (photo: string, phrase: string) =>
    parseSamText(outputTextOf(JSON.parse(readFileSync(`test/fixtures/sam/${photo}__${phrase}.json`, "utf8"))));
  const carsOf = (photo: string) => load(photo, "car").map((object, i) => ({ label: `C${i + 1}`, box: object.box }));
  const waterOf = (photo: string) => load(photo, "flood_water").map((w) => placeRaster(w.mask));

  it("estimates only side-on tyres that touch the water inside a car's box", () => {
    // Of Shah Alam's 8 tyres, 6 are more than 10 % taller than wide (seen at an angle). The 57 × 36 px one lies in
    // C11 alone, with 21 of 57 px hidden; the 28 × 31 px one is taller than wide.
    expect(tyreEstimates(carsOf("shah-alam-2021"), load("shah-alam-2021", "tire"), waterOf("shah-alam-2021"))).toEqual([
      { label: "C11", interval: { low: 21, high: 26 } },
    ]);
    // Manila's one tyre is 27 × 14 px inside C1: 13 of 27 px hidden, 0.48 of a 58–70 cm tyre.
    const manila = "manila-2012-raincoats";
    expect(tyreEstimates(carsOf(manila), load(manila, "tire"), waterOf(manila))).toEqual([{ label: "C1", interval: { low: 27, high: 34 } }]);
  });

  it("a tyre that does not touch the water gives no estimate", () => {
    expect(tyreEstimates(carsOf("shah-alam-2021"), load("shah-alam-2021", "tire"), [])).toEqual([]);
  });

  it("a tyre outside every car's box gives no estimate", () => {
    const manila = "manila-2012-raincoats";
    expect(tyreEstimates([], load(manila, "tire"), waterOf(manila))).toEqual([]);
  });
});

/** A placed raster from a predicate over source pixels (scale 1), for synthetic masks. */
function raster(bounds: Box, filled: (x: number, y: number) => boolean): PlacedRaster {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const r = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) r[row * width + col] = filled(bounds.left + col, bounds.top + row) ? 1 : 0;
  return { raster: r, width, height, bounds, scaleX: 1, scaleY: 1 };
}

/** A circle of diameter `d` at (cx, cy), cut flat at `cutY` (everything below the cut is hidden). */
function cutTyre(cx: number, cy: number, d: number, cutY: number) {
  const r = d / 2;
  const top = Math.round(cy - r);
  const box = { left: Math.round(cx - r), top, right: Math.round(cx + r), bottom: Math.min(cutY, Math.round(cy + r)) };
  const inside = (x: number, y: number) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r && y < cutY;
  let left = box.right, right = box.left;
  for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) if (inside(x, y)) { left = Math.min(left, x); right = Math.max(right, x + 1); }
  const tight = { ...box, left, right };
  return { box: tight, mask: raster(tight, inside) };
}

const waterBelow = (y: number, left = 0, right = 400) => raster({ left, top: y, right, bottom: y + 40 }, () => true);

describe("tyreCapDepth (v2): the hidden fraction of a round tyre, from its visible cap", () => {
  const car: Interval = { low: 58, high: 70 };

  it("with more than half showing, the widest width is the diameter", () => {
    // 57 × 36 px: 21 of 57 px hidden, the same 21–26 cm as v1.
    expect(tyreCapDepth({ width: 57, height: 36, chord: 44 }, car)).toEqual({ fraction: 21 / 57, interval: { low: 21, high: 26 } });
  });

  it("with less than half showing, the circle comes from the chord and the cap height: R = (w²/4 + h²) / 2h", () => {
    // Chord 40, cap 10: R = (400 + 100) / 20 = 25, so 40 of 50 px are hidden (0.8 of 58–70 cm).
    expect(tyreCapDepth({ width: 40, height: 10, chord: 40 }, car)).toEqual({ fraction: 0.8, interval: { low: 46, high: 56 } });
  });

  it("a cap too flat for its chord gives no estimate, where v1's radius blows up to a full tyre", () => {
    // Chord 40, cap 2: v1 reads a 202 px circle, 99 % under water, 57–70 cm.
    expect(tyreDepthCm({ width: 40, height: 2 })).toEqual({ low: 57, high: 70 });
    expect(tyreCapDepth({ width: 40, height: 2, chord: 40 }, car)).toBeNull();
    // The floor is max(6 px, 0.2 × chord): 7 px under a 40 px chord is too flat, 8 px is enough.
    expect(tyreCapDepth({ width: 40, height: 7, chord: 40 }, car)).toBeNull();
    expect(tyreCapDepth({ width: 40, height: 8, chord: 40 })).not.toBeNull();
    expect(tyreCapDepth({ width: 20, height: 5, chord: 20 }, car)).toBeNull();
  });

  it("a tyre taller than it is wide is seen at an angle: no estimate", () => {
    expect(tyreCapDepth({ width: 27, height: 35, chord: 20 }, car)).toBeNull();
  });

  it("a tyre too small to measure, or with nothing hidden, gives no estimate", () => {
    expect(tyreCapDepth({ width: 10, height: 6, chord: 10 }, car)).toBeNull();
    expect(tyreCapDepth({ width: 60, height: 60, chord: 10 }, car)).toBeNull();
  });

  it("a ragged bottom that measures a narrower chord reads a smaller circle and a shallower depth, never deeper", () => {
    const flat = tyreCapDepth({ width: 40, height: 10, chord: 40 }, car)!;
    const ragged = tyreCapDepth({ width: 40, height: 10, chord: 34 }, car)!;
    expect(ragged.fraction).toBeLessThan(flat.fraction);
  });
});

describe("tyreEstimates (v2) on drawn masks", () => {
  const carBox = { label: "C1", box: { left: 0, top: 0, right: 300, bottom: 200 } };

  it("a photo with no tyre gives no estimates", () => {
    expect(tyreEstimatesV2([carBox], [], [waterBelow(150)])).toEqual([]);
  });

  it("a 60 px tyre cut 15 px above its bottom, on water, reads a quarter of a 58–70 cm tyre", () => {
    const tyre = cutTyre(100, 120, 60, 135);
    expect(tyreEstimatesV2([carBox], [tyre], [waterBelow(135)])).toEqual([{ label: "C1", fraction: 0.25, interval: { low: 14, high: 18 } }]);
  });

  it("a tyre whose cut edge lies on water for under half its columns is hidden by something else: no estimate", () => {
    const tyre = cutTyre(100, 120, 60, 135);
    // Water under only the left 30 % of the cut edge (the rest behind a kerb or a leg).
    const partial = waterBelow(135, 0, tyre.box.left + Math.floor(0.3 * (tyre.box.right - tyre.box.left)));
    expect(tyreEstimatesV2([carBox], [tyre], [partial])).toEqual([]);
    // Under 60 %, it counts.
    const most = waterBelow(135, 0, tyre.box.left + Math.ceil(0.6 * (tyre.box.right - tyre.box.left)));
    expect(tyreEstimatesV2([carBox], [tyre], [most])).toHaveLength(1);
  });

  it("a tyre with no water at its cut gives no estimate", () => {
    expect(tyreEstimatesV2([carBox], [cutTyre(100, 120, 60, 135)], [])).toEqual([]);
  });

  it("a whole dry tyre on the same car that is squashed flat shows an angled view: the car's cut tyres give no estimate", () => {
    const cut = cutTyre(100, 120, 60, 135);
    const squashed = { box: { left: 200, top: 100, right: 260, bottom: 142 }, mask: raster({ left: 200, top: 100, right: 260, bottom: 142 }, () => true) };
    expect(tyreEstimatesV2([carBox], [cut, squashed], [waterBelow(135, 0, 190)])).toEqual([]);
    const round = { box: { left: 200, top: 80, right: 260, bottom: 140 }, mask: raster({ left: 200, top: 80, right: 260, bottom: 140 }, () => true) };
    expect(tyreEstimatesV2([carBox], [cut, round], [waterBelow(135, 0, 190)])).toHaveLength(1);
  });

  it("a cut tyre outside every car's box is kept under its own label, with a 45–70 cm diameter", () => {
    const tyre = cutTyre(100, 320, 60, 335);
    expect(tyreEstimatesV2([carBox], [tyre], [waterBelow(335)])).toEqual([{ label: "T1", fraction: 0.25, interval: { low: 11, high: 18 } }]);
  });

  it("one estimate per car, from its deepest tyre", () => {
    const shallow = cutTyre(60, 120, 60, 140);
    const deep = cutTyre(200, 120, 60, 130);
    const [only] = tyreEstimatesV2([carBox], [shallow, deep], [waterBelow(130)]);
    expect(only.label).toBe("C1");
    expect(only.fraction).toBeCloseTo(20 / 60, 1);
  });
});

describe("tyreEstimatesV2 on SAM's recorded masks", () => {
  const load = (photo: string, phrase: string) =>
    parseSamText(outputTextOf(JSON.parse(readFileSync(`test/fixtures/sam/${photo}__${phrase}.json`, "utf8"))));
  const run = (photo: string) =>
    tyreEstimatesV2(
      load(photo, "car").map((object, i) => ({ label: `C${i + 1}`, box: object.box })),
      load(photo, "tire").map((t) => ({ box: t.box, mask: placeRaster(t.mask) })),
      load(photo, "flood_water").map((w) => placeRaster(w.mask)),
    );

  it("Manila's one tyre: its whole 27 px cut lies on water, 13 of 27 px hidden, as v1 reads it", () => {
    expect(run("manila-2012-raincoats")).toEqual([{ label: "C1", fraction: 13 / 27, interval: { low: 27, high: 34 } }]);
  });

  it("Shah Alam's side-on tyre has water under 3 of its 14 cut columns, so v2 abstains where v1 read 21–26 cm", () => {
    expect(run("shah-alam-2021")).toEqual([]);
  });
});

describe("tyreEstimates picks the geometry", () => {
  it("today's build runs v1, the shipped geometry", () => {
    expect(TYRE_GEOMETRY).toBe("v1");
  });
});
