import { describe, expect, it } from "vitest";
import { tripMapProps } from "./map-props";

const HOME = { lat: 10.2551, lon: 123.8001 };
const WORK = { lat: 10.2612, lon: 123.8405 };
const DEMO = { from: { lat: 10.346, lon: 123.911 }, to: { lat: 10.3307, lon: 123.9058 } };
const ROUTE = [HOME, { lat: 10.258, lon: 123.82 }, WORK];
const DETOUR = [HOME, { lat: 10.262, lon: 123.81 }, WORK];
const FAR_PIN = {
  id: "r1",
  at: { lat: 10.4, lon: 124.0 },
  sample: false,
  place: "Somewhere else",
  age: "10 min ago",
  depth: null,
  passability: null,
  counts: true,
  role: "neutral" as const,
};

describe("where the map looks", () => {
  it.each([
    ["a saved trip restored", { demo: null, draft: { step: "set", trip: { home: HOME, work: WORK } } }],
    ["a saved trip restored, with the rider's flag left unset", { demo: null, draft: { step: "set", trip: { home: HOME, work: WORK } }, riderMoved: false }],
    ["no trip yet, even after a pick that was refused", { demo: null, draft: { step: "home" }, riderMoved: true }],
  ] as const)("before an answer (%s) your own trip stays on the fixed view of the Philippines: tiles never reveal the trip's area", (_why, input) => {
    const props = tripMapProps({ ...input, result: null });
    expect(props.frame).toBeNull();
  });

  it("a demo trip frames its own ends before an answer", () => {
    expect(tripMapProps({ demo: DEMO, draft: { step: "home" }, result: null }).frame).toEqual([DEMO.from, DEMO.to]);
  });

  it("after the rider's own pick or tap, the map frames the rider's ends", () => {
    expect(tripMapProps({ demo: null, draft: { step: "work", home: HOME }, riderMoved: true, result: null }).frame).toEqual([HOME]);
    expect(tripMapProps({ demo: null, draft: { step: "set", trip: { home: HOME, work: WORK } }, riderMoved: true, result: null }).frame).toEqual([HOME, WORK]);
  });

  it("the saved trip's ends are still drawn, without moving the view", () => {
    const props = tripMapProps({ demo: null, draft: { step: "set", trip: { home: HOME, work: WORK } }, result: null });
    expect(props.ends.map((e) => e.at)).toEqual([HOME, WORK]);
  });

  it("after the check it fits the routes only, not report pins", () => {
    const props = tripMapProps({
      demo: null,
      draft: { step: "set", trip: { home: HOME, work: WORK } },
      result: { route: { line: ROUTE }, detour: { line: DETOUR }, reports: [FAR_PIN] },
    });
    expect(props.frame).toEqual([...ROUTE, ...DETOUR]);
    expect(props.pins).toEqual([FAR_PIN]);
  });
});
