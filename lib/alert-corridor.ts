import { judgeArea, provincesAlong, type CapArea } from "./advisory-geo";
import type { Alert } from "./alerts";
import { placeOnRoute, type Point } from "./answer";
import type { WatchTrip } from "./watch-store";

/**
 * Which watchers an alert touches (disposition S4P-6). A watcher's corridor is its last checked route line buffered by
 * ROUTE_BUFFER_M. Before the tick has stored a line, it is the box around both ends grown by NO_LINE_GROWTH_M, which
 * leans toward telling more riders; the promise says "near your trip" for that reason.
 */

export const ROUTE_BUFFER_M = 1_000;
export const NO_LINE_GROWTH_M = 20_000;
/** A stored route line keeps at most this many points. */
export const MAX_ROUTE_POINTS = 200;

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * RAD;
/** The box fallback is swept by rows this far apart, so any area taller than this inside the box is entered. */
const BOX_ROW_M = 3_000;
/** A line is sampled at least this often when measuring how near it comes to a polygon. */
const SAMPLE_STEP_M = 250;

type Box = { south: number; north: number; west: number; east: number };

export type Corridor =
  | { kind: "line"; line: Point[]; bufferM: number; provinces: () => Set<string> }
  | { kind: "box"; box: Box; sweep: Point[]; provinces: () => Set<string> };

/** Placing every point of a line is the costly part, so it is done once, and only for an alert scoped by province. */
function provincesOnce(line: readonly Point[]): () => Set<string> {
  let codes: Set<string> | null = null;
  return () => (codes ??= new Set(provincesAlong(line).map((p) => p.code)));
}

function grow(box: Box, m: number): Box {
  const dLat = m / M_PER_DEG_LAT;
  const dLon = m / (M_PER_DEG_LAT * Math.cos(((box.south + box.north) / 2) * RAD));
  return { south: box.south - dLat, north: box.north + dLat, west: box.west - dLon, east: box.east + dLon };
}

/** Rows across the box, joined end to end: S1's line rules then see every area the box holds. */
function sweepOf(box: Box): Point[] {
  const rows = Math.max(1, Math.ceil(((box.north - box.south) * M_PER_DEG_LAT) / BOX_ROW_M));
  const out: Point[] = [];
  for (let r = 0; r <= rows; r++) {
    const lat = box.south + ((box.north - box.south) * r) / rows;
    const [a, b] = r % 2 === 0 ? [box.west, box.east] : [box.east, box.west];
    out.push({ lat, lon: a }, { lat, lon: b });
  }
  return out;
}

export function corridorFor(trip: WatchTrip, line: readonly Point[] | null): Corridor {
  if (line && line.length >= 2) {
    return { kind: "line", line: [...line], bufferM: ROUTE_BUFFER_M, provinces: provincesOnce(line) };
  }
  const box = grow(
    {
      south: Math.min(trip.from.lat, trip.to.lat),
      north: Math.max(trip.from.lat, trip.to.lat),
      west: Math.min(trip.from.lon, trip.to.lon),
      east: Math.max(trip.from.lon, trip.to.lon),
    },
    NO_LINE_GROWTH_M,
  );
  const sweep = sweepOf(box);
  return { kind: "box", box, sweep, provinces: provincesOnce(sweep) };
}

function local(origin: Point, p: Point) {
  return { x: (p.lon - origin.lon) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD), y: (p.lat - origin.lat) * M_PER_DEG_LAT };
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The line with a point at least every SAMPLE_STEP_M. */
function sampled(line: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < line.length; i++) {
    out.push(line[i]);
    if (i + 1 === line.length) break;
    const a = line[i];
    const b = line[i + 1];
    const q = local(a, b);
    const steps = Math.ceil(Math.hypot(q.x, q.y) / SAMPLE_STEP_M);
    for (let s = 1; s < steps; s++) out.push({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
  }
  return out;
}

/** True when some point of the line lies within `m` of the ring's edge (or inside it, which judgeArea already finds). */
function ringNear(line: readonly Point[], ring: readonly number[], m: number): boolean {
  const box = grow(ringBox(ring), m);
  for (const p of sampled(line)) {
    if (p.lat < box.south || p.lat > box.north || p.lon < box.west || p.lon > box.east) continue;
    const q = { x: 0, y: 0 };
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = local(p, { lon: ring[2 * i], lat: ring[2 * i + 1] });
      const b = local(p, { lon: ring[2 * j], lat: ring[2 * j + 1] });
      if (segmentDistance(q, a, b) <= m) return true;
    }
  }
  return false;
}

function areaTouches(area: CapArea, corridor: Corridor): boolean {
  const line = corridor.kind === "line" ? corridor.line : corridor.sweep;
  const judged = judgeArea(area, line);
  // An area nothing can place is a warning on every check (S1); lean safe, every rider hears of it.
  if (judged === "covers" || judged === "unbounded") return true;
  if (corridor.kind === "line") return area.polygons.some((ring) => ringNear(corridor.line, ring, corridor.bufferM));
  // The box's rows can pass either side of a small polygon, so any polygon whose box overlaps it counts.
  return area.polygons.some((ring) => boxesOverlap(ringBox(ring), corridor.box));
}

function ringBox(ring: readonly number[]): Box {
  const box = { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity };
  for (let i = 0; i < ring.length; i += 2) {
    box.west = Math.min(box.west, ring[i]);
    box.east = Math.max(box.east, ring[i]);
    box.south = Math.min(box.south, ring[i + 1]);
    box.north = Math.max(box.north, ring[i + 1]);
  }
  return box;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.south <= b.north && b.south <= a.north && a.west <= b.east && b.west <= a.east;
}

/** Whether the alert touches the corridor, and for a PAGASA alert the areaDescs that do. */
export function touches(alert: Alert, corridor: Corridor): { touches: boolean; areas: string[] } {
  const scope = alert.scope;
  if ("nationwide" in scope) return { touches: true, areas: [] };
  if ("areas" in scope) {
    const areas = [...new Set(scope.areas.filter((a) => areaTouches(a, corridor)).map((a) => a.desc))];
    return { touches: areas.length > 0, areas };
  }
  if ("codes" in scope) return { touches: scope.codes.some((c) => corridor.provinces().has(c)), areas: [] };
  if (corridor.kind === "line") return { touches: placeOnRoute(scope.point, corridor.line).offM <= scope.radiusM + corridor.bufferM, areas: [] };
  const box = grow(corridor.box, scope.radiusM);
  const p = scope.point;
  return { touches: p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east, areas: [] };
}

/** Ramer–Douglas–Peucker at a growing tolerance until the line fits MAX_ROUTE_POINTS; ends are always kept. */
export function simplifyLine(line: readonly Point[], max = MAX_ROUTE_POINTS): Point[] {
  if (line.length <= max) return [...line];
  for (let tolerance = 10; ; tolerance *= 2) {
    const keep = new Array<boolean>(line.length).fill(false);
    keep[0] = keep[line.length - 1] = true;
    const stack: [number, number][] = [[0, line.length - 1]];
    while (stack.length > 0) {
      const [a, b] = stack.pop()!;
      let worst = -1;
      let at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = placeOnRoute(line[i], [line[a], line[b]]).offM;
        if (d > worst) {
          worst = d;
          at = i;
        }
      }
      if (at !== -1 && worst > tolerance) {
        keep[at] = true;
        stack.push([a, at], [at, b]);
      }
    }
    const out = line.filter((_, i) => keep[i]);
    if (out.length <= max) return out;
  }
}
