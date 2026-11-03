import type { Point } from "../lib/answer";
import type { Place } from "../lib/built-in-places";
import { inTripBound } from "../lib/trip-bound";
import { leaveAtOf, TRIP_TEXT_CANDIDATES, TRIP_TEXT_REASONS, type TripTextReason, type TripTextReply } from "../lib/trip-text-words";
import type { WindowInput } from "./watcher";

/** The typed box: nothing here is the trip until the rider taps Use this trip. */
export type TypedTripView =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "failed"; reason: TripTextReason }
  | { step: "choose"; from: Place[]; to: Place[]; leaveAt: string | null; picked: { from: number | null; to: number | null } };

export interface TypedTripState {
  /** Each send gets a new ticket, so a slow reply to an older send is dropped. */
  ticket: number;
  view: TypedTripView;
}

export type TypedTripAction =
  | { type: "send" }
  | { type: "reply"; ticket: number; reply: TripTextReply }
  | { type: "pick"; end: "from" | "to"; index: number }
  | { type: "dismiss" }
  | { type: "used" };

export const initialTypedTrip: TypedTripState = { ticket: 0, view: { step: "idle" } };

export function typedTripReducer(state: TypedTripState, action: TypedTripAction): TypedTripState {
  switch (action.type) {
    case "send":
      return { ticket: state.ticket + 1, view: { step: "reading" } };
    case "reply": {
      if (action.ticket !== state.ticket || state.view.step !== "reading") return state;
      const { reply } = action;
      if (reply.status === "failed") return { ...state, view: { step: "failed", reason: reply.reason } };
      // A lone candidate is the only choice; with more, the rider picks.
      const only = (places: Place[]) => (places.length === 1 ? 0 : null);
      return {
        ...state,
        view: { step: "choose", from: reply.from, to: reply.to, leaveAt: reply.leave_at, picked: { from: only(reply.from), to: only(reply.to) } },
      };
    }
    case "pick": {
      const { view } = state;
      if (view.step !== "choose" || !Number.isInteger(action.index) || action.index < 0 || action.index >= view[action.end].length) return state;
      return { ...state, view: { ...view, picked: { ...view.picked, [action.end]: action.index } } };
    }
    case "dismiss":
    case "used":
      return { ticket: state.ticket + 1, view: { step: "idle" } };
  }
}

/** The trip Use this trip would fill, or null until one place is picked for each end. */
export function chosenTrip(state: TypedTripState): { from: Place; to: Place; leaveAt: string | null } | null {
  const { view } = state;
  if (view.step !== "choose" || view.picked.from === null || view.picked.to === null) return null;
  return { from: view.from[view.picked.from], to: view.to[view.picked.to], leaveAt: view.leaveAt };
}

function placeOf(value: unknown): Place | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, area, lat, lon, source } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || typeof area !== "string" || !name.trim()) return null;
  if (name.length > 80 || area.length > 200 || (source !== "osm" && source !== "built-in")) return null;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || !inTripBound({ lat, lon })) return null;
  return { id, name, area, lat, lon, source };
}

function placesOf(value: unknown): Place[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const places = value.slice(0, TRIP_TEXT_CANDIDATES).map(placeOf);
  return places.every((p): p is Place => p !== null) ? places : null;
}

/** The server's reply, checked again on the phone: anything off its shape reads as the model being unavailable. */
export function tripTextReplyOf(body: unknown): TripTextReply {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.status === "ok") {
    const from = placesOf(b.from);
    const to = placesOf(b.to);
    if (from && to) return { status: "ok", from, to, leave_at: leaveAtOf(b.leave_at) };
  }
  if (b.status === "failed" && (TRIP_TEXT_REASONS as readonly unknown[]).includes(b.reason)) {
    return { status: "failed", reason: b.reason as TripTextReason };
  }
  return { status: "failed", reason: "model" };
}

export function candidateLine(p: Place): string {
  return p.area ? `${p.name}, ${p.area}` : p.name;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The watcher's window for a leaving time: from an hour before, on the time box's 10-minute steps, to the time itself. */
export function watchWindowFor(leaveAt: string): WindowInput {
  const leave = minutesOf(leaveAt);
  const start = Math.max(0, Math.floor((leave - 60) / 10) * 10);
  const end = Math.min(23 * 60 + 59, Math.max(start + 10, Math.ceil(leave / 10) * 10));
  return { start: hhmmOf(start), end: hhmmOf(end) };
}

/** A leaving time kept with the trip it came with: a trip changed since then has no leaving time. */
export interface TypedLeave {
  leaveAt: string;
  home: Point;
  work: Point;
}

export function leaveAtFor(typed: TypedLeave | null, trip: { home: Point; work: Point } | null): string | null {
  if (!typed || !trip) return null;
  const same = (a: Point, b: Point) => a.lat === b.lat && a.lon === b.lon;
  return same(typed.home, trip.home) && same(typed.work, trip.work) ? typed.leaveAt : null;
}
