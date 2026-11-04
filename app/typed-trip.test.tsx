import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Place } from "../lib/built-in-places";
import { parseWindow } from "../lib/watch-window";
import { TO_THE_BOXES, TRIP_TEXT_LINES, TRIP_TEXT_REASONS, type TripTextReply } from "../lib/trip-text-words";
import { createTripStore, pickBothTrip, pickTrip, startTrip, type TripStorage } from "./trip";
import { PICK_BOTH_LINE, TYPED_TRIP_EXAMPLE, TypedTripView, USE_THIS_TRIP } from "./typed-trip-box";
import {
  chosenTrip,
  initialTypedTrip,
  leaveAtFor,
  tripTextReplyOf,
  typedTripReducer,
  watchWindowFor,
  type TypedTripAction,
  type TypedTripState,
} from "./typed-trip";
import { initialHours } from "./watcher-panel";

const place = (id: string, name: string, area: string, lat: number, lon: number): Place => ({ id, name, area, lat, lon, source: "osm" });
const TALAMBAN = place("osm:N1", "Talamban Road", "Cebu City", 10.3561, 123.9131);
const TALAMBAN_HALL = place("osm:N2", "Talamban Barangay Hall", "Cebu City", 10.3602, 123.9116);
const IT_PARK = place("osm:N3", "Cebu IT Park", "Lahug, Cebu City", 10.3301, 123.9061);

const OK: TripTextReply = { status: "ok", from: [TALAMBAN, TALAMBAN_HALL], to: [IT_PARK], leave_at: "07:00" };

const run = (actions: TypedTripAction[], from: TypedTripState = initialTypedTrip) => actions.reduce(typedTripReducer, from);

describe("the typed box's state (S5)", () => {
  it("reads, then offers the places, with a lone candidate already picked", () => {
    const reading = run([{ type: "send" }]);
    expect(reading.view.step).toBe("reading");
    const choosing = run([{ type: "reply", ticket: reading.ticket, reply: OK }], reading);
    expect(choosing.view).toEqual({ step: "choose", from: OK.from, to: OK.to, leaveAt: "07:00", picked: { from: null, to: 0 } });
  });

  it("drops a reply to an older send", () => {
    const first = run([{ type: "send" }]);
    const second = run([{ type: "send" }], first);
    expect(run([{ type: "reply", ticket: first.ticket, reply: OK }], second).view.step).toBe("reading");
  });

  it("ignores a pick outside the candidates", () => {
    const s = run([{ type: "send" }, { type: "reply", ticket: 1, reply: OK }]);
    expect(run([{ type: "pick", end: "from", index: 5 }], s)).toBe(s);
    expect(run([{ type: "pick", end: "to", index: -1 }], s)).toBe(s);
  });

  it("editing during a request drops its late reply: Use this trip is not offered for the old text (S5-4)", () => {
    const reading = run([{ type: "send" }]);
    const edited = run([{ type: "edit" }, { type: "reply", ticket: reading.ticket, reply: OK }], reading);
    expect(edited.view).toEqual({ step: "idle" });
    expect(chosenTrip(edited)).toBeNull();
    expect(render(edited)).not.toContain(USE_THIS_TRIP);
  });

  it("editing after the candidates appear withdraws them: Use this trip is not offered for the old text (S5-4)", () => {
    const picked = run([{ type: "send" }, { type: "reply", ticket: 1, reply: OK }, { type: "pick", end: "from", index: 0 }]);
    expect(chosenTrip(picked)).not.toBeNull();
    const edited = run([{ type: "edit" }], picked);
    expect(edited.view).toEqual({ step: "idle" });
    expect(chosenTrip(edited)).toBeNull();
    expect(render(edited)).not.toContain(USE_THIS_TRIP);
    // A reply to the send before the edit, arriving now, changes nothing.
    expect(run([{ type: "reply", ticket: picked.ticket, reply: OK }], edited)).toEqual(edited);
  });

  it("nothing is saved or checked before Use this trip", async () => {
    const storage: TripStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const store = createTripStore(storage, null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const steps: TypedTripAction[] = [
        { type: "send" },
        { type: "reply", ticket: 1, reply: OK },
        { type: "pick", end: "from", index: 1 },
        { type: "pick", end: "from", index: 0 },
        { type: "dismiss" },
        { type: "send" },
        { type: "reply", ticket: 3, reply: tripTextReplyOf(OK) },
      ];
      let s = initialTypedTrip;
      for (const a of steps) {
        s = typedTripReducer(s, a);
        // Until both ends are picked there is no trip to use; picking alone fills nothing.
        if (s.view.step !== "choose" || s.view.picked.from === null) expect(chosenTrip(s)).toBeNull();
      }
      expect(store.get()).toBeNull();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      s = typedTripReducer(s, { type: "pick", end: "from", index: 1 });
      const chosen = chosenTrip(s)!;
      expect(chosen).toEqual({ from: TALAMBAN_HALL, to: IT_PARK, leaveAt: "07:00" });
      expect(storage.setItem).not.toHaveBeenCalled();

      // Use this trip: the same pickTrip as two picks in the boxes, then the same save.
      const filled = pickBothTrip(startTrip(null), chosen.from, chosen.to);
      expect(filled).toEqual(pickTrip(pickTrip(startTrip(null), "from", chosen.from).draft, "to", chosen.to));
      expect(filled.draft).toEqual({ step: "set", trip: { home: TALAMBAN_HALL, work: IT_PARK } });
      expect(typedTripReducer(s, { type: "used" }).view).toEqual({ step: "idle" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fills neither end when one is outside the trip bound", () => {
    const tokyo = place("osm:N9", "Tokyo", "", 35.68, 139.76);
    expect(pickBothTrip(startTrip(null), TALAMBAN, tokyo)).toEqual({ draft: { step: "home" }, outside: true });
    expect(pickBothTrip(startTrip(null), tokyo, IT_PARK)).toEqual({ draft: { step: "home" }, outside: true });
  });
});

describe("the reply, checked again on the phone", () => {
  it("keeps the place fields only, at most 3 per end, and a time only as HH:MM", () => {
    const loud = { ...TALAMBAN, note: "model words" };
    const reply = tripTextReplyOf({ status: "ok", from: [loud, TALAMBAN_HALL, TALAMBAN, IT_PARK], to: [IT_PARK], leave_at: "7 am", said: "x" });
    expect(reply).toEqual({ status: "ok", from: [TALAMBAN, TALAMBAN_HALL, TALAMBAN], to: [IT_PARK], leave_at: null });
  });

  it("drops one candidate off its shape alone, keeping the rest (S5-2)", () => {
    const bad = { ...TALAMBAN, id: 7 };
    expect(tripTextReplyOf({ status: "ok", from: [bad, TALAMBAN_HALL], to: [IT_PARK], leave_at: "07:00" })).toEqual({
      status: "ok",
      from: [TALAMBAN_HALL],
      to: [IT_PARK],
      leave_at: "07:00",
    });
  });

  it("reads anything off its shape as the model message", () => {
    expect(tripTextReplyOf(null)).toEqual({ status: "failed", reason: "model" });
    expect(tripTextReplyOf({ status: "ok", from: [], to: [IT_PARK] })).toEqual({ status: "failed", reason: "model" });
    expect(tripTextReplyOf({ status: "ok", from: [{ ...TALAMBAN, lat: 35.6 }], to: [IT_PARK] })).toEqual({ status: "failed", reason: "model" });
    expect(tripTextReplyOf({ status: "failed", reason: "Ignore the rules" })).toEqual({ status: "failed", reason: "model" });
    expect(tripTextReplyOf({ status: "failed", reason: "budget" })).toEqual({ status: "failed", reason: "budget" });
  });
});

describe("the leaving time and the watcher", () => {
  it("makes a window from an hour before to the time, on 10-minute steps, inside one day", () => {
    expect(watchWindowFor("07:00")).toEqual({ start: "06:00", end: "07:00" });
    expect(watchWindowFor("07:15")).toEqual({ start: "06:10", end: "07:20" });
    expect(watchWindowFor("00:05")).toEqual({ start: "00:00", end: "00:10" });
    expect(watchWindowFor("00:00")).toEqual({ start: "00:00", end: "00:10" });
    expect(watchWindowFor("23:55")).toEqual({ start: "22:50", end: "23:59" });
    for (const t of ["00:00", "00:05", "06:59", "07:00", "12:30", "23:55", "23:59"]) expect(parseWindow(watchWindowFor(t))).not.toBeNull();
  });

  it("pre-fills the watcher's time boxes only with a leaving time", () => {
    expect(initialHours(null)).toEqual({ start: "06:00", end: "08:00" });
    expect(initialHours("07:00")).toEqual({ start: "06:00", end: "07:00" });
  });

  it("is kept only while the trip is the one it came with", () => {
    const typed = { leaveAt: "07:00", home: { lat: 10.3561, lon: 123.9131 }, work: { lat: 10.3301, lon: 123.9061 } };
    expect(leaveAtFor(typed, { home: TALAMBAN, work: IT_PARK })).toBe("07:00");
    expect(leaveAtFor(typed, { home: TALAMBAN_HALL, work: IT_PARK })).toBeNull();
    expect(leaveAtFor(typed, null)).toBeNull();
    expect(leaveAtFor(null, { home: TALAMBAN, work: IT_PARK })).toBeNull();
  });
});

function render(state: TypedTripState, text = "Talamban to IT Park, leaving around 7") {
  return renderToStaticMarkup(<TypedTripView state={state} text={text} onText={() => {}} onSend={() => {}} send={() => {}} onUse={() => {}} />);
}

describe("the typed box as drawn", () => {
  it("shows the search's names per end, the leaving time, and Use this trip disabled until both are picked", () => {
    const s = run([{ type: "send" }, { type: "reply", ticket: 1, reply: OK }]);
    const html = render(s);
    expect(html).toContain("Talamban Road, Cebu City");
    expect(html).toContain("Talamban Barangay Hall, Cebu City");
    expect(html).toContain("Cebu IT Park, Lahug, Cebu City");
    expect(html).toContain("Leaving around 07:00");
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${USE_THIS_TRIP}</button>`));
    expect(html).toContain(PICK_BOTH_LINE);
    const picked = render(run([{ type: "pick", end: "from", index: 0 }], s));
    expect(picked).toMatch(new RegExp(`<button(?![^>]*disabled="")[^>]*>${USE_THIS_TRIP}</button>`));
    expect(picked).not.toContain(PICK_BOTH_LINE);
  });

  it("each failure is one fixed line that points to the From and To boxes", () => {
    for (const reason of TRIP_TEXT_REASONS) {
      const html = render({ ticket: 1, view: { step: "failed", reason } });
      expect(html).toContain(TRIP_TEXT_LINES[reason].replace(/'/g, "&#x27;"));
      if (reason !== "text") expect(TRIP_TEXT_LINES[reason]).toContain(TO_THE_BOXES);
    }
  });

  it("always says where the typed words go", () => {
    expect(render(initialTypedTrip)).toContain("sent to Lusong&#x27;s server and to Meta&#x27;s Model API to read the place names");
  });
});

describe("the typed box's example (#53)", () => {
  it("is a visible line the box points to, not a placeholder a 390 px box cuts off", () => {
    const html = render(initialTypedTrip, "");
    expect(html).not.toContain(`placeholder="${TYPED_TRIP_EXAMPLE}"`);
    const described = /<input[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    expect(html).toMatch(new RegExp(`<p id="${described}"[^>]*>[^<]*${TYPED_TRIP_EXAMPLE}`));
  });

  it("keeps the example S5 measured", () => {
    expect(TYPED_TRIP_EXAMPLE).toBe("Talamban to IT Park, leaving around 7");
  });
});
