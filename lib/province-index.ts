import type { Point } from "./answer";
import * as geo from "./advisory-geo";
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

const METRO_MANILA: Province = { code: "1300000000", name: "Metro Manila" };
const ISABELA_CITY_CODE = "0990100000";

/**
 * The polygons split Metro Manila into four districts named "NCR, … District (Not a Province)". A web search and a
 * rider both know it as one place, so the districts are one search area here; Isabela City gets its everyday name.
 */
function searchArea(unit: Province): Province {
  if (unit.code.startsWith("13")) return METRO_MANILA;
  if (unit.code === ISABELA_CITY_CODE) return { code: unit.code, name: "Isabela City" };
  return { code: unit.code, name: unit.name };
}

/** faeldon's province polygons (lib/advisory-geo.ts), with Metro Manila one area. */
export const polygonProvinceIndex: ProvinceIndex = {
  inPhilippines: geo.inPhilippines,
  provinceOf: (p) => {
    const unit = geo.provinceOf(p);
    return unit && searchArea(unit);
  },
  provincesAlong: (line) => provincesInOrder(geo.provincesAlong(line).map(searchArea)),
};

export function provincesInOrder(provinces: readonly Province[]): Province[] {
  const seen = new Set<string>();
  return provinces.filter((p) => !seen.has(p.code) && seen.add(p.code));
}

const DEFAULT_INDEX: ProvinceIndex = polygonProvinceIndex;

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
