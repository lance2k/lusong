"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Point } from "../lib/answer";
import type { Place } from "../lib/built-in-places";
import { TRIP_AREA_NAME } from "../lib/trip-bound";
import { PlaceSearch } from "./place-search";
import { createTripStore, pickTrip, startTrip, tapTrip, type TripDraft } from "./trip";
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
  /** The last tap or pick was outside the trip bound. */
  outside: boolean;
  /** What the From and To boxes show; names of picked places are kept only while the page is open. */
  labels: { from: string | null; to: string | null };
  bias: { lat: number; lon: number } | null;
  setBias: (at: { lat: number; lon: number }) => void;
  pick: (end: "from" | "to", place: Place) => void;
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
  const [pending, setPending] = useState<TripDraft | null>(null);
  const [labels, setLabels] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [bias, setBias] = useState<{ lat: number; lon: number } | null>(null);
  const [outside, setOutside] = useState(false);
  const [kept, setKept] = useState(true);
  const [clearFailed, setClearFailed] = useState(false);
  const latestChanged = useRef(changed);
  useEffect(() => {
    latestChanged.current = changed;
  });
  useEffect(() => tripStore().subscribe(() => latestChanged.current()), []);
  const draft: TripDraft = pending ?? startTrip(saved);

  function apply(next: { draft: TripDraft; outside: boolean }): boolean {
    setOutside(next.outside);
    setClearFailed(false);
    if (next.outside) return false;
    if (next.draft.step === "set") {
      setPending(null);
      setKept(tripStore().save(next.draft.trip));
    } else {
      setPending(next.draft);
    }
    changed();
    return true;
  }

  function tap(at: Point) {
    const startsNew = draft.step === "set" || (draft.step === "home" && !draft.work);
    const fillsFrom = draft.step === "home" && Boolean(draft.work);
    if (!apply(tapTrip(draft, at))) return;
    const tapped = "Point tapped on the map";
    if (startsNew) setLabels({ from: tapped, to: null });
    else if (fillsFrom) setLabels((l) => ({ ...l, from: tapped }));
    else setLabels((l) => ({ ...l, to: tapped }));
  }

  function pick(end: "from" | "to", place: Place) {
    if (!apply(pickTrip(draft, end, place))) return;
    const name = place.area ? `${place.name}, ${place.area}` : place.name;
    setLabels((l) => ({ ...l, [end]: name }));
  }

  function clear() {
    if (!tripStore().clear()) {
      setClearFailed(true);
      return;
    }
    setClearFailed(false);
    setPending(null);
    setLabels({ from: null, to: null });
    setOutside(false);
    setKept(true);
    changed();
  }

  return { draft, outside, kept, clearFailed, labels, bias, setBias, pick, tap, clear };
}

export function OwnTripPanel({ own }: { own: OwnTrip }) {
  const { draft, labels } = own;
  const hasFrom = draft.step === "set" || draft.step === "work";
  const hasTo = draft.step === "set" || (draft.step === "home" && Boolean(draft.work));
  const savedLabel = "Saved on this phone";
  return (
    <div className="space-y-3 text-[15px]">
      <div className="space-y-3">
        <PlaceSearch
          label="From (home)"
          chosen={labels.from ?? (hasFrom ? savedLabel : null)}
          onPick={(p) => own.pick("from", p)}
          myLocation
          bias={own.bias}
          onLocated={own.setBias}
        />
        <PlaceSearch
          label="To (work)"
          chosen={labels.to ?? (hasTo ? savedLabel : null)}
          onPick={(p) => own.pick("to", p)}
          bias={own.bias}
        />
      </div>
      <div className="space-y-2" aria-live="polite">
        {draft.step === "home" && !draft.work && <p className="font-medium">Search your home and work above, or tap home on the map.</p>}
        {draft.step === "home" && draft.work && <p className="font-medium">Work set. Now search or tap your home.</p>}
        {draft.step === "work" && <p className="font-medium">Home set. Now search or tap work.</p>}
        {draft.step === "set" && (
          <>
            <p className="font-medium">Your trip is saved on this phone.</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              It leaves the phone only inside a check, and Lusong&apos;s server doesn&apos;t keep it unless you switch on the
              watcher below. Place names you type go to Lusong&apos;s server and to Photon, an OpenStreetMap search, to find
              the place; neither keeps them for Lusong. To change the trip, search again or tap a new home on the map.
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
            That spot is outside {TRIP_AREA_NAME}. Lusong checks trips in {TRIP_AREA_NAME} only, because the flood advisory it
            reads is placed there.
          </p>
        )}
      </div>
      {(draft.step !== "home" || draft.work || own.outside) && (
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
