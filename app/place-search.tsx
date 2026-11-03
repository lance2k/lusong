"use client";

import { useEffect, useId, useRef, useState } from "react";
import { builtInMatches, MAX_QUERY, MIN_QUERY, placeQuery, type Place, type PlacesStatus } from "../lib/built-in-places";
import { inTripBound, TRIP_AREA_NAME, TRIP_BOUND } from "../lib/trip-bound";
import { phoneLocation } from "./phone-location";

const DEBOUNCE_MS = 300;

type Lookup = { status: "idle" | "searching" | PlacesStatus; places: Place[] };

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
}

export function PlaceSearch({ label, chosen, onPick, myLocation, bias, onLocated }: PlaceSearchProps) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ status: "idle", places: [] });
  const [active, setActive] = useState(-1);
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!editing) return;
    const q = placeQuery(text);
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      inflight.current = controller;
      const params = new URLSearchParams({ q });
      if (bias) {
        params.set("lat", String(bias.lat));
        params.set("lon", String(bias.lon));
      }
      try {
        const res = await fetch(`/api/places?${params}`, { signal: controller.signal });
        const body = (await res.json()) as { status?: PlacesStatus; places?: Place[] };
        if (controller.signal.aborted) return;
        setLookup({ status: body.status ?? "down", places: Array.isArray(body.places) ? body.places : [] });
      } catch {
        if (controller.signal.aborted) return;
        setLookup((prev) => ({ status: "down", places: prev.places }));
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, editing, bias]);

  function type(value: string) {
    setText(value);
    setActive(-1);
    const q = placeQuery(value);
    // Built-in places show at once; Photon's arrive after the pause.
    setLookup(q ? { status: "searching", places: builtInMatches(q, TRIP_BOUND) } : { status: "idle", places: [] });
  }

  function pick(place: Place) {
    inflight.current?.abort();
    setEditing(false);
    setText("");
    setLookup({ status: "idle", places: [] });
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

  const open = editing && lookup.places.length > 0;
  const q = placeQuery(text);
  const empty = editing && q && lookup.status === "ok" && lookup.places.length === 0;
  const statusLine = editing ? STATUS_LINE[lookup.status] : undefined;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setActive((i) => (i + 1) % lookup.places.length);
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? lookup.places.length - 1 : i - 1));
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      pick(lookup.places[active]);
    } else if (e.key === "Escape") {
      setEditing(false);
      setText("");
    }
  }

  return (
    <div className="relative">
      <label htmlFor={`${id}-input`} className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          maxLength={MAX_QUERY}
          placeholder={chosen ?? `Search a place in ${TRIP_AREA_NAME}`}
          value={editing ? text : (chosen ?? "")}
          onFocus={() => {
            setEditing(true);
            type("");
          }}
          onBlur={() => setTimeout(() => setEditing(false), 150)}
          onChange={(e) => type(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900"
        />
        {myLocation && (
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="min-h-11 shrink-0 rounded-xl border border-zinc-300 px-3 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
          >
            {locating ? "Locating…" : "Use my location"}
          </button>
        )}
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!open}
        className="absolute z-[1000] mt-1 max-h-72 w-full overflow-auto rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
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
            className="cursor-pointer px-3 py-2 aria-selected:bg-sky-100 dark:aria-selected:bg-sky-900"
          >
            <span className="block font-medium">{place.name}</span>
            {place.area && <span className="block text-sm text-zinc-500">{place.area}</span>}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-sm text-zinc-500" aria-live="polite">
        {editing && text.length > 0 && text.trim().length < MIN_QUERY && `Type at least ${MIN_QUERY} letters.`}
        {lookup.status === "searching" && editing && q && "Searching…"}
        {empty && `No place by that name in ${TRIP_AREA_NAME}. Try another name, or tap the map.`}
        {statusLine}
        {note}
      </p>
    </div>
  );
}
