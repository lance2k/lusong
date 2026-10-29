"use client";

import { useState, useSyncExternalStore } from "react";
import type { Point } from "../lib/answer";
import { clearTrip, loadTrip, saveTrip, startTrip, tapTrip, type Trip, type TripDraft } from "./trip";

function phone(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The trip this page holds, read from the phone once; it also carries a trip the phone refused to keep. */
let current: Trip | null | undefined;
const listeners = new Set<() => void>();

function savedTrip(): Trip | null {
  if (current === undefined) current = loadTrip(phone());
  return current;
}

function setSavedTrip(trip: Trip | null) {
  current = trip;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface OwnTrip {
  draft: TripDraft;
  /** The last tap was outside Metro Cebu. */
  outside: boolean;
  /** False when the phone wouldn't store the trip, so it lasts only while the page is open. */
  kept: boolean;
  tap: (at: Point) => void;
  clear: () => void;
}

/** `changed` runs whenever a tap or a clear changes the trip, so an answer for the old one isn't left showing. */
export function useOwnTrip(changed: () => void): OwnTrip {
  // The server has no phone storage, so it renders no trip and the saved one appears once the page is running.
  const saved = useSyncExternalStore(subscribe, savedTrip, () => null);
  const [home, setHome] = useState<Point | null>(null);
  const [outside, setOutside] = useState(false);
  const [kept, setKept] = useState(true);
  const draft: TripDraft = home ? { step: "work", home } : startTrip(saved);

  function tap(at: Point) {
    const next = tapTrip(draft, at);
    setOutside(next.outside);
    if (next.outside) return;
    if (next.draft.step === "work") setHome(next.draft.home);
    if (next.draft.step === "set") {
      setHome(null);
      setKept(saveTrip(phone(), next.draft.trip));
      setSavedTrip(next.draft.trip);
    }
    changed();
  }

  function clear() {
    clearTrip(phone());
    setHome(null);
    setOutside(false);
    setKept(true);
    setSavedTrip(null);
    changed();
  }

  return { draft, outside, kept, tap, clear };
}

export function OwnTripPanel({ own }: { own: OwnTrip }) {
  const { draft } = own;
  return (
    <div className="space-y-2 text-[15px]" aria-live="polite">
      {draft.step === "home" && <p className="font-medium">Tap your home on the map.</p>}
      {draft.step === "work" && <p className="font-medium">Home set. Now tap work.</p>}
      {draft.step === "set" && (
        <>
          <p className="font-medium">Your trip is saved on this phone.</p>
          <p className="text-zinc-600 dark:text-zinc-400">
            It leaves the phone only inside a check, and Lusong&apos;s server doesn&apos;t keep it. To change it, tap a new
            home on the map.
          </p>
          {!own.kept && (
            <p className="text-amber-800 dark:text-amber-300">This phone wouldn&apos;t store it, so it lasts until you close the page.</p>
          )}
        </>
      )}
      {own.outside && (
        <p role="status" className="font-medium text-amber-800 dark:text-amber-300">
          That spot is outside Metro Cebu. Lusong checks trips in Metro Cebu only, because the flood advisory it reads is Cebu&apos;s.
        </p>
      )}
      {(draft.step !== "home" || own.outside) && (
        <button
          type="button"
          onClick={own.clear}
          className="min-h-11 rounded-full border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700"
        >
          Clear my trip
        </button>
      )}
    </div>
  );
}
