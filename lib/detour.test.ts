import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePolyline6 } from "./router";
import { boxAround, detourAvoids, EXCLUDE_BOX_M, lineEntersArea } from "./detour";

const EXCLUDED_REQUEST = JSON.parse(readFileSync("test/fixtures/valhalla/banilad-itpark-excluded.request.json", "utf8"));
/** The spot the 2026-10-30 01:16 PHT probe excluded: the Banilad → IT Park route's midpoint, on Governor M. Cuenco Avenue. */
const PROBE_SPOT = { lat: 10.335398, lon: 123.910908 };
const lineOf = (file: string) => decodePolyline6(JSON.parse(readFileSync(`test/fixtures/valhalla/${file}`, "utf8")).trip.legs[0].shape);
const PLAIN_LINE = lineOf("banilad-itpark-plain.json");
const EXCLUDED_LINE = lineOf("banilad-itpark-excluded.json");

describe("the area excluded around a blocked spot", () => {
  it("is the 330 m box the 2026-10-30 probe sent to Valhalla", () => {
    expect(EXCLUDE_BOX_M).toBe(330);
    const ring = boxAround(PROBE_SPOT).map((p) => [p.lon, p.lat]);
    const sent: number[][] = EXCLUDED_REQUEST.exclude_polygons[0];
    expect(ring).toHaveLength(sent.length);
    ring.forEach(([lon, lat], i) => {
      expect(lon).toBeCloseTo(sent[i][0], 9);
      expect(lat).toBeCloseTo(sent[i][1], 9);
    });
  });
});

describe("whether a route enters an excluded area (segment–polygon intersection)", () => {
  const box = boxAround(PROBE_SPOT);
  const [sw, , ne] = box;

  it("the plain route runs through the probe's box; the route Valhalla returned with it excluded never enters it", () => {
    expect(lineEntersArea(PLAIN_LINE, box)).toBe(true);
    expect(lineEntersArea(EXCLUDED_LINE, box)).toBe(false);
  });

  it("a segment that crosses the box with both endpoints outside it enters it (🔴P4)", () => {
    const west = { lat: PROBE_SPOT.lat, lon: sw.lon - 0.001 };
    const east = { lat: PROBE_SPOT.lat, lon: ne.lon + 0.001 };
    expect(lineEntersArea([west, east], box)).toBe(true);
  });

  it("a segment that cuts only a corner of the box enters it", () => {
    const justWest = { lat: ne.lat - 0.0002, lon: sw.lon - 0.0001 };
    const justNorth = { lat: ne.lat + 0.0001, lon: sw.lon + 0.0002 };
    expect(lineEntersArea([justWest, justNorth], box)).toBe(true);
  });

  it("a segment passing just outside the box, or a point inside it, are told apart", () => {
    const north = ne.lat + 0.0001;
    expect(lineEntersArea([{ lat: north, lon: sw.lon - 0.001 }, { lat: north, lon: ne.lon + 0.001 }], box)).toBe(false);
    expect(lineEntersArea([{ lat: north, lon: PROBE_SPOT.lon }, PROBE_SPOT], box)).toBe(true);
  });
});

describe("whether a returned route is a way around the blocked spots", () => {
  it("the route Valhalla returned around the probe's spot is", () => {
    expect(detourAvoids(EXCLUDED_LINE, [PROBE_SPOT])).toBe(true);
  });

  it("it is not when it enters the box of any one of the blocked spots", () => {
    const onTheDetour = EXCLUDED_LINE[70];
    expect(detourAvoids(EXCLUDED_LINE, [PROBE_SPOT, onTheDetour])).toBe(false);
  });

  it("it is not when a blocked spot lies within the route's 30 m corridor, even outside a smaller box", () => {
    const beside = { lat: EXCLUDED_LINE[70].lat + 25 / 111_320, lon: EXCLUDED_LINE[70].lon };
    expect(lineEntersArea(EXCLUDED_LINE, boxAround(beside, 20))).toBe(false);
    expect(detourAvoids(EXCLUDED_LINE, [beside], 20)).toBe(false);
  });
});
