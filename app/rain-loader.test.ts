import { describe, expect, it } from "vitest";
import { RAIN_CREDIT } from "../lib/rain";
import { createRainLoader, type RainState } from "./rain-loader";

const A = { south: 14.5, west: 120.9, north: 14.7, east: 121.1 };
const B = { south: 10.2, west: 123.8, north: 10.4, east: 124.0 };

function okReply(lat: number, lon: number, mm: number) {
  return { status: "ok", points: [{ lat, lon, mm }, { lat: lat + 0.1, lon, mm }], modelTime: "2026-11-03T15:00", credit: RAIN_CREDIT };
}

/** Each fetch waits until the test answers it, so replies can arrive in any order. */
function harness() {
  const pending: Array<{ url: string; signal: AbortSignal; answer: (body: unknown) => void }> = [];
  let state: RainState = { layer: null, loading: false };
  const loader = createRainLoader({
    fetch: ((url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push({ url, signal: init!.signal!, answer: (body) => resolve(Response.json(body)) });
      })) as unknown as typeof fetch,
    onState: (next) => {
      state = next(state);
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { loader, pending, state: () => state, flush };
}

describe("the rain loader", () => {
  it("cancels a slow request for B when the view comes back to A, so B's late reply never replaces A", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.pending[0].answer(okReply(14.6, 121, 5));
    await h.flush();
    const shownForA = h.state().layer;
    expect(shownForA?.circles.length).toBeGreaterThan(0);

    h.loader.setView(B);
    h.loader.load();
    expect(h.pending).toHaveLength(2);
    expect(h.state().loading).toBe(true);

    h.loader.setView(A);
    h.loader.load();
    expect(h.pending).toHaveLength(2); // A is still covered: nothing new goes out
    expect(h.pending[1].signal.aborted).toBe(true);
    expect(h.state().loading).toBe(false);

    h.pending[1].answer(okReply(10.3, 123.9, 40));
    await h.flush();
    expect(h.state().layer).toBe(shownForA);

    // And B was never recorded as fetched: going back to B asks again.
    h.loader.setView(B);
    h.loader.load();
    expect(h.pending).toHaveLength(3);
  });

  it("shows only the newest request's reply when two overlap", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.loader.setView(B);
    h.loader.load();
    expect(h.pending[0].signal.aborted).toBe(true);
    h.pending[1].answer(okReply(10.3, 123.9, 40));
    h.pending[0].answer(okReply(14.6, 121, 5));
    await h.flush();
    expect(h.state().layer?.circles.every((c) => c.lat < 11)).toBe(true);
  });

  it("reads a broken reply as the layer being down and asks again on the next move", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.pending[0].answer("<html>");
    await h.flush();
    expect(h.state().layer?.legend.notice).toBe("Rain layer unavailable");
    h.loader.load();
    expect(h.pending).toHaveLength(2);
  });

  it("drops what a stopped loader's request returns", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.loader.stop();
    h.pending[0].answer(okReply(14.6, 121, 5));
    await h.flush();
    expect(h.state().layer).toBeNull();
  });

  it("cancels B the moment the view is back at A, before the debounce runs load (round 2)", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.pending[0].answer(okReply(14.6, 121, 5));
    await h.flush();
    const shownForA = h.state().layer;
    h.loader.setView(B);
    h.loader.load();
    h.loader.setView(A); // no load(): the debounce hasn't fired yet
    expect(h.pending[1].signal.aborted).toBe(true);
    expect(h.state().loading).toBe(false);
    h.pending[1].answer(okReply(10.3, 123.9, 40));
    await h.flush();
    expect(h.state().layer).toBe(shownForA);
    h.loader.load();
    expect(h.pending).toHaveLength(2); // A is covered: nothing is asked again
  });

  it("settles a reply whose model time isn't a date, with loading cleared", async () => {
    const h = harness();
    h.loader.setView(A);
    h.loader.load();
    h.pending[0].answer({ ...okReply(14.6, 121, 5), modelTime: "invalid-date" });
    await h.flush();
    expect(h.state().loading).toBe(false);
    expect(h.state().layer?.circles.length).toBeGreaterThan(0);
  });
});
