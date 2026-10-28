import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outputTextOf, parseSamText, placeRaster } from "./sam";

function fixture(name: string) {
  return parseSamText(outputTextOf(JSON.parse(readFileSync(`test/fixtures/sam/${name}.json`, "utf8"))));
}

describe("parseSamText on saved SAM 3.1 replies", () => {
  it("finds the 7 people on quiapo-1 and none on quiapo-2", () => {
    expect(fixture("quiapo-1__person")).toHaveLength(7);
    expect(fixture("quiapo-2__person")).toHaveLength(0);
  });

  it("finds one flood-water region on each photo", () => {
    expect(fixture("quiapo-1__flood_water")).toHaveLength(1);
    expect(fixture("quiapo-2__flood_water")).toHaveLength(1);
  });

  it("treats empty output as zero matches", () => {
    expect(parseSamText("")).toEqual([]);
  });
});

describe("placeRaster", () => {
  it("maps a person mask about 1:1 onto its box", () => {
    const [first] = fixture("quiapo-1__person");
    const placed = placeRaster(first.mask);
    expect(placed.raster).toHaveLength(placed.width * placed.height);
    expect(placed.scaleX).toBeCloseTo(1, 1);
    expect(placed.scaleY).toBeCloseTo(1, 1);
  });

  it("scales the downscaled 1024-wide water mask back to its 1280-wide box", () => {
    const [water] = fixture("quiapo-1__flood_water");
    const placed = placeRaster(water.mask);
    expect(placed.width).toBe(1024);
    expect(placed.bounds.right - placed.bounds.left).toBeGreaterThan(1270);
    expect(placed.scaleX).toBeCloseTo(1.25, 2);
    expect(placed.scaleY).toBeCloseTo(1.25, 2);
    expect(placed.raster.some((v) => v === 1)).toBe(true);
  });
});
