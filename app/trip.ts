import type { Point } from "../lib/answer";
import { inTripBound } from "../lib/trip-bound";

/** A commuter's saved home and work points. It leaves the phone only inside a check request. */
export interface Trip {
  home: Point;
  work: Point;
}

/** "home" may already hold a work point picked in the To box before From was filled. */
export type TripDraft = { step: "home"; work?: Point } | { step: "work"; home: Point } | { step: "set"; trip: Trip };

export type TripStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "lusong.trip";

export function startTrip(saved: Trip | null): TripDraft {
  return saved ? { step: "set", trip: saved } : { step: "home" };
}

/** Home first, then work. A tap on a set trip starts a new one; a tap outside the trip bound changes nothing. */
export function tapTrip(draft: TripDraft, at: Point): { draft: TripDraft; outside: boolean } {
  if (!inTripBound(at)) return { draft, outside: true };
  if (draft.step === "work") return { draft: { step: "set", trip: { home: draft.home, work: at } }, outside: false };
  if (draft.step === "home" && draft.work) return { draft: { step: "set", trip: { home: at, work: draft.work } }, outside: false };
  return { draft: { step: "work", home: at }, outside: false };
}

/** A place picked in the From or To box replaces that end and keeps the other; outside the trip bound it changes nothing. */
export function pickTrip(draft: TripDraft, end: "from" | "to", at: Point): { draft: TripDraft; outside: boolean } {
  if (!inTripBound(at)) return { draft, outside: true };
  const home = draft.step === "set" ? draft.trip.home : draft.step === "work" ? draft.home : undefined;
  const work = draft.step === "set" ? draft.trip.work : draft.step === "home" ? draft.work : undefined;
  if (end === "from") return { draft: work ? { step: "set", trip: { home: at, work } } : { step: "work", home: at }, outside: false };
  return { draft: home ? { step: "set", trip: { home, work: at } } : { step: "home", work: at }, outside: false };
}

/** The only way the trip leaves the phone: as a real check's start and end, which the server uses and doesn't keep. */
export function checkRequest(trip: Trip, rainingHere: boolean) {
  return { mode: "real" as const, from: trip.home, to: trip.work, rainingHere };
}

function pointFrom(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return inTripBound({ lat, lon }) ? { lat, lon } : null;
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
