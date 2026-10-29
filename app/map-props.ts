import type { Point } from "../lib/answer";
import type { MapPin, TripMapProps } from "./map";
import type { TripDraft } from "./trip";

interface Answered {
  route: { line: Point[] };
  detour: { line: Point[] } | null;
  reports: MapPin[];
}

/** What the map draws: a demo trip's ends or the commuter's taps, and once answered, the routes and report pins. */
export function tripMapProps(input: { demo: { from: Point; to: Point } | null; draft: TripDraft; result: Answered | null }): Omit<TripMapProps, "onTap"> {
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
        : [];
  // Mid-tap the view stays put, so the work tap lands where the commuter is looking.
  const frame = result
    ? [...result.route.line, ...(result.detour?.line ?? []), ...result.reports.map((r) => r.at)]
    : !demo && draft.step === "work"
      ? []
      : ends.map((e) => e.at);
  return {
    ends,
    route: result?.route.line ?? null,
    detour: result?.detour?.line ?? null,
    pins: result?.reports ?? [],
    frame,
  };
}
