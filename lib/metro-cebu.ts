import type { Point } from "./answer";

/**
 * Metro Cebu, the commute check's scope: Cebu City, Mandaue, Lapu-Lapu, Talisay, Consolacion, Liloan, Minglanilla and
 * Cordova, with a margin. PAGASA's advisory is read for Cebu only, so a trip elsewhere has no advisory to judge it by.
 * UNVERIFIED: the edges are from memory of the cities' extents, not checked against OSM boundaries.
 */
export const METRO_CEBU = { south: 10.2, north: 10.47, west: 123.74, east: 124.07 } as const;

export function inMetroCebu(p: Point): boolean {
  return p.lat >= METRO_CEBU.south && p.lat <= METRO_CEBU.north && p.lon >= METRO_CEBU.west && p.lon <= METRO_CEBU.east;
}
