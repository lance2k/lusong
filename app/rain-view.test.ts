import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAIN_CREDIT } from "../lib/rain";
import { containsBox, debounce, needsRainFetch, rainFetchPlan, rainReplyOf, rainUrl, RAIN_DEBOUNCE_MS, requestBox } from "./rain-view";

const VIEW = { south: 14.5, west: 120.9, north: 14.7, east: 121.1 };

describe("the box a view asks for", () => {
  it("reaches a quarter of the view past each side, rounded outward to 0.01", () => {
    expect(requestBox(VIEW)).toEqual({ south: 14.45, west: 120.85, north: 14.75, east: 121.15 });
  });

  it("always contains the view", () => {
    for (const v of [{ south: 14.123456, west: 120.654321, north: 14.298765, east: 120.876543 }, { south: 5.001, west: 117.001, north: 7.2, east: 119.1 }]) {
      expect(containsBox(requestBox(v), v)).toBe(true);
    }
  });

  it("gives no margin when the margin would pass the server's 3 degree limit", () => {
    const wide = { south: 12, west: 120, north: 14.5, east: 122.5 }; // 2.5 degrees: 25% each side would make 3.75
    expect(requestBox(wide)).toEqual(wide);
  });

  it("sends a view wider than 3 degrees as it is, for the server to refuse", () => {
    const huge = { south: 5, west: 117, north: 9, east: 125 };
    expect(requestBox(huge)).toEqual(huge);
  });

  it("builds the route's url in south,west,north,east order", () => {
    expect(rainUrl(requestBox(VIEW))).toBe("/api/rain?bbox=14.45,120.85,14.75,121.15");
  });
});

describe("when a request is needed", () => {
  const fetched = requestBox(VIEW);

  it("never before a first fetch has been covered", () => {
    expect(needsRainFetch(VIEW, null)).toBe(true);
  });

  it("not for a pan or zoom that stays inside the box last fetched", () => {
    expect(needsRainFetch({ south: 14.47, west: 120.88, north: 14.72, east: 121.12 }, fetched)).toBe(false);
    expect(needsRainFetch({ south: 14.55, west: 120.95, north: 14.65, east: 121.05 }, fetched)).toBe(false);
  });

  it("for a view that leaves it, on any one side", () => {
    expect(needsRainFetch({ ...VIEW, east: 121.2 }, fetched)).toBe(true);
    expect(needsRainFetch({ ...VIEW, south: 14.4 }, fetched)).toBe(true);
    expect(needsRainFetch({ south: 14.5, west: 120.0, north: 14.7, east: 120.3 }, fetched)).toBe(true);
  });

  it("a plan names the box to request, or null", () => {
    expect(rainFetchPlan({ enabled: true, view: VIEW, fetched: null })).toEqual(requestBox(VIEW));
    expect(rainFetchPlan({ enabled: true, view: VIEW, fetched })).toBeNull();
    expect(rainFetchPlan({ enabled: true, view: null, fetched: null })).toBeNull();
  });

  it("rain off: no request whatever the view, which is the default", () => {
    expect(rainFetchPlan({ enabled: false, view: VIEW, fetched: null })).toBeNull();
    expect(rainFetchPlan({ enabled: false, view: { south: 5, west: 117, north: 9, east: 125 }, fetched: null })).toBeNull();
  });
});

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits 800 ms after the last move, however many came before", () => {
    const fn = vi.fn();
    const d = debounce(fn, RAIN_DEBOUNCE_MS);
    d.call();
    vi.advanceTimersByTime(700);
    d.call();
    vi.advanceTimersByTime(700);
    d.call();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(799);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs again for a later move, and cancel drops a pending run", () => {
    const fn = vi.fn();
    const d = debounce(fn, RAIN_DEBOUNCE_MS);
    d.call();
    vi.advanceTimersByTime(RAIN_DEBOUNCE_MS);
    d.call();
    vi.advanceTimersByTime(RAIN_DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(2);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is 800 ms", () => {
    expect(RAIN_DEBOUNCE_MS).toBe(800);
  });
});

describe("reading the server's reply", () => {
  it("keeps a well-formed reply, dropping a damaged point", () => {
    const r = rainReplyOf({ status: "ok", points: [{ lat: 14.5, lon: 121, mm: 0.2 }, { lat: 14.6, lon: 121, mm: "x" }], modelTime: "2026-11-03T15:00:00.000Z", credit: RAIN_CREDIT });
    expect(r.points).toEqual([{ lat: 14.5, lon: 121, mm: 0.2 }]);
    expect(r.status).toBe("ok");
  });

  it("reads anything else as the layer being down", () => {
    for (const body of [null, "x", {}, { status: "weird", points: [] }, { status: "ok" }]) {
      expect(rainReplyOf(body)).toEqual({ status: "down", points: [], modelTime: null, credit: RAIN_CREDIT });
    }
  });
});
