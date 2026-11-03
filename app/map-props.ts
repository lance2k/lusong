import type { Point } from "../lib/answer";
import type { MapPin, TripMapProps } from "./map";
import { PHOTO_ALT } from "./report-evidence";
import type { TripDraft } from "./trip";

interface Answered {
  route: { line: Point[] };
  detour: { line: Point[] } | null;
  reports: MapPin[];
}

/**
 * Where the map opens: a fixed view over the Philippines. OpenStreetMap's tile server sees every tile the map asks for,
 * so the view never moves to a saved trip on its own, only after the rider picks or taps an end (`riderMoved`).
 */
export const PHILIPPINES_VIEW = { centre: { lat: 12.6, lon: 122.4 }, zoom: 5 } as const;

/**
 * What the map draws: a demo trip's ends or the commuter's taps, and once answered, the routes and report pins. It
 * frames the routes once answered, a demo trip's own ends, or the rider's ends after the rider's own pick or tap.
 */
export function tripMapProps(input: {
  demo: { from: Point; to: Point } | null;
  draft: TripDraft;
  riderMoved?: boolean;
  result: Answered | null;
}): Omit<TripMapProps, "onTap"> {
  const { demo, draft, result } = input;
  const ends = demo
    ? [
        { at: demo.from, label: "Start" },
        { at: demo.to, label: "End" },
      ]
    : draft.step === "work"
      ? [{ at: draft.home, label: "Home" }]
      : draft.step === "set"
        ? [
            { at: draft.trip.home, label: "Home" },
            { at: draft.trip.work, label: "Work" },
          ]
        : draft.work
          ? [{ at: draft.work, label: "Work" }]
          : [];
  const frame = result
    ? [...result.route.line, ...(result.detour?.line ?? [])]
    : demo || (input.riderMoved && ends.length > 0)
      ? ends.map((e) => e.at)
      : null;
  return {
    ends,
    route: result?.route.line ?? null,
    detour: result?.detour?.line ?? null,
    pins: result?.reports ?? [],
    frame,
  };
}

/** A report pin's popup: its blurred photo when one was published, then its lines of text. */
export function pinPopup(pin: MapPin): { photo: { src: string; alt: string } | null; lines: string[] } {
  const lines = [
    pin.sample ? "Sample: a labelled test photo from elsewhere, pinned here for the demo." : null,
    pin.place,
    pin.age,
    pin.depth && `Water ${pin.depth}.`,
    pin.passability && `${pin.passability}.`,
    pin.counts ? null : "Older than 3 hours: shown, not counted.",
  ].filter((line): line is string => Boolean(line));
  return { photo: pin.photoUrl ? { src: pin.photoUrl, alt: PHOTO_ALT } : null, lines };
}
