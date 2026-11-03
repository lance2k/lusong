import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEMO_TRIPS } from "../lib/samples";
import { initialCommuteState, OWN_TRIP } from "./commute-state";
import type { OwnTrip } from "./own-trip";
import { TripChips, WhereTo } from "./where-to";

const HOME = { lat: 10.2551, lon: 123.8001 };
const WORK = { lat: 10.2612, lon: 123.8405 };

const own: OwnTrip = {
  draft: { step: "set", trip: { home: HOME, work: WORK } },
  outside: false,
  labels: { from: null, to: null },
  bias: null,
  setBias: () => {},
  pick: () => {},
  pickBoth: () => false,
  kept: true,
  clearFailed: false,
  tap: () => {},
  clear: () => {},
  touched: false,
};

const noop = () => {};

function chipLabels(html: string): string[] {
  const trip = /<fieldset[^>]*><legend[^>]*>Trip<\/legend>([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";
  return [...trip.matchAll(/<button[^>]*aria-pressed[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

describe("the trip chips (S3P-1)", () => {
  it("offer My trip and the demo trips only, with no reverse trip", () => {
    const html = renderToStaticMarkup(<TripChips value={OWN_TRIP} onChange={noop} />);
    expect(chipLabels(html)).toEqual(["My trip", ...Object.values(DEMO_TRIPS).map((t) => t.label.replace(/&/g, "&amp;"))]);
    expect(html).not.toMatch(/to home|reverse|swap|return trip/i);
  });

  it("the whole Where to? form, with a saved trip, has no reverse either", () => {
    const html = renderToStaticMarkup(
      <WhereTo
        headingId="h"
        inputs={{ ...initialCommuteState.inputs, trip: OWN_TRIP }}
        change={noop}
        own={own}
        checking={false}
        canCheck
        onCheck={noop}
        onFocusBox={noop}
        focusSignal={0}
        onPickMyTrip={noop}
        onOpenWatcher={noop}
        collapsed={false}
        onExpand={noop}
        summary={null}
        onUseTypedTrip={() => false}
        leaveAt={null}
      />,
    );
    expect(chipLabels(html)[0]).toBe("My trip");
    expect(html).not.toMatch(/to home|reverse|swap|return trip/i);
    expect(html).toContain("Check my trip");
    expect(html).toContain("Your trip is saved on this phone.");
    expect(html).toContain("Photon, komoot&#x27;s OpenStreetMap");
  });

  it("puts the typed box above From and To, and the privacy line under them covers it (S5)", () => {
    const html = renderToStaticMarkup(
      <WhereTo
        headingId="h"
        inputs={{ ...initialCommuteState.inputs, trip: OWN_TRIP }}
        change={noop}
        own={own}
        checking={false}
        canCheck
        onCheck={noop}
        onFocusBox={noop}
        focusSignal={0}
        onPickMyTrip={noop}
        onOpenWatcher={noop}
        collapsed={false}
        onExpand={noop}
        summary={null}
        onUseTypedTrip={() => false}
        leaveAt="07:00"
      />,
    );
    const typed = html.indexOf("Or type your trip");
    expect(typed).toBeGreaterThan(-1);
    expect(typed).toBeLessThan(html.indexOf("From (home)"));
    expect(html).toContain("The words you type here are sent to Lusong&#x27;s server and to Meta&#x27;s Model API");
    const privacy = /Place names you type[^<]*/.exec(html)![0];
    expect(privacy).toContain("Words you type in the trip box are sent to Lusong&#x27;s server and to Meta&#x27;s Model API");
    expect(privacy).toContain("Lusong doesn&#x27;t store any of them");
    expect(html).toContain("Leaving around 07:00. If you switch on the watcher, its window starts an hour before.");
  });

  it("shows no leaving time without one", () => {
    const html = renderToStaticMarkup(
      <WhereTo
        headingId="h"
        inputs={{ ...initialCommuteState.inputs, trip: OWN_TRIP }}
        change={noop}
        own={own}
        checking={false}
        canCheck
        onCheck={noop}
        onFocusBox={noop}
        focusSignal={0}
        onPickMyTrip={noop}
        onOpenWatcher={noop}
        collapsed={false}
        onExpand={noop}
        summary={null}
        onUseTypedTrip={() => false}
        leaveAt={null}
      />,
    );
    expect(html).not.toContain("Leaving around");
  });

  it("a demo trip shows its sample chips with the samples line", () => {
    const html = renderToStaticMarkup(
      <WhereTo
        headingId="h"
        inputs={initialCommuteState.inputs}
        change={noop}
        own={own}
        checking={false}
        canCheck
        onCheck={noop}
        onFocusBox={noop}
        focusSignal={0}
        onPickMyTrip={noop}
        onOpenWatcher={noop}
        collapsed={false}
        onExpand={noop}
        summary={null}
        onUseTypedTrip={() => false}
        leaveAt={null}
      />,
    );
    expect(html).toContain("Samples are labelled test photos from elsewhere, pinned on these streets for the demo. Real checks never use them.");
    expect(html).toContain("Check this commute");
  });
});
