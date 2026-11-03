import type { Point } from "./answer";
import { METRO_CEBU } from "./metro-cebu";

/** The box a trip's start and end must both lie in. Place search, the trip on the phone and the check share it. */
export interface Bound {
  id: string;
  south: number;
  north: number;
  west: number;
  east: number;
}

export const TRIP_BOUND: Bound = { id: "metro-cebu", ...METRO_CEBU };

export function inBound(bound: Bound, p: Point): boolean {
  return p.lat >= bound.south && p.lat <= bound.north && p.lon >= bound.west && p.lon <= bound.east;
}

export function inTripBound(p: Point): boolean {
  return inBound(TRIP_BOUND, p);
}

/** How the page names the bound to a rider. */
export const TRIP_AREA_NAME = "Metro Cebu";
