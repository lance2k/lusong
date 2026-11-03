import type { Point } from "./answer";
import { inTripBound } from "./trip-bound";

export interface Province {
  code: string;
  name: string;
}

/** Which Philippine province a point or a line lies in. Server only: the phone keeps the plain trip box. */
export interface ProvinceIndex {
  inPhilippines(p: Point): boolean;
  /** The provinces the line enters, each once, in the order it enters them. */
  provincesAlong(line: readonly Point[]): Province[];
  provinceOf(p: Point): Province | null;
}

interface BoxedProvince extends Province {
  south: number;
  north: number;
  west: number;
  east: number;
}

/**
 * TEMPORARY until the province polygons land (lib/advisory-geo.ts, S1-geo): rough hand-drawn boxes around ten provinces,
 * not boundaries. A point in none of them reads as outside the Philippines. Earlier entries win where boxes overlap,
 * so Bohol is listed before Cebu and Iloilo before Negros Occidental. Codes follow faeldon's adm2_psgc where known.
 */
const PROVINCE_BOXES: readonly BoxedProvince[] = [
  { code: "1300000000", name: "Metro Manila", south: 14.35, north: 14.79, west: 120.9, east: 121.14 },
  { code: "305400000", name: "Pampanga", south: 14.8, north: 15.35, west: 120.35, east: 120.95 },
  { code: "1401100000", name: "Benguet", south: 16.15, north: 16.95, west: 120.45, east: 120.95 },
  { code: "701200000", name: "Bohol", south: 9.5, north: 10.15, west: 123.75, east: 124.65 },
  { code: "702200000", name: "Cebu", south: 9.4, north: 11.35, west: 123.25, east: 124.1 },
  { code: "603000000", name: "Iloilo", south: 10.4, north: 11.6, west: 121.9, east: 122.75 },
  { code: "604500000", name: "Negros Occidental", south: 9.2, north: 11.05, west: 122.75, east: 123.55 },
  { code: "803700000", name: "Leyte", south: 9.9, north: 11.6, west: 124.25, east: 125.1 },
  { code: "1104300000", name: "Misamis Oriental", south: 8.2, north: 9.1, west: 124.2, east: 125.3 },
  { code: "1102400000", name: "Davao del Sur", south: 6.4, north: 7.6, west: 125.0, east: 125.7 },
];

function boxOf(p: Point): BoxedProvince | null {
  return PROVINCE_BOXES.find((b) => p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east) ?? null;
}

const asProvince = (b: BoxedProvince): Province => ({ code: b.code, name: b.name });

export const bboxProvinceIndex: ProvinceIndex = {
  inPhilippines: (p) => boxOf(p) !== null,
  provinceOf: (p) => {
    const box = boxOf(p);
    return box && asProvince(box);
  },
  provincesAlong: (line) => provincesInOrder(line.map(boxOf).filter((b): b is BoxedProvince => b !== null).map(asProvince)),
};

export function provincesInOrder(provinces: readonly Province[]): Province[] {
  const seen = new Set<string>();
  return provinces.filter((p) => !seen.has(p.code) && seen.add(p.code));
}

// At merge: `const DEFAULT_INDEX: ProvinceIndex = advisoryGeo;` with `import * as advisoryGeo from "./advisory-geo"`.
const DEFAULT_INDEX: ProvinceIndex = bboxProvinceIndex;

let current: ProvinceIndex = DEFAULT_INDEX;

/** The one province index every server check uses. */
export function provinceIndex(): ProvinceIndex {
  return current;
}

/** Tests only: swaps the index in, or puts the default back with null. */
export function setProvinceIndexForTests(index: ProvinceIndex | null): void {
  current = index ?? DEFAULT_INDEX;
}

/** A trip end the server takes: inside the phone's box and inside a Philippine province. */
export function inServerTripBound(p: { lat: unknown; lon: unknown }): p is Point {
  if (typeof p.lat !== "number" || typeof p.lon !== "number" || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  const point = { lat: p.lat, lon: p.lon };
  return inTripBound(point) && provinceIndex().inPhilippines(point);
}
