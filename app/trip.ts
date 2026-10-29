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

/** The only way the trip leaves the phone: as a real check's start and end, which the server uses and doesn't keep. */
export function checkRequest(trip: Trip, rainingHere: boolean) {
  return { mode: "real" as const, from: trip.home, to: trip.work, rainingHere };
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

/** True when no trip is left on the phone. */
export function clearTrip(storage: TripStorage | null): boolean {
  try {
    storage?.removeItem(KEY);
    return true;
  } catch {
    // Storage that can't be read back holds nothing this page can show or send, so only a readable trip is a failure.
    return loadTrip(storage) === null;
  }
}

type StorageEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * The page's trip: read from the phone once, then kept in step with this tab's taps and with other tabs, whose
 * changes arrive only as storage events. It also holds a trip the phone refused to store, for as long as the page is open.
 */
export function createTripStore(storage: TripStorage | null, events: StorageEvents | null) {
  let current: Trip | null | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const fromOtherTab = (event: Event) => {
    const key = (event as StorageEvent).key;
    // A null key is the other tab clearing all of storage.
    if (key !== null && key !== KEY) return;
    current = loadTrip(storage);
    notify();
  };
  return {
    get(): Trip | null {
      if (current === undefined) current = loadTrip(storage);
      return current;
    },
    /** False when the phone wouldn't store it, so it lasts only while the page is open. */
    save(trip: Trip): boolean {
      const kept = saveTrip(storage, trip);
      current = trip;
      notify();
      return kept;
    },
    /** False when the phone wouldn't remove it: the trip is still saved and still shown. */
    clear(): boolean {
      if (!clearTrip(storage)) return false;
      current = null;
      notify();
      return true;
    },
    subscribe(listener: () => void): () => void {
      if (listeners.size === 0) events?.addEventListener("storage", fromOtherTab);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) events?.removeEventListener("storage", fromOtherTab);
      };
    },
  };
}
