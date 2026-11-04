import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePolyline6 } from "./router";
import { distanceM, placeOnRoute, ROUTE_CORRIDOR_M } from "./answer";
import { boxAround, detourAvoids, EXCLUDE_BOX_M, lineEntersArea, lineForTrip, ROUTE_END_TOLERANCE_M } from "./detour";

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

  it("a segment lying wholly inside the box, crossing no edge, enters it; so does a one-point line inside it", () => {
    const a = { lat: PROBE_SPOT.lat - 0.0003, lon: PROBE_SPOT.lon };
    const b = { lat: PROBE_SPOT.lat + 0.0003, lon: PROBE_SPOT.lon };
    expect(lineEntersArea([a, b], box)).toBe(true);
    expect(lineEntersArea([PROBE_SPOT], box)).toBe(true);
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

describe("whether a route reaches the trip's ends (#41)", () => {
  const start = PLAIN_LINE[0];
  const end = PLAIN_LINE[PLAIN_LINE.length - 1];
  /** A pick `m` metres due west of the route's start, as from inside a big lot. */
  const westOf = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat, lon: p.lon - m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) });

  it.each([
    ["Jaro plaza", 51],
    ["Burnham Park", 56.5],
    ["SM City Baguio", 67.7],
    ["SM City Iloilo", 79.1],
    ["Ayala Center Cebu", 114.8],
  ])("a start in a big lot that Valhalla snapped %s's measured %s m away is used", (_place, m) => {
    const from = westOf(start, m);
    expect(distanceM(from, start)).toBeCloseTo(m, 0);
    expect(lineForTrip(PLAIN_LINE, { from, to: end })).not.toBeNull();
    expect(lineForTrip(PLAIN_LINE, { from: start, to: westOf(end, m) })).not.toBeNull();
  });

  it("a route whose start or end is more than 150 m from the trip's is refused", () => {
    expect(ROUTE_END_TOLERANCE_M).toBe(150);
    expect(lineForTrip(PLAIN_LINE, { from: westOf(start, 151), to: end })).toBeNull();
    expect(lineForTrip(PLAIN_LINE, { from: start, to: westOf(end, 151) })).toBeNull();
    expect(lineForTrip(PLAIN_LINE, { from: westOf(start, 300), to: westOf(end, 300) })).toBeNull();
  });

  it("the gap from the pick to the road is judged with the route: a blocked spot in it is on the line", () => {
    const from = westOf(start, 114.8);
    const line = lineForTrip(PLAIN_LINE, { from, to: end })!;
    expect(line[0]).toEqual(from);
    const inTheGap = westOf(start, 60);
    expect(placeOnRoute(inTheGap, PLAIN_LINE).offM).toBeGreaterThan(ROUTE_CORRIDOR_M);
    expect(placeOnRoute(inTheGap, line).offM).toBeLessThan(1);
    expect(detourAvoids(line, [inTheGap])).toBe(false);
  });
});
