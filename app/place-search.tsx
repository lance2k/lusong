"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { MAX_QUERY, MIN_QUERY, type Place, type PlacesStatus } from "../lib/built-in-places";
import { inTripBound, TRIP_AREA_NAME } from "../lib/trip-bound";
import { phoneLocation } from "./phone-location";
import { boxReducer, initialBox, isOpen, searchFor, shownValue, type Lookup } from "./place-box";

const DEBOUNCE_MS = 300;

const STATUS_LINE: Partial<Record<Lookup["status"], string>> = {
  busy: "Place search is busy right now. Pick a suggested place, or tap the map.",
  down: "Place search can't be reached right now. Pick a suggested place, or tap the map.",
};

export interface PlaceSearchProps {
  label: string;
  /** What the box shows once an end is set: a picked place's name, or a saved or tapped point's description. */
  chosen: string | null;
  onPick: (place: Place) => void;
  /** Offers "Use my location" beside the box. */
  myLocation?: boolean;
  /** The phone's rounded location, used to bias suggestions when the rider shared it. */
  bias: { lat: number; lon: number } | null;
  onLocated?: (at: { lat: number; lon: number }) => void;
  /** Runs when the box gets focus, so the panel can open to full height. */
  onFocusBox?: () => void;
  /** Focuses the box each time it changes to a new number above 0. */
  focusSignal?: number;
}

export function PlaceSearch({ label, chosen, onPick, myLocation, bias, onLocated, onFocusBox, focusSignal = 0 }: PlaceSearchProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [box, send] = useReducer(boxReducer, initialBox);
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const query = searchFor(box);
  const fallback = useRef(box.lookup.places);
  useEffect(() => {
    fallback.current = box.lookup.places;
  });

  // A newer query aborts the older request, so a slow reply never replaces a newer one.
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q: query });
      if (bias) {
        params.set("lat", String(bias.lat));
        params.set("lon", String(bias.lon));
      }
      try {
        const res = await fetch(`/api/places?${params}`, { signal: controller.signal });
        const body = (await res.json()) as { status?: PlacesStatus; places?: Place[] };
        if (controller.signal.aborted) return;
        send({ type: "results", lookup: { status: body.status ?? "down", places: Array.isArray(body.places) ? body.places : [] } });
      } catch {
        if (controller.signal.aborted) return;
        send({ type: "results", lookup: { status: "down", places: fallback.current } });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, bias]);

  function pick(place: Place) {
    send({ type: "picked" });
    setNote(null);
    onPick(place);
  }

  async function useMyLocation() {
    setLocating(true);
    setNote(null);
    try {
      const at = await phoneLocation();
      onLocated?.({ lat: Math.round(at.lat * 10) / 10, lon: Math.round(at.lon * 10) / 10 });
      if (!inTripBound(at)) {
        setNote(`Your location is outside ${TRIP_AREA_NAME}, where Lusong checks trips.`);
        return;
      }
      pick({ id: "my-location", name: "My location", area: "", lat: at.lat, lon: at.lon, source: "built-in" });
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Lusong couldn't read your location.");
    } finally {
      setLocating(false);
    }
  }

  const open = isOpen(box);

  useEffect(() => {
    if (focusSignal > 0) input.current?.focus();
  }, [focusSignal]);

  // In a sheet the list can open below the fold; it is brought into view once it has suggestions.
  useEffect(() => {
    if (open) list.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const { lookup, active } = box;
  const empty = query && lookup.status === "ok" && lookup.places.length === 0;
  const statusLine = box.editing ? STATUS_LINE[lookup.status] : undefined;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
      e.preventDefault();
      send({ type: "move", by: e.key === "ArrowDown" ? 1 : -1 });
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      pick(lookup.places[active]);
    } else if (e.key === "Escape") {
      send({ type: "escape" });
    }
  }

  return (
    <div ref={wrapper} className="relative scroll-mt-4">
      <label htmlFor={`${id}-input`} className="block text-label text-ink-2">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`${id}-input`}
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY}
          placeholder={chosen ?? `Search ${TRIP_AREA_NAME}…`}
          value={shownValue(box, chosen)}
          onFocus={() => {
            send({ type: "focus" });
            if (onFocusBox) {
              onFocusBox();
              // After the panel has grown, so the box and its suggestions are in view.
              setTimeout(() => wrapper.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 420);
            }
          }}
          onBlur={() =>
            setTimeout(() => {
              if (document.activeElement !== input.current) send({ type: "blur" });
            }, 150)
          }
          onChange={(e) => send({ type: "type", value: e.target.value })}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-2"
        />
        {myLocation && (
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="min-h-11 shrink-0 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink disabled:opacity-60"
          >
            {locating ? "Locating…" : "Use my location"}
          </button>
        )}
      </div>
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!open}
        className="relative z-[1000] mt-1 max-h-72 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg"
      >
        {lookup.places.map((place, i) => (
          <li
            key={place.id}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(place);
            }}
            className="cursor-pointer px-3 py-2 aria-selected:bg-brand/15"
          >
            <span className="block font-medium">{place.name}</span>
            {place.area && <span className="block text-sm text-ink-2">{place.area}</span>}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-sm text-ink-2" aria-live="polite">
        {box.editing && box.text.length > 0 && box.text.trim().length < MIN_QUERY && `Type at least ${MIN_QUERY} letters.`}
        {lookup.status === "searching" && query && "Searching…"}
        {empty && `No place by that name in ${TRIP_AREA_NAME}. Try another name, or tap the map.`}
        {statusLine}
        {note}
      </p>
    </div>
  );
}
