import { builtInMatches, placeQuery, type Place, type PlacesStatus } from "../lib/built-in-places";
import { TRIP_BOUND } from "../lib/trip-bound";

export type Lookup = { status: "idle" | "searching" | PlacesStatus; places: Place[] };

/** One From or To box. While editing, it shows what is typed; otherwise the chosen place. */
export interface BoxState {
  editing: boolean;
  text: string;
  lookup: Lookup;
  active: number;
}

export type BoxEvent =
  | { type: "focus" }
  | { type: "type"; value: string }
  | { type: "picked" }
  | { type: "escape" }
  | { type: "blur" }
  | { type: "results"; lookup: Lookup }
  | { type: "move"; by: 1 | -1 };

export const initialBox: BoxState = { editing: false, text: "", lookup: { status: "idle", places: [] }, active: -1 };

function typed(state: BoxState, value: string): BoxState {
  const q = placeQuery(value);
  // Built-in places show at once; the server's arrive after the pause.
  const lookup: Lookup = q ? { status: "searching", places: builtInMatches(q, TRIP_BOUND) } : { status: "idle", places: [] };
  return { editing: true, text: value, lookup, active: -1 };
}

export function boxReducer(state: BoxState, event: BoxEvent): BoxState {
  switch (event.type) {
    case "focus":
    case "picked":
    case "escape":
      // Ready for typing again: empty, with the chosen place as the placeholder until the box loses focus.
      return typed(state, "");
    case "type":
      return typed(state, event.value);
    case "blur":
      return { ...state, editing: false };
    case "results":
      return state.editing ? { ...state, lookup: event.lookup } : state;
    case "move": {
      const n = state.lookup.places.length;
      if (!state.editing || n === 0) return state;
      const next = state.active < 0 ? (event.by === 1 ? 0 : n - 1) : (state.active + event.by + n) % n;
      return { ...state, active: next };
    }
  }
}

export function shownValue(state: BoxState, chosen: string | null): string {
  return state.editing ? state.text : (chosen ?? "");
}

/** The query to send to the server, or null when nothing should be sent. */
export function searchFor(state: BoxState): string | null {
  return state.editing ? placeQuery(state.text) : null;
}

export function isOpen(state: BoxState): boolean {
  return state.editing && state.lookup.places.length > 0;
}
