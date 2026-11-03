import { describe, expect, it } from "vitest";
import { advisoryAreasFor, MAX_MAP_AREAS, MAX_MAP_POINTS } from "./advisory-areas";
import type { CapArea } from "./advisory-geo";
import type { AdvisoryKind, AdvisoryProduct, SnapshotReading } from "./advisory-snapshot";
import type { Point } from "./answer";

const NOW = new Date("2026-10-25T20:00:00+08:00");
const CEBU_CITY_LINE: Point[] = [
  { lat: 10.31, lon: 123.89 },
  { lat: 10.33, lon: 123.91 },
];
/** A detour through Mandaue, north-east of the plain line. */
const MANDAUE_LINE: Point[] = [
  { lat: 10.34, lon: 123.93 },
  { lat: 10.36, lon: 123.95 },
];

/** A closed [lon, lat, ...] square of `side` degrees around a point, with `perSide` points along each side. */
function square(center: Point, side: number, perSide = 1): number[] {
  const h = side / 2;
  const corners = [
    [center.lon - h, center.lat - h],
    [center.lon + h, center.lat - h],
    [center.lon + h, center.lat + h],
    [center.lon - h, center.lat + h],
  ];
  const ring: number[] = [];
  for (let c = 0; c < 4; c++) {
    const [a, b] = [corners[c], corners[(c + 1) % 4]];
    for (let k = 0; k < perSide; k++) ring.push(a[0] + ((b[0] - a[0]) * k) / perSide, a[1] + ((b[1] - a[1]) * k) / perSide);
  }
  return [...ring, ring[0], ring[1]];
}

const area = (desc: string, polygons: number[][], geocodes: string[] = []): CapArea => ({ desc, polygons, geocodes });

function product(id: string, areas: CapArea[], over: Partial<AdvisoryProduct> & { kind?: AdvisoryKind } = {}): AdvisoryProduct {
  return {
    id,
    link: `https://publicalert.pagasa.dost.gov.ph/output/gfa/${id}.cap`,
    kind: "flood",
    event: "General Flood Advisory (Moderate)",
    headline: "General Flood Advisory",
    sent: "2026-10-25T17:27:04+08:00",
    infos: [{ expires: "2026-10-26T05:27:04+08:00", rainForecast: null, rivers: [], areas }],
    ...over,
  };
}

const reading = (...products: AdvisoryProduct[]): SnapshotReading => ({
  snapshot: { generation: 1, fetchedAt: NOW.toISOString(), complete: true, why: null, entries: [], products },
});

describe("advisory areas for the map", () => {
  it("lists only the areas covering the plain route or a detour, with PAGASA's event, headline and times, rings as [lat, lon]", () => {
    const plainArea = area("Cebu", [square({ lat: 10.32, lon: 123.9 }, 0.1)]);
    const detourArea = area("Mandaue", [square({ lat: 10.35, lon: 123.94 }, 0.03)]);
    const elsewhere = area("Davao del Sur", [square({ lat: 7.0, lon: 125.5 }, 0.2)]);
    const areas = advisoryAreasFor(reading(product("a", [plainArea, elsewhere]), product("b", [detourArea])), [CEBU_CITY_LINE, MANDAUE_LINE], NOW);

    expect(areas.map((a) => a.rings[0][0].map((v) => Math.round(v * 1000) / 1000))).toEqual([
      [10.27, 123.85],
      [10.335, 123.925],
    ]);
    expect(areas[0]).toEqual({
      kind: "General Flood Advisory (Moderate)",
      rings: [plainArea.polygons[0].reduce<[number, number][]>((out, v, i, ring) => (i % 2 === 0 ? [...out, [ring[i + 1], v]] : out), [])],
      sent: "2026-10-25T17:27:04+08:00",
      expires: "2026-10-26T05:27:04+08:00",
      headline: "General Flood Advisory",
    });
  });

  it("a product with no headline is headed by its CAP event", () => {
    const [only] = advisoryAreasFor(reading(product("a", [area("Cebu", [square({ lat: 10.32, lon: 123.9 }, 0.1)])], { headline: null })), [CEBU_CITY_LINE], NOW);
    expect(only.headline).toBe("General Flood Advisory (Moderate)");
  });

  it("the PAR-wide tropical cyclone polygon goes in without rings, so it never paints the whole map", () => {
    const par = area("Philippine Area of Responsibility", [square({ lat: 13, lon: 125 }, 20)]);
    const areas = advisoryAreasFor(
      reading(product("tc", [par], { kind: "cyclone", event: "Tropical Cyclone Alert", headline: "Tropical Cyclone Alert" })),
      [CEBU_CITY_LINE],
      NOW,
    );
    expect(areas).toEqual([expect.objectContaining({ kind: "Tropical Cyclone Alert", rings: [] })]);
  });

  it("an area bounded only by its geocode covers the route and goes in without rings", () => {
    const areas = advisoryAreasFor(reading(product("g", [area("Cebu", [], ["072200000"])])), [CEBU_CITY_LINE], NOW);
    expect(areas).toEqual([expect.objectContaining({ rings: [] })]);
  });

  it("an expired info's areas are left out", () => {
    const expired = product("x", [area("Cebu", [square({ lat: 10.32, lon: 123.9 }, 0.1)])], {
      infos: [{ expires: "2026-10-25T19:00:00+08:00", rainForecast: null, rivers: [], areas: [area("Cebu", [square({ lat: 10.32, lon: 123.9 }, 0.1)])] }],
    });
    expect(advisoryAreasFor(reading(expired), [CEBU_CITY_LINE], NOW)).toEqual([]);
  });

  it(`keeps at most ${MAX_MAP_AREAS} areas, counting products first and newest first`, () => {
    const products = Array.from({ length: 10 }, (_, i) =>
      product(`p${i}`, [area(`Cebu ${i}`, [square({ lat: 10.32, lon: 123.9 }, 0.1 + i * 0.01)])], { sent: `2026-10-25T1${i}:00:00+08:00` }),
    );
    const other = product("other", [area("Cebu", [square({ lat: 10.32, lon: 123.9 }, 0.5)])], { kind: "other", event: "Thunderstorm Advisory", sent: "2026-10-25T19:59:00+08:00" });
    const areas = advisoryAreasFor(reading(other, ...products), [CEBU_CITY_LINE], NOW);
    expect(areas).toHaveLength(MAX_MAP_AREAS);
    expect(areas.map((a) => a.sent)).toEqual(Array.from({ length: 8 }, (_, i) => `2026-10-25T1${9 - i}:00:00+08:00`));
  });

  it(`thins rings past ${MAX_MAP_POINTS} points in all, each ring still closed and drawable`, () => {
    const big = (i: number) => area(`Cebu ${i}`, [square({ lat: 10.32, lon: 123.9 }, 0.1 + i * 0.01, 200)]);
    const areas = advisoryAreasFor(reading(...[0, 1, 2, 3].map((i) => product(`p${i}`, [big(i)]))), [CEBU_CITY_LINE], NOW);
    const points = areas.flatMap((a) => a.rings).reduce((n, r) => n + r.length, 0);

    expect(4 * 801).toBeGreaterThan(MAX_MAP_POINTS);
    expect(points).toBeLessThanOrEqual(MAX_MAP_POINTS);
    expect(areas).toHaveLength(4);
    for (const ring of areas.flatMap((a) => a.rings)) {
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring[ring.length - 1]).toEqual(ring[0]);
    }
  });
});
