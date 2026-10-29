import type { Point } from "../lib/answer";
import { inMetroCebu } from "../lib/metro-cebu";

/** A commuter's saved home and work points. It leaves the phone only inside a check request. */
export interface Trip {
  home: Point;
  work: Point;
}

export type TripDraft = { step: "home" } | { step: "work"; home: Point } | { step: "set"; trip: Trip };

export type TripStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "lusong.trip";

export function startTrip(saved: Trip | null): TripDraft {
  return saved ? { step: "set", trip: saved } : { step: "home" };
}

/** Home first, then work. A tap on a set trip starts a new one; a tap outside Metro Cebu changes nothing. */
export function tapTrip(draft: TripDraft, at: Point): { draft: TripDraft; outside: boolean } {
  if (!inMetroCebu(at)) return { draft, outside: true };
  if (draft.step === "work") return { draft: { step: "set", trip: { home: draft.home, work: at } }, outside: false };
  return { draft: { step: "work", home: at }, outside: false };
}

function pointFrom(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return inMetroCebu({ lat, lon }) ? { lat, lon } : null;
}

/** Storage can be missing or throw (private windows, blocked site data), so every access is guarded. */
export function loadTrip(storage: TripStorage | null): Trip | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const home = pointFrom(value?.home);
    const work = pointFrom(value?.work);
    return home && work ? { home, work } : null;
  } catch {
    return null;
  }
}

export function saveTrip(storage: TripStorage | null, trip: Trip): boolean {
  if (!storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify({ home: trip.home, work: trip.work }));
    return true;
  } catch {
    return false;
  }
}

export function clearTrip(storage: TripStorage | null): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing more can be done; the page carries on without it.
  }
}
