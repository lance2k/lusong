import type { Point } from "./answer";
import data from "./data/ph-provinces.json";

/**
 * Philippine province polygons and how PAGASA's CAP areas map onto them. Server only: the polygons are about 260 KB.
 *
 * Source: github.com/faeldon/philippines-json-maps at commit bf7060598ff5a5d160917f1dcb9622dbaef85ff7 (2026-10-28),
 * `latest/geojson/regions/lowres/provdists-region-<code>.0.001.json`, all 18 regions, MIT License. Built by keeping
 * each feature's adm2_psgc, adm2_en and adm1_psgc and its rings, coordinates rounded to 4 decimals (about 11 m).
 */

export interface PlaceName {
  /** The 10-digit PSGC of the province (or NCR district), as faeldon codes it, zero-padded: Cebu is "0702200000". */
  code: string;
  name: string;
}

interface Province extends PlaceName {
  region: string;
  /** Flat [lon, lat, lon, lat, ...] rings: outer rings and holes alike, read by the even-odd rule. */
  rings: number[][];
  bbox: Box;
}

type Box = { west: number; south: number; east: number; north: number };

/** A point this close to a province's edge counts as in it: the low-resolution coastline cuts corners by up to ~1 km. */
export const NEAR_PROVINCE_M = 2_000;

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

function boxOf(rings: readonly number[][]): Box {
  const box = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      box.west = Math.min(box.west, ring[i]);
      box.east = Math.max(box.east, ring[i]);
      box.south = Math.min(box.south, ring[i + 1]);
      box.north = Math.max(box.north, ring[i + 1]);
    }
  }
  return box;
}

const PROVINCES: Province[] = (data as { provinces: { code: string; name: string; region: string; rings: number[][] }[] }).provinces.map((p) => ({
  ...p,
  bbox: boxOf(p.rings),
}));
const BY_CODE = new Map(PROVINCES.map((p) => [p.code, p]));

function inBox(box: Box, p: Point, marginDeg = 0): boolean {
  return p.lat >= box.south - marginDeg && p.lat <= box.north + marginDeg && p.lon >= box.west - marginDeg && p.lon <= box.east + marginDeg;
}

function ringsContain(rings: readonly number[][], p: Point): boolean {
  let within = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, ay, bx, by] = [ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]];
      if (ay > p.lat !== by > p.lat && p.lon < ((bx - ax) * (p.lat - ay)) / (by - ay) + ax) within = !within;
    }
  }
  return within;
}

/** Metres from p to the nearest edge of the rings, on a flat projection centred on p (good to well under 1% at 2 km). */
function distanceToRingsM(rings: readonly number[][], p: Point): number {
  const kx = Math.cos(p.lat * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = (ring[2 * i] - p.lon) * kx;
      const ay = (ring[2 * i + 1] - p.lat) * ky;
      const bx = (ring[2 * j] - p.lon) * kx;
      const by = (ring[2 * j + 1] - p.lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

const NEAR_MARGIN_DEG = (NEAR_PROVINCE_M / (EARTH_RADIUS_M * RAD)) * 1.5;

/** The province containing p, else the nearest one within NEAR_PROVINCE_M of it, else null. */
export function provinceOf(p: Point): PlaceName | null {
  const found = provinceAt(p);
  return found ? { code: found.code, name: found.name } : null;
}

function provinceAt(p: Point): Province | null {
  let nearest: { province: Province; m: number } | null = null;
  for (const province of PROVINCES) {
    // The margin is in degrees of latitude; a degree of longitude is shorter, so it over-covers, never under.
    if (!inBox(province.bbox, p, NEAR_MARGIN_DEG)) continue;
    if (inBox(province.bbox, p) && ringsContain(province.rings, p)) return province;
    const m = distanceToRingsM(province.rings, p);
    if (m <= NEAR_PROVINCE_M && (!nearest || m < nearest.m)) nearest = { province, m };
  }
  return nearest?.province ?? null;
}

/** Inside a Philippine province or NCR district, or within NEAR_PROVINCE_M of one: the trip bound's box also holds Sabah. */
export function inPhilippines(p: Point): boolean {
  return provinceAt(p) !== null;
}

/** Points along a line at most this far apart are each placed, so a province the line only clips is still found. */
const ALONG_STEP_M = 500;

function flatDistanceM(a: Point, b: Point): number {
  const kx = Math.cos(((a.lat + b.lat) / 2) * RAD);
  return Math.hypot((b.lon - a.lon) * kx, b.lat - a.lat) * RAD * EARTH_RADIUS_M;
}

/** The provinces the line passes through, each once, in the order it first reaches them. */
export function provincesAlong(line: readonly Point[]): PlaceName[] {
  const seen = new Map<string, PlaceName>();
  const visit = (p: Point) => {
    const province = provinceAt(p);
    if (province && !seen.has(province.code)) seen.set(province.code, { code: province.code, name: province.name });
  };
  line.forEach((a, i) => {
    visit(a);
    const b = line[i + 1];
    if (!b) return;
    const steps = Math.ceil(flatDistanceM(a, b) / ALONG_STEP_M);
    for (let s = 1; s < steps; s++) visit({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
  });
  return [...seen.values()];
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when the line enters the rings: one of its points lies inside, or one of its segments crosses an edge. */
export function lineEnters(line: readonly Point[], rings: readonly number[][], box: Box = boxOf(rings)): boolean {
  if (line.length === 0) return false;
  const lineBox = boxOf([line.flatMap((p) => [p.lon, p.lat])]);
  if (lineBox.east < box.west || lineBox.west > box.east || lineBox.north < box.south || lineBox.south > box.north) return false;
  if (line.some((p) => inBox(box, p) && ringsContain(rings, p))) return true;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k];
    const b = line[k + 1];
    if (Math.max(a.lon, b.lon) < box.west || Math.min(a.lon, b.lon) > box.east) continue;
    if (Math.max(a.lat, b.lat) < box.south || Math.min(a.lat, b.lat) > box.north) continue;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if (segmentsCross(a.lon, a.lat, b.lon, b.lat, ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1])) return true;
      }
    }
  }
  return false;
}

/** Faeldon's region codes (the first two digits), keyed by the legacy two digits PAGASA's 9-digit SAME codes use. */
const LEGACY_REGION: Record<string, string> = { "15": "19" };

/**
 * Legacy provinces that moved region or split since the 9-digit codes were set, keyed by their 4 legacy digits: Negros
 * Occidental (06), Negros Oriental and Siquijor (07) are in region 18 (NIR) in faeldon's vintage; ARMM (15) is BARMM
 * (19), except Sulu, now in region 9; Maguindanao split in two; Isabela City has a pseudo-province of its own.
 */
const LEGACY_PROVINCE: Record<string, string[]> = {
  "0645": ["1804500000"],
  "0746": ["1804600000"],
  "0761": ["1806100000"],
  "1507": ["1900700000"],
  "1536": ["1903600000"],
  "1538": ["1908700000", "1908800000"],
  "1566": ["0906600000"],
  "1570": ["1907000000"],
  "0997": ["0990100000"],
};

/** A legacy region's 9-digit code bounds what it held then, so region 06 and 07 still cover the Negros provinces. */
const LEGACY_REGION_EXTRA: Record<string, string[]> = {
  "06": ["1804500000"],
  "07": ["1804600000", "1806100000"],
  "15": ["0906600000"],
};

function regionProvinces(region2: string): string[] {
  const faeldon = `${LEGACY_REGION[region2] ?? region2}00000000`;
  return [...PROVINCES.filter((p) => p.region === faeldon).map((p) => p.code), ...(LEGACY_REGION_EXTRA[region2] ?? [])];
}

/** PSGC has no code for the whole country; nine zeros is read as it, the only reading that can't place it wrongly. */
const COUNTRY_SAME = "000000000";

export type AreaBound = { kind: "nationwide" } | { kind: "provinces"; codes: string[] };

/**
 * A 9-digit SAME geocode (legacy PSGC) as the provinces that bound it: a province by its code (a 0 inserted after the
 * two region digits: 072200000 → 0702200000), a city or municipality by its province, a region by all its provinces.
 * A province code faeldon doesn't hold is bounded by its region. Null when neither is known.
 */
export function boundOfGeocode(same: string): AreaBound | null {
  if (!/^\d{9}$/.test(same)) return null;
  if (same === COUNTRY_SAME) return { kind: "nationwide" };
  const region = same.slice(0, 2);
  const province = same.slice(2, 4);
  if (province === "00") {
    const codes = regionProvinces(region);
    return codes.length > 0 ? { kind: "provinces", codes } : null;
  }
  const legacy = LEGACY_PROVINCE[region + province];
  if (legacy) return { kind: "provinces", codes: legacy };
  const direct = `${LEGACY_REGION[region] ?? region}0${province}00000`;
  if (BY_CODE.has(direct)) return { kind: "provinces", codes: [direct] };
  const codes = regionProvinces(region);
  return codes.length > 0 ? { kind: "provinces", codes } : null;
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(province of|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NATIONWIDE_NAMES = new Set(["philippines", "whole country", "nationwide", "entire country", "philippine area of responsibility"]);

const REGION_NAMES: Record<string, string> = {
  "ilocos region": "01",
  "cagayan valley": "02",
  "central luzon": "03",
  calabarzon: "04",
  "bicol region": "05",
  "western visayas": "06",
  "central visayas": "07",
  "eastern visayas": "08",
  "zamboanga peninsula": "09",
  "northern mindanao": "10",
  "davao region": "11",
  soccsksargen: "12",
  "national capital region": "13",
  "metro manila": "13",
  ncr: "13",
  "cordillera administrative region": "14",
  car: "14",
  caraga: "16",
  mimaropa: "17",
  "negros island region": "18",
  barmm: "19",
  "bangsamoro autonomous region in muslim mindanao": "19",
  "bangsamoro autonomous region of muslim mindanao": "19",
};

const PROVINCE_ALIASES: Record<string, string[]> = {
  maguindanao: ["1908700000", "1908800000"],
  "compostela valley": ["1108200000"],
  "western samar": ["0806000000"],
  "north cotabato": ["1204700000"],
  manila: ["1303900000"],
  "city of manila": ["1303900000"],
};

const BY_NAME = new Map<string, string[]>([
  ...PROVINCES.filter((p) => !p.name.includes("Not a Province")).map((p) => [fold(p.name), [p.code]] as [string, string[]]),
  ...Object.entries(PROVINCE_ALIASES),
]);

/** An areaDesc as the provinces it names: a province, a region by name or number, or the whole country. */
export function boundOfName(desc: string): AreaBound | null {
  const raw = desc.trim();
  const name = fold(raw);
  if (NATIONWIDE_NAMES.has(name)) return { kind: "nationwide" };
  const province = BY_NAME.get(name);
  if (province) return { kind: "provinces", codes: province };
  // "Region 7 (Central Visayas)": the bracket is folded away, so the number is read from the raw text.
  const numbered = /^region\s+(\d{1,2})\b/i.exec(raw);
  const region = numbered ? numbered[1].padStart(2, "0") : REGION_NAMES[name];
  if (region) {
    const codes = regionProvinces(region);
    if (codes.length > 0) return { kind: "provinces", codes };
  }
  return null;
}

export interface CapArea {
  desc: string;
  /** Readable CAP polygons as flat [lon, lat, ...] rings. */
  polygons: number[][];
  /** SAME geocodes. */
  geocodes: string[];
}

export type AreaJudgement = "covers" | "outside" | "unbounded";

function boundOf(area: CapArea): AreaBound | null {
  const bounds = [...area.geocodes.map(boundOfGeocode), boundOfName(area.desc)].filter((b): b is AreaBound => b !== null);
  if (bounds.length === 0) return null;
  if (bounds.some((b) => b.kind === "nationwide")) return { kind: "nationwide" };
  return { kind: "provinces", codes: [...new Set(bounds.flatMap((b) => (b.kind === "provinces" ? b.codes : [])))] };
}

/** True when the area names the whole country, by its geocode or its areaDesc. */
export function isNationwide(area: CapArea): boolean {
  return boundOf(area)?.kind === "nationwide";
}

/**
 * Lean safe, as lib/advisory.ts was for Cebu: an area covers a route when any indicator it carries says so, its polygon
 * or the province or region its geocode or name bounds it by. PAGASA's own polygons are coarse: the 2026-10-30 Davao
 * Region record's Davao del Sur polygon leaves out downtown Davao City, which its SAME code 112400000 includes. A
 * nationwide area covers every route. Unbounded: no polygon and nothing names a place, so it never covers a route; the
 * caller shows it as a warning instead.
 */
export function judgeArea(area: CapArea, line: readonly Point[]): AreaJudgement {
  const bound = boundOf(area);
  if (bound?.kind === "nationwide") return "covers";
  if (area.polygons.some((ring) => lineEnters(line, [ring]))) return "covers";
  if (!bound) return area.polygons.length > 0 ? "outside" : "unbounded";
  // A route on a coast the low-resolution polygon cuts off is in the province, as provinceOf already says.
  const inBound = bound.codes.some((code) => {
    const province = BY_CODE.get(code);
    if (!province) return false;
    if (lineEnters(line, province.rings, province.bbox)) return true;
    return line.some((p) => inBox(province.bbox, p, NEAR_MARGIN_DEG) && distanceToRingsM(province.rings, p) <= NEAR_PROVINCE_M);
  });
  return inBound ? "covers" : "outside";
}

/** Every province faeldon holds, for tests and inventories. */
export function allProvinces(): (PlaceName & { region: string })[] {
  return PROVINCES.map(({ code, name, region }) => ({ code, name, region }));
}
