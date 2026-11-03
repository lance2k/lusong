import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CountStore } from "./address-limit";
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  CALLS_PER_HOUR,
  MAX_POINTS,
  RAIN_CREDIT,
  RAIN_USER_AGENT,
  createRain,
  openMeteoUrl,
  parseBbox,
  parseOpenMeteo,
  snapBbox,
} from "./rain";

const LIVE_3X3: unknown[] = JSON.parse(readFileSync("test/fixtures/open-meteo/grid-3x3-metro-manila.json", "utf8"));
const METRO_MANILA = "14.5,120.9,14.7,121.1";
const T0 = Date.UTC(2026, 10, 3, 15, 0, 0);

function cellsOf(bbox: string) {
  const box = parseBbox(bbox);
  if (!box) throw new Error("bad bbox");
  const s = snapBbox(box);
  if (!s.ok) throw new Error("refused");
  return s.cells;
}

/** An Open-Meteo reply shaped like the live one: an array for several points, an object for one. */
function replyFor(n: number, mm = 0, time = "2026-11-03T15:00") {
  const one = (i: number) => ({ latitude: 14 + i, longitude: 121, current: { time, interval: 900, precipitation: mm, rain: mm } });
  return n === 1 ? one(0) : Array.from({ length: n }, (_, i) => one(i));
}

function fakeFetch(mm = 0) {
  return vi.fn(async (url: string | URL | Request) => {
    const n = new URL(String(url)).searchParams.get("latitude")!.split(",").length;
    return Response.json(replyFor(n, mm));
  });
}

/** The i-th of many boxes that share no lattice point: 4 points each, or 25 when `wide`. */
function box(i: number, wide = false): string {
  const [rowSize, step, size] = wide ? [10, 0.5, 0.4] : [40, 0.2, 0.01];
  const lat = 5 + Math.floor(i / rowSize) * 0.5;
  const lon = 117 + (i % rowSize) * step;
  return [lat, lon, lat + size, lon + size].map((v) => v.toFixed(2)).join(",");
}

/** A count shared like the database's: two services given the same one share the hour's cap. */
function sharedCounts() {
  const counts = new Map<string, number>();
  const store: CountStore = {
    async take(key, limit) {
      const n = counts.get(key) ?? 0;
      if (n + 1 > limit) return false;
      counts.set(key, n + 1);
      return true;
    },
  };
  return { store, total: () => [...counts.values()].reduce((a, b) => a + b, 0) };
}

function service(f: ReturnType<typeof fakeFetch>, clock = { t: T0 }, counts = sharedCounts()) {
  return { clock, counts, rain: createRain({ fetch: f as unknown as typeof fetch, now: () => clock.t, calls: counts.store }) };
}

describe("bbox parsing", () => {
  it("reads south,west,north,east and refuses the rest", () => {
    expect(parseBbox("14.5,120.9,14.7,121.1")).toEqual({ south: 14.5, west: 120.9, north: 14.7, east: 121.1 });
    for (const bad of [null, "", "1,2,3", "a,b,c,d", "14.7,120.9,14.5,121.1", "14.5,121.1,14.7,120.9", "1,2,3,", "-91,0,0,1"]) {
      expect(parseBbox(bad), String(bad)).toBeNull();
    }
  });
});

describe("grid snapping", () => {
  it("puts the points of a small box on the 0.1 degree lattice", () => {
    const cells = cellsOf(METRO_MANILA);
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => [c.latTenths / 10, c.lonTenths / 10])).toContainEqual([14.6, 121]);
    expect(openMeteoUrl(cells)).toContain("latitude=14.5,14.5,14.5,14.6,14.6,14.6,14.7,14.7,14.7");
    expect(openMeteoUrl(cells)).toContain("longitude=120.9,121.0,121.1,120.9,121.0,121.1,120.9,121.0,121.1");
  });

  it("widens an off-lattice box outward so every corner is covered", () => {
    const cells = cellsOf("14.52,120.93,14.58,120.97");
    expect(new Set(cells.map((c) => c.latTenths))).toEqual(new Set([145, 146]));
    expect(new Set(cells.map((c) => c.lonTenths))).toEqual(new Set([1209, 1210]));
  });

  it("gives a box smaller than the lattice at least one point", () => {
    expect(cellsOf("14.601,121.001,14.602,121.002").length).toBeGreaterThanOrEqual(1);
  });

  it("caps a large box at 25 points, thinned evenly with both edges kept", () => {
    const cells = cellsOf("12,120,14.9,122.9");
    expect(cells).toHaveLength(MAX_POINTS);
    const lats = [...new Set(cells.map((c) => c.latTenths))];
    const lons = [...new Set(cells.map((c) => c.lonTenths))];
    expect(lats).toHaveLength(5);
    expect(lons).toHaveLength(5);
    expect([lats[0], lats[4]]).toEqual([120, 149]);
    expect([lons[0], lons[4]]).toEqual([1200, 1229]);
    const gaps = lats.slice(1).map((v, i) => v - lats[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("keeps exactly 25 points for a 5x5 box and does not thin a 4x4", () => {
    expect(cellsOf("14.5,120.9,14.9,121.3")).toHaveLength(25);
    expect(cellsOf("14.5,120.9,14.8,121.2")).toHaveLength(16);
  });

  it("refuses a box wider or taller than 3 degrees, and accepts exactly 3", () => {
    expect(snapBbox(parseBbox("12,120,12.5,123.01")!).ok).toBe(false);
    expect(snapBbox(parseBbox("12,120,15.01,120.5")!).ok).toBe(false);
    expect(snapBbox(parseBbox("12,120,15,123")!).ok).toBe(true);
  });

  it("refuses a box outside the Philippines box", () => {
    expect(snapBbox(parseBbox("35.5,139.5,35.9,139.9")!).ok).toBe(false); // Tokyo
    expect(snapBbox(parseBbox("1.2,103.6,1.5,104")!).ok).toBe(false); // Singapore
    expect(snapBbox(parseBbox("14.5,100,14.7,100.2")!).ok).toBe(false); // due west of Manila, in Thailand
  });

  it("clips a box that straddles the Philippines box edge, never asking for points outside it", () => {
    const s = snapBbox(parseBbox("4,126.5,5,127.5")!);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(Math.min(...s.cells.map((c) => c.latTenths))).toBeGreaterThanOrEqual(45);
    expect(Math.max(...s.cells.map((c) => c.lonTenths))).toBeLessThanOrEqual(1267);
  });
});

describe("parsing Open-Meteo's reply", () => {
  it("reads the saved live reply: nine points in request order with their model time", () => {
    const parsed = parseOpenMeteo(LIVE_3X3, 9)!;
    expect(parsed).toHaveLength(9);
    expect(parsed.map((p) => p.mm)).toEqual(LIVE_3X3.map((p) => (p as { current: { precipitation: number } }).current.precipitation));
    expect(parsed[0].time).toBe("2026-11-03T15:00:00.000Z");
  });

  it("reads a single point, which Open-Meteo sends as an object", () => {
    const parsed = parseOpenMeteo(LIVE_3X3[1], 1)!;
    expect(parsed).toEqual([{ mm: 0.1, time: "2026-11-03T15:00:00.000Z" }]);
  });

  it("refuses a reply with the wrong count or a damaged point", () => {
    expect(parseOpenMeteo(LIVE_3X3, 4)).toBeNull();
    expect(parseOpenMeteo(LIVE_3X3[0], 2)).toBeNull();
    expect(parseOpenMeteo({ error: true, reason: "Limit exceeded" }, 1)).toBeNull();
    expect(parseOpenMeteo([{ current: { time: "2026-11-03T15:00", precipitation: null } }], 1)).toBeNull();
    expect(parseOpenMeteo([{ current: { time: "2026-11-03T15:00", precipitation: -1 } }], 1)).toBeNull();
    expect(parseOpenMeteo(null, 1)).toBeNull();
  });
});

describe("the rain service", () => {
  it("asks Open-Meteo once for all missing points, with the User-Agent and the precipitation fields", async () => {
    const f = vi.fn(async () => Response.json(LIVE_3X3));
    const { rain } = service(f as unknown as ReturnType<typeof fakeFetch>);
    const reply = await rain.rain(METRO_MANILA);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(u.searchParams.get("current")).toBe("precipitation,rain");
    expect(u.searchParams.get("latitude")!.split(",")).toHaveLength(9);
    expect(u.searchParams.get("longitude")!.split(",")).toHaveLength(9);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(RAIN_USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(reply.status).toBe("ok");
    expect(reply.credit).toBe(RAIN_CREDIT);
    expect(reply.modelTime).toBe("2026-11-03T15:00:00.000Z");
    expect(reply.points).toHaveLength(9);
    expect(reply.points[0]).toEqual({ lat: 14.5, lon: 120.9, mm: 0 });
    expect(reply.points[1]).toEqual({ lat: 14.5, lon: 121, mm: 0.1 });
  });

  it("serves a repeat from the cache with no second call, and asks only for the points it lacks", async () => {
    const f = fakeFetch(1);
    const { rain } = service(f);
    await rain.rain("14.5,120.9,14.6,121.0"); // 4 points
    await rain.rain("14.5,120.9,14.6,121.0");
    expect(f).toHaveBeenCalledTimes(1);
    await rain.rain("14.5,120.9,14.6,121.1"); // 6 points, 4 cached
    expect(f).toHaveBeenCalledTimes(2);
    const u = new URL(String(f.mock.calls[1][0]));
    expect(u.searchParams.get("latitude")!.split(",")).toHaveLength(2);
  });

  it("expires a point after 15 minutes", async () => {
    const f = fakeFetch(1);
    const { rain, clock } = service(f);
    await rain.rain(METRO_MANILA);
    clock.t += CACHE_TTL_MS - 1;
    await rain.rain(METRO_MANILA);
    expect(f).toHaveBeenCalledTimes(1);
    clock.t += 1;
    await rain.rain(METRO_MANILA);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 2,000 points, dropping the oldest first", async () => {
    const f = fakeFetch(0);
    const { rain, clock } = service(f);
    for (let i = 0; i < 90; i++) {
      clock.t += 1;
      await rain.rain(box(i, true));
    }
    expect(rain.stats().cached).toBe(CACHE_MAX_ENTRIES);
    // The first box is gone and is fetched again; the last box is still held.
    const before = f.mock.calls.length;
    await rain.rain(box(0, true));
    expect(f.mock.calls.length).toBe(before + 1);
    const last = f.mock.calls.length;
    await rain.rain(box(89, true));
    expect(f.mock.calls.length).toBe(last);
  });

  it("drops expired points before live ones when the cache is over its size", async () => {
    const f = fakeFetch(0);
    const { rain, clock } = service(f);
    for (let i = 0; i < 79; i++) await rain.rain(box(i, true)); // 1,975 points, all fetched at T0
    clock.t += 5 * 60_000;
    await rain.rain(box(79, true)); // 2,000 points: at the limit, nothing dropped yet
    expect(rain.stats().cached).toBe(CACHE_MAX_ENTRIES);
    clock.t += CACHE_TTL_MS - 5 * 60_000; // the first 1,975 are now 15 minutes old, the last 25 are 10
    await rain.rain(box(80, true)); // 2,025 points: the expired ones go, not merely the oldest 25
    expect(rain.stats().cached).toBe(50);
    const calls = f.mock.calls.length;
    await rain.rain(box(79, true));
    expect(f.mock.calls.length).toBe(calls);
  });

  it("makes at most 300 Open-Meteo calls an hour, then says paused, and recovers as the hour rolls", async () => {
    const f = fakeFetch(0);
    const { rain, clock } = service(f);
    for (let i = 0; i < CALLS_PER_HOUR; i++) {
      clock.t += 1_000;
      const r = await rain.rain(box(i));
      expect(r.status).toBe("ok");
    }
    expect(f).toHaveBeenCalledTimes(CALLS_PER_HOUR);
    const paused = await rain.rain("20,120,20.1,120.1");
    expect(paused).toEqual({ status: "paused", points: [], modelTime: null, credit: RAIN_CREDIT });
    expect(f).toHaveBeenCalledTimes(CALLS_PER_HOUR);
    // A fully cached view needs no call, so it still answers while paused.
    const cached = await rain.rain(box(0));
    expect(cached.status).toBe("ok");
    clock.t += 3_600_000;
    const after = await rain.rain("20,120,20.1,120.1");
    expect(after.status).toBe("ok");
  });

  it("counts a failed call against the hour", async () => {
    const f = vi.fn(async () => new Response("no", { status: 500 }));
    const { rain, counts } = service(f as unknown as ReturnType<typeof fakeFetch>);
    await rain.rain(METRO_MANILA);
    expect(counts.total()).toBe(1);
  });

  it("shares the hour's cap across server processes, and a new process doesn't reset it", async () => {
    const f = fakeFetch(0);
    const clock = { t: T0 };
    const counts = sharedCounts();
    const a = service(f, clock, counts).rain;
    const b = service(f, clock, counts).rain;
    for (let i = 0; i < CALLS_PER_HOUR; i++) {
      clock.t += 1_000;
      expect((await (i % 2 ? a : b).rain(box(i))).status).toBe("ok");
    }
    const fresh = service(f, clock, counts).rain;
    expect((await fresh.rain("20,120,20.1,120.1")).status).toBe("paused");
    expect(f).toHaveBeenCalledTimes(CALLS_PER_HOUR);
  });

  it("makes no call when the shared count is missing or unreachable", async () => {
    const f = fakeFetch();
    const none = createRain({ fetch: f as unknown as typeof fetch, now: () => T0, calls: null });
    expect((await none.rain(METRO_MANILA)).status).toBe("paused");
    const failing: CountStore = {
      take: async () => {
        throw new Error("Upstash HTTP 503");
      },
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = createRain({ fetch: f as unknown as typeof fetch, now: () => T0, calls: failing });
    expect((await broken.rain(METRO_MANILA)).status).toBe("paused");
    expect(err).toHaveBeenCalledWith("rain call count unreachable:", "Upstash HTTP 503");
    err.mockRestore();
    expect(f).not.toHaveBeenCalled();
  });

  it("says down when Open-Meteo errors, times out, or answers nonsense, and caches nothing", async () => {
    const bodies: Array<() => Promise<Response>> = [
      async () => new Response("busy", { status: 429 }),
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      async () => Response.json({ error: true, reason: "x" }),
      async () => new Response("<html>", { status: 200 }),
    ];
    for (const b of bodies) {
      const { rain } = service(vi.fn(b) as unknown as ReturnType<typeof fakeFetch>);
      const r = await rain.rain(METRO_MANILA);
      expect(r).toEqual({ status: "down", points: [], modelTime: null, credit: RAIN_CREDIT });
      expect(rain.stats().cached).toBe(0);
    }
  });

  it("refuses without calling Open-Meteo for a bad, wide or foreign box", async () => {
    const f = fakeFetch();
    const { rain, counts } = service(f);
    for (const bbox of [null, "nope", "12,120,15.5,121", "35.5,139.5,35.9,139.9"]) {
      expect(await rain.rain(bbox)).toEqual({ status: "refused", points: [], modelTime: null, credit: RAIN_CREDIT });
    }
    expect(f).not.toHaveBeenCalled();
    expect(counts.total()).toBe(0);
  });

  it("reports the oldest model time among the points", async () => {
    let n = 0;
    const f = vi.fn(async (url: string | URL | Request) => {
      const count = new URL(String(url)).searchParams.get("latitude")!.split(",").length;
      return Response.json(replyFor(count, 0, n++ === 0 ? "2026-11-03T15:00" : "2026-11-03T15:15"));
    });
    const { rain, clock } = service(f as unknown as ReturnType<typeof fakeFetch>);
    await rain.rain("14.5,120.9,14.51,121.0");
    clock.t += 60_000;
    const r = await rain.rain("14.5,120.9,14.51,121.2");
    expect(r.modelTime).toBe("2026-11-03T15:00:00.000Z");
  });
});
