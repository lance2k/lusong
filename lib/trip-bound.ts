import type { Point } from "./answer";

/**
 * The box a trip's start and end must both lie in. Place search, the trip on the phone and the check share it. The box
 * also takes in part of Sabah, so the server checks each end against the Philippine provinces as well
 * (`inServerTripBound`, lib/province-index.ts).
 */
export interface Bound {
  id: string;
  south: number;
  north: number;
  west: number;
  east: number;
}

export const TRIP_BOUND: Bound = { id: "philippines", south: 4.5, north: 21.2, west: 116.9, east: 126.7 };

export function inBound(bound: Bound, p: Point): boolean {
  return p.lat >= bound.south && p.lat <= bound.north && p.lon >= bound.west && p.lon <= bound.east;
}

export function inTripBound(p: Point): boolean {
  return inBound(TRIP_BOUND, p);
}

/** How the page names the bound to a rider. */
export const TRIP_AREA_NAME = "the Philippines";
