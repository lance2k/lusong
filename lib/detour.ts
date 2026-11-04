import { distanceM, placeOnRoute, ROUTE_CORRIDOR_M, type Point } from "./answer";

const EARTH_RADIUS_M = 6_371_008.8;

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
 * nearest road: 26.7 m at Banilad was the largest gap in the saved routes, but a pick inside a big lot snaps further.
 * Measured on /locate (motorcycle, 1 draw each, 2026-11-03/04): Jaro plaza 51 m, Burnham Park 56.5 m, SM City Baguio
 * 67.7 m, SM Mall of Asia 68.7 m, SM City Iloilo 79.1 m, Ayala Center Cebu 114.8 m (#41). 150 m takes those and still
 * refuses an end that is somewhere else.
 */
export const ROUTE_END_TOLERANCE_M = 150;

/**
 * Up to this gap a route is taken to start and end where the rider picked, and the straight gap is judged with it, as
 * every route was before #41. Past it the way from the pick to the road is not known (a wall, a gate elsewhere), so
 * the whole disc around the pick that reaches the road, plus the corridor, is judged as part of the route
 * (coverDisc), and the page says so.
 */
export const ROUTE_END_UNSAID_M = 50;

/** Rows of the sweep across a disc: under twice the corridor, so every point of the disc is within the corridor. */
const COVER_ROW_M = 2 * ROUTE_CORRIDOR_M - 5;

/** The disc judged around a pick whose route meets the road `gapM` away: the gap plus the corridor. */
export function coverRadiusM(gapM: number): number {
  return Math.round(gapM) + ROUTE_CORRIDOR_M;
}

/**
 * A back-and-forth line across the disc of `radiusM` around `centre`, so that every point of the disc lies within
 * ROUTE_CORRIDOR_M of it: whatever is matched by distance to a route (reports, web closures, advisories, the sweep's
 * posts) is matched anywhere in the disc. Each row spans the disc's width at the row's edge nearer the centre.
 */
export function coverDisc(centre: Point, radiusM: number): Point[] {
  const rows = Math.max(1, Math.ceil((2 * radiusM) / COVER_ROW_M));
  const spacing = (2 * radiusM) / rows;
  const mPerDegLat = (EARTH_RADIUS_M * Math.PI) / 180;
  const mPerDegLon = mPerDegLat * Math.cos((centre.lat * Math.PI) / 180);
  const at = (x: number, y: number): Point => ({ lat: centre.lat + y / mPerDegLat, lon: centre.lon + x / mPerDegLon });
  const out: Point[] = [];
  for (let k = 0; k < rows; k++) {
    const y = -radiusM + (k + 0.5) * spacing;
    const inner = Math.max(0, Math.abs(y) - spacing / 2);
    const half = Math.sqrt(Math.max(0, radiusM * radiusM - inner * inner));
    const [a, b] = k % 2 === 0 ? [-half, half] : [half, -half];
    out.push(at(a, y), at(b, y));
  }
  return out;
}

/** How far, in whole metres, the route starts and ends from the trip's two points; null for a gap not past ROUTE_END_UNSAID_M. */
export interface RoadGap {
  fromM: number | null;
  toM: number | null;
}

export function roadGap(line: readonly Point[], trip: { from: Point; to: Point }): RoadGap | null {
  if (line.length === 0) return null;
  const said = (m: number) => (m > ROUTE_END_UNSAID_M ? Math.round(m) : null);
  const gap = { fromM: said(distanceM(line[0], trip.from)), toM: said(distanceM(line[line.length - 1], trip.to)) };
  return gap.fromM === null && gap.toM === null ? null : gap;
}

/** The page's sentence for a route that starts or ends on a road away from the rider's points, from the numbers only. */
export function roadGapWords(gap: RoadGap | null | undefined): string | null {
  if (!gap || (gap.fromM === null && gap.toM === null)) return null;
  const unknown = "Lusong doesn't know your way between the road and your point, so every report";
  if (gap.fromM !== null && gap.toM !== null) {
    return (
      `This route starts on the road ${gap.fromM} m from your start and ends on the road ${gap.toM} m from your end. ` +
      `${unknown} within ${coverRadiusM(gap.fromM)} m of your start or ${coverRadiusM(gap.toM)} m of your end counts as on this route.`
    );
  }
  if (gap.fromM !== null) {
    return `This route starts on the road ${gap.fromM} m from your start. ${unknown} within ${coverRadiusM(gap.fromM)} m of your start counts as on this route.`;
  }
  return `This route ends on the road ${gap.toM} m from your end. ${unknown} within ${coverRadiusM(gap.toM!)} m of your end counts as on this route.`;
}

/**
 * The line a route is judged on: the trip's start, the route, the trip's end, so a gap at either end is checked like
 * the rest of the route; a gap past ROUTE_END_UNSAID_M brings in its whole disc (coverDisc). Null when either end of
 * the route is too far from the trip's to stand for the whole trip.
 */
export function lineForTrip(line: readonly Point[], trip: { from: Point; to: Point }): Point[] | null {
  if (line.length === 0) return null;
  const fromGap = distanceM(line[0], trip.from);
  const toGap = distanceM(line[line.length - 1], trip.to);
  if (fromGap > ROUTE_END_TOLERANCE_M || toGap > ROUTE_END_TOLERANCE_M) return null;
  const start = fromGap > ROUTE_END_UNSAID_M ? [trip.from, ...coverDisc(trip.from, coverRadiusM(fromGap))] : [trip.from];
  const end = toGap > ROUTE_END_UNSAID_M ? [...coverDisc(trip.to, coverRadiusM(toGap)), trip.to] : [trip.to];
  return [...start, ...line, ...end];
}
