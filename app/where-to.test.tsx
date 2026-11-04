import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEMO_TRIPS } from "../lib/samples";
import { initialCommuteState, OWN_TRIP } from "./commute-state";
import type { OwnTrip } from "./own-trip";
import { CHECK_BUTTON_ID, inputWords, TripChips, WhereTo, type WhereToProps } from "./where-to";

const HOME = { lat: 10.2551, lon: 123.8001 };
const WORK = { lat: 10.2612, lon: 123.8405 };

const own: OwnTrip = {
  draft: { step: "set", trip: { home: HOME, work: WORK } },
  outside: false,
  labels: { from: null, to: null },
  bias: null,
  setBias: () => {},
  pick: () => false,
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
    expect(privacy).toContain("What the trip box sends is said beside it.");
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

function whereTo(over: Partial<WhereToProps> = {}) {
  return renderToStaticMarkup(
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
      {...over}
    />,
  );
}

describe("follow-ups to S9 (group C)", () => {
  it("before the phone's saved trip is read, no trip is pressed and nothing is checkable (#43)", () => {
    const html = whereTo({ tripKnown: false });
    const tripChips = /<legend[^>]*>Trip<\/legend>([\s\S]*?)<\/fieldset>/.exec(html)![1];
    expect(tripChips).toContain('aria-pressed="false"');
    expect(tripChips).not.toContain('aria-pressed="true"');
    expect(chipLabels(html)[0]).toBe("My trip");
    expect(html).not.toContain("Sample reports");
    expect(html).not.toContain("Or type your trip");
    expect(html).toMatch(new RegExp(`<button[^>]*id="${CHECK_BUTTON_ID}"[^>]*disabled=""`));
  });

  it("once it is read, the chosen trip is pressed as before (#43)", () => {
    expect(whereTo({ tripKnown: true })).toMatch(/aria-pressed="true"[^>]*>Banilad → IT Park/);
    expect(whereTo()).toMatch(/aria-pressed="true"[^>]*>Banilad → IT Park/);
  });

  it("the check button carries the id that Use this trip moves focus to (#49)", () => {
    const html = whereTo({ inputs: { ...initialCommuteState.inputs, trip: OWN_TRIP } });
    expect(html).toMatch(new RegExp(`<button[^>]*id="${CHECK_BUTTON_ID}"[^>]*>Check my trip</button>`));
  });

  it("an own trip's summary names its picked places, and says only Your trip without them (#56)", () => {
    const inputs = { ...initialCommuteState.inputs, trip: OWN_TRIP } as const;
    expect(inputWords(inputs, { from: "Baguio City Hall, Baguio", to: "Wright Park, Baguio" })).toBe(
      "Your trip: Baguio City Hall, Baguio → Wright Park, Baguio · no rain tap",
    );
    expect(inputWords({ ...inputs, rainingHere: true }, { from: "A", to: "B" })).toBe("Your trip: A → B · raining here");
    expect(inputWords(inputs, { from: null, to: null })).toBe("Your trip · no rain tap");
    expect(inputWords(inputs, { from: "A", to: null })).toBe("Your trip · no rain tap");
    expect(inputWords(inputs)).toBe("Your trip · no rain tap");
  });

  it("a demo's summary is unchanged by the own trip's labels (#56)", () => {
    expect(inputWords(initialCommuteState.inputs, { from: "A", to: "B" })).toBe("Demo: Banilad → IT Park · No reports · no rain tap");
  });
});
