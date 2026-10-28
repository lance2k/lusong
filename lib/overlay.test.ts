import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lowestRowY, maskToPlacedPath, waterlineY } from "./overlay";
import { outputTextOf, parseSamText, placeRaster, type PlacedRaster } from "./sam";

function fixture(name: string) {
  return parseSamText(outputTextOf(JSON.parse(readFileSync(`test/fixtures/sam/${name}.json`, "utf8"))));
}

function block(left: number, top: number, width: number, height: number, fill: (row: number) => boolean): PlacedRaster {
  const raster = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) if (fill(row)) raster.fill(1, row * width, (row + 1) * width);
  return { raster, width, height, bounds: { left, top, right: left + width, bottom: top + height }, scaleX: 1, scaleY: 1 };
}

describe("lowestRowY", () => {
  it("returns the bottom edge of the lowest filled row in source pixels", () => {
    expect(lowestRowY(block(10, 100, 4, 50, (row) => row < 30))).toBe(130);
  });
  it("returns null for an empty mask", () => {
    expect(lowestRowY(block(0, 0, 4, 4, () => false))).toBeNull();
  });
});

describe("waterlineY", () => {
  const person = block(100, 100, 20, 60, (row) => row < 40);
  const box = { left: 100, top: 100, right: 120, bottom: 160 };

  it("gives the line when the person's mask ends at the water", () => {
    const water = block(0, 139, 300, 100, () => true);
    expect(waterlineY(person, box, [water])).toBe(140);
  });

  it("omits the line when water is inside the box band but away from the object's own pixels", () => {
    const leftColumnOnly: PlacedRaster = {
      ...person,
      raster: Uint8Array.from({ length: 20 * 60 }, (_, i) => (i % 20 === 0 && i < 40 * 20 ? 1 : 0)),
    };
    const waterAtRightEdge = block(118, 138, 2, 4, () => true);
    expect(waterlineY(leftColumnOnly, box, [waterAtRightEdge])).toBeNull();
    const waterUnderIt = block(98, 138, 4, 4, () => true);
    expect(waterlineY(leftColumnOnly, box, [waterUnderIt])).toBe(140);
  });

  it("omits the line when the lowest edge is nowhere near water", () => {
    const farWater = block(0, 200, 300, 50, () => true);
    expect(waterlineY(person, box, [farWater])).toBeNull();
    expect(waterlineY(person, box, [])).toBeNull();
  });

  it("finds waterlines on real wading people in quiapo-1", () => {
    const water = fixture("quiapo-1__flood_water").map((o) => placeRaster(o.mask));
    const people = fixture("quiapo-1__person");
    const lines = people.map((p) => waterlineY(placeRaster(p.mask), p.box, water));
    expect(lines.filter((y) => y !== null).length).toBeGreaterThanOrEqual(3);
    for (const [i, y] of lines.entries()) {
      if (y === null) continue;
      expect(y).toBeGreaterThan(people[i].box.top);
      expect(y).toBeLessThanOrEqual(people[i].box.bottom + 1);
    }
  });
});

/** Applies the transform string the way SVG does (right to left) and returns the path's extents. */
function placedExtents(placed: { d: string; transform: string }) {
  const [tx, ty, sx, sy, ox, oy] = placed.transform.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const nums = placed.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0).map((x) => tx + sx * (x + ox));
  const ys = nums.filter((_, i) => i % 2 === 1).map((y) => ty + sy * (y + oy));
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe("maskToPlacedPath", () => {
  it("lands a person's outline inside its source bounds, not half a pixel up and left", () => {
    const [first] = fixture("quiapo-1__person");
    const extents = placedExtents(maskToPlacedPath(first.mask));
    expect(extents.left).toBeGreaterThanOrEqual(first.mask.bounds.left);
    expect(extents.top).toBeGreaterThanOrEqual(first.mask.bounds.top);
    expect(extents.right).toBeLessThanOrEqual(first.mask.bounds.right);
    expect(extents.bottom).toBeLessThanOrEqual(first.mask.bounds.bottom);
  });

  it("scales the 1024-wide water path back onto the photo", () => {
    const [water] = fixture("quiapo-1__flood_water");
    const placed = maskToPlacedPath(water.mask);
    expect(placed.d.length).toBeGreaterThan(100);
    expect(placed.transform).toMatch(/^translate\(\d+ \d+\) scale\(1\.2\d* 1\.2\d*\) translate\(0\.5 0\.5\)$/);
    const extents = placedExtents(placed);
    expect(extents.right).toBeLessThanOrEqual(water.mask.bounds.right);
    expect(extents.right).toBeGreaterThan(water.mask.bounds.right - 2);
  });
});
