import { distanceM, placeOnRoute, ROUTE_CORRIDOR_M, type Point } from "./answer";

/** Side of the square excluded around each blocked spot; the 2026-10-30 probe found a way around with 330 m. */
export const EXCLUDE_BOX_M = 330;

/** The 2026-10-30 probe built its box at 111,320 m a degree, so the box matches the saved request. */
const METRES_PER_DEGREE = 111_320;

/** A closed ring, south-west corner first and last, going east then north. */
export function boxAround(spot: Point, sideM: number = EXCLUDE_BOX_M): Point[] {
  const half = sideM / 2;
  const dLat = half / METRES_PER_DEGREE;
  const dLon = half / (METRES_PER_DEGREE * Math.cos((spot.lat * Math.PI) / 180));
  const south = spot.lat - dLat;
  const north = spot.lat + dLat;
  const west = spot.lon - dLon;
  const east = spot.lon + dLon;
  return [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
    { lat: south, lon: west },
  ];
}

type XY = { x: number; y: number };
const xy = (p: Point): XY => ({ x: p.lon, y: p.lat });

function cross(o: XY, a: XY, b: XY): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

/** Touching counts as meeting: a route that grazes an excluded edge is not trusted to avoid it. */
function segmentsMeet(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(c, d, a)) ||
    (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) ||
    (d4 === 0 && onSegment(a, b, d))
  );
}

function inside(ring: readonly XY[], p: XY): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) within = !within;
  }
  return within;
}

/**
 * True when any segment of the line meets the closed ring or lies inside it. Every segment is tested against every
 * edge, so a long segment that crosses the area with both ends outside it is caught (route points alone would miss it).
 * A connected line that starts outside can only get in by crossing an edge, so only its first point needs the inside test.
 */
export function lineEntersArea(line: readonly Point[], ring: readonly Point[]): boolean {
  const r = ring.map(xy);
  const l = line.map(xy);
  if (l.length > 0 && inside(r, l[0])) return true;
  for (let i = 0; i + 1 < l.length; i++) {
    for (let k = 0; k + 1 < r.length; k++) if (segmentsMeet(l[i], l[i + 1], r[k], r[k + 1])) return true;
  }
  return false;
}

/** A detour counts only if it enters no excluded box and passes no blocked spot within the route corridor. */
export function detourAvoids(line: readonly Point[], blockedSpots: readonly Point[], sideM: number = EXCLUDE_BOX_M): boolean {
  return blockedSpots.every(
    (spot) => !lineEntersArea(line, boxAround(spot, sideM)) && placeOnRoute(spot, line).offM > ROUTE_CORRIDOR_M,
  );
}

/**
 * How far a route's first and last points may lie from the trip's start and end. Valhalla snaps each end to the
 * nearest road: 26.7 m at Banilad was the largest gap in the saved routes.
 */
export const ROUTE_END_TOLERANCE_M = 50;

/**
 * The line a route is judged on: the trip's start, the route, the trip's end, so a gap at either end is checked like
 * the rest of the route. Null when either end of the route is too far from the trip's to stand for the whole trip.
 */
export function lineForTrip(line: readonly Point[], trip: { from: Point; to: Point }): Point[] | null {
  if (line.length === 0) return null;
  if (distanceM(line[0], trip.from) > ROUTE_END_TOLERANCE_M) return null;
  if (distanceM(line[line.length - 1], trip.to) > ROUTE_END_TOLERANCE_M) return null;
  return [trip.from, ...line, trip.to];
}
