"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Point } from "../lib/answer";
import { createTripStore, startTrip, tapTrip, type TripDraft } from "./trip";
import { WatcherPanel } from "./watcher-panel";

function phone(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let store: ReturnType<typeof createTripStore> | null = null;

function tripStore() {
  store ??= createTripStore(phone(), window);
  return store;
}

const subscribe = (listener: () => void) => tripStore().subscribe(listener);
const savedTrip = () => tripStore().get();

export interface OwnTrip {
  draft: TripDraft;
  /** The last tap was outside Metro Cebu. */
  outside: boolean;
  /** False when the phone wouldn't store the trip, so it lasts only while the page is open. */
  kept: boolean;
  /** The last clear failed: the phone wouldn't remove the trip, so it is still saved. */
  clearFailed: boolean;
  tap: (at: Point) => void;
  clear: () => void;
}

/** `changed` runs whenever a tap, a clear or another tab changes the trip, so an answer for the old one isn't left showing. */
export function useOwnTrip(changed: () => void): OwnTrip {
  // The server has no phone storage, so it renders no trip and the saved one appears once the page is running.
  const saved = useSyncExternalStore(subscribe, savedTrip, () => null);
  const [home, setHome] = useState<Point | null>(null);
  const [outside, setOutside] = useState(false);
  const [kept, setKept] = useState(true);
  const [clearFailed, setClearFailed] = useState(false);
  const latestChanged = useRef(changed);
  useEffect(() => {
    latestChanged.current = changed;
  });
  useEffect(() => tripStore().subscribe(() => latestChanged.current()), []);
  const draft: TripDraft = home ? { step: "work", home } : startTrip(saved);

  function tap(at: Point) {
    const next = tapTrip(draft, at);
    setOutside(next.outside);
    setClearFailed(false);
    if (next.outside) return;
    if (next.draft.step === "work") setHome(next.draft.home);
    if (next.draft.step === "set") {
      setHome(null);
      setKept(tripStore().save(next.draft.trip));
    }
    changed();
  }

  function clear() {
    if (!tripStore().clear()) {
      setClearFailed(true);
      return;
    }
    setClearFailed(false);
    setHome(null);
    setOutside(false);
    setKept(true);
    changed();
  }

  return { draft, outside, kept, clearFailed, tap, clear };
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
            It leaves the phone only inside a check, and Lusong&apos;s server doesn&apos;t keep it unless you switch on the
            watcher below. To change it, tap a new home on the map.
          </p>
          {!own.kept && (
            <p className="text-amber-800 dark:text-amber-300">This phone wouldn&apos;t store it, so it lasts until you close the page.</p>
          )}
        </>
      )}
      {own.clearFailed && (
        <p role="status" className="font-medium text-amber-800 dark:text-amber-300">
          This phone wouldn&apos;t remove your trip, so it is still saved here. Try again, or clear this site&apos;s data in
          your browser.
        </p>
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
      <WatcherPanel trip={draft.step === "set" ? draft.trip : null} />
    </div>
  );
}
