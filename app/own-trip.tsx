"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Point } from "../lib/answer";
import type { Place } from "../lib/built-in-places";
import { TRIP_AREA_NAME } from "../lib/trip-bound";
import { PlaceSearch } from "./place-search";
import { createTripStore, pickBothTrip, pickTrip, startTrip, tapTrip, type TripDraft } from "./trip";

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

interface Named {
  name: string;
  at: Point;
}

function nameFor(named: Named | null, at: Point | undefined): string | null {
  return named && at && named.at.lat === at.lat && named.at.lon === at.lon ? named.name : null;
}

export interface OwnTrip {
  draft: TripDraft;
  /** The last tap or pick was outside the trip bound. */
  outside: boolean;
  /** What the From and To boxes show; names of picked places are kept only while the page is open. */
  labels: { from: string | null; to: string | null };
  bias: { lat: number; lon: number } | null;
  setBias: (at: { lat: number; lon: number }) => void;
  pick: (end: "from" | "to", place: Place) => void;
  /** Fills From and To together, as two picks would: a typed trip once the rider taps Use this trip. */
  pickBoth: (from: Place, to: Place) => boolean;
  /** False when the phone wouldn't store the trip, so it lasts only while the page is open. */
  kept: boolean;
  /** The last clear failed: the phone wouldn't remove the trip, so it is still saved. */
  clearFailed: boolean;
  tap: (at: Point) => void;
  clear: () => void;
  /** The rider has picked or tapped an end on this page since it opened or was cleared: only then may the map move to it. */
  touched: boolean;
}

/** `changed` runs whenever a tap, a clear or another tab changes the trip, so an answer for the old one isn't left showing. */
export function outsideLine(): string {
  return `That spot is outside ${TRIP_AREA_NAME}. Lusong checks trips in ${TRIP_AREA_NAME} only, where PAGASA's flood advisories are placed.`;
}

export const CLEAR_FAILED_LINE =
  "This phone wouldn't remove your trip, so it is still saved here. Try again, or clear this site's data in your browser.";

export interface OwnTripEvents {
  /** A tap or pick outside the trip bound, which changed nothing. */
  outside?: () => void;
  clearFailed?: () => void;
}

export function useOwnTrip(changed: () => void, events: OwnTripEvents = {}): OwnTrip {
  // The server has no phone storage, so it renders no trip and the saved one appears once the page is running.
  const saved = useSyncExternalStore(subscribe, savedTrip, () => null);
  const [pending, setPending] = useState<TripDraft | null>(null);
  // Each name is kept with the point it names, so a trip changed in another tab never shows this tab's old names.
  const [named, setNamed] = useState<{ from: Named | null; to: Named | null }>({ from: null, to: null });
  const [bias, setBias] = useState<{ lat: number; lon: number } | null>(null);
  const [outside, setOutside] = useState(false);
  const [kept, setKept] = useState(true);
  const [clearFailed, setClearFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const latestChanged = useRef(changed);
  const latestEvents = useRef(events);
  useEffect(() => {
    latestChanged.current = changed;
    latestEvents.current = events;
  });
  useEffect(() => tripStore().subscribe(() => latestChanged.current()), []);
  const draft: TripDraft = pending ?? startTrip(saved);

  function apply(next: { draft: TripDraft; outside: boolean }): boolean {
    setOutside(next.outside);
    setClearFailed(false);
    if (next.outside) {
      latestEvents.current.outside?.();
      return false;
    }
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
    setTouched(true);
    const tapped = { name: "Point tapped on the map", at };
    if (startsNew) setNamed({ from: tapped, to: null });
    else if (fillsFrom) setNamed((l) => ({ ...l, from: tapped }));
    else setNamed((l) => ({ ...l, to: tapped }));
  }

  function pick(end: "from" | "to", place: Place) {
    if (!apply(pickTrip(draft, end, place))) return;
    setTouched(true);
    const name = place.area ? `${place.name}, ${place.area}` : place.name;
    setNamed((l) => ({ ...l, [end]: { name, at: { lat: place.lat, lon: place.lon } } }));
  }

  function pickBoth(from: Place, to: Place): boolean {
    if (!apply(pickBothTrip(draft, from, to))) return false;
    setTouched(true);
    const named = (place: Place) => ({ name: place.area ? `${place.name}, ${place.area}` : place.name, at: { lat: place.lat, lon: place.lon } });
    setNamed({ from: named(from), to: named(to) });
    return true;
  }

  function clear() {
    if (!tripStore().clear()) {
      setClearFailed(true);
      latestEvents.current.clearFailed?.();
      return;
    }
    setClearFailed(false);
    setPending(null);
    setNamed({ from: null, to: null });
    setOutside(false);
    setKept(true);
    setTouched(false);
    changed();
  }

  const home = draft.step === "set" ? draft.trip.home : draft.step === "work" ? draft.home : undefined;
  const work = draft.step === "set" ? draft.trip.work : draft.step === "home" ? draft.work : undefined;
  const labels = { from: nameFor(named.from, home), to: nameFor(named.to, work) };
  return { draft, outside, kept, clearFailed, labels, bias, setBias, pick, pickBoth, tap, clear, touched };
}

export function OwnTripPanel({ own, onFocusBox, focusSignal }: { own: OwnTrip; onFocusBox?: () => void; focusSignal?: number }) {
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
          onFocusBox={onFocusBox}
          focusSignal={focusSignal}
        />
        <PlaceSearch
          label="To (work)"
          chosen={labels.to ?? (hasTo ? savedLabel : null)}
          onPick={(p) => own.pick("to", p)}
          bias={own.bias}
          onFocusBox={onFocusBox}
        />
      </div>
      <div className="space-y-2" aria-live="polite">
        {draft.step === "home" && !draft.work && <p className="font-medium">Search your home and work above, or tap home on the map.</p>}
        {draft.step === "home" && draft.work && <p className="font-medium">Work set. Now search or tap your home.</p>}
        {draft.step === "work" && <p className="font-medium">Home set. Now search or tap work.</p>}
        {draft.step === "set" && (
          <>
            <p className="font-medium">Your trip is saved on this phone.</p>
            <p className="text-ink-2">
              It leaves the phone only inside a check, and Lusong&apos;s server doesn&apos;t keep it unless you switch on the
              watcher below. Place names you type are sent to Lusong&apos;s server and to Photon, komoot&apos;s OpenStreetMap
              search, to find the place. Lusong doesn&apos;t store any of them. What the trip box sends is said beside it. To
              change the trip, search again or tap a new home on the map.
            </p>
            {!own.kept && (
              <p className="text-warn-ink">This phone wouldn&apos;t store it, so it lasts until you close the page.</p>
            )}
          </>
        )}
        {own.clearFailed && (
          <p role="status" className="font-medium text-warn-ink">
            {CLEAR_FAILED_LINE}
          </p>
        )}
        {own.outside && (
          <p role="status" className="font-medium text-warn-ink">
            {outsideLine()}
          </p>
        )}
      </div>
      {(draft.step !== "home" || draft.work || own.outside) && (
        <button
          type="button"
          onClick={own.clear}
          className="min-h-11 rounded-chip border border-line bg-surface px-4 text-sm font-medium text-ink"
        >
          Clear my trip
        </button>
      )}
    </div>
  );
}
