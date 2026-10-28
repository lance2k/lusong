import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outputTextOf, parseSamText, placeRaster } from "./sam";
import { tyreDepthCm, tyreEstimates } from "./tyre";

describe("tyreDepthCm: a round tyre, cut by the waterline", () => {
  it("a whole tyre above the water is 0 cm deep", () => {
    expect(tyreDepthCm({ width: 60, height: 60 })).toEqual({ low: 0, high: 0 });
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
