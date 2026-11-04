import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_PLACES,
  builtInMatches,
  makePhotonGate,
  MemoryWaitQueue,
  UpstashWaitQueue,
  PHOTON_QUEUE_KEY,
  photonUrl,
  PlaceCache,
  placeQuery,
  placesFromPhoton,
  roundBias,
  PHOTON_TIMEOUT_MS,
  PHOTON_WAIT_MS,
  searchPlaces,
  withoutParts,
  type PhotonGate,
} from "./places";
import { MemorySlotStore } from "./router";
import { inBound, TRIP_BOUND, type Bound } from "./trip-bound";

const IT_PARK_REPLY = JSON.parse(readFileSync("test/fixtures/photon/it-park-cebu.json", "utf8"));
/** Photon's replies for two S9-walk names, saved 2026-11-04 with the request photonUrl sends (limit 8, the Philippines). */
const SM_BAGUIO_REPLY = JSON.parse(readFileSync("test/fixtures/photon/sm-city-baguio.json", "utf8"));
const BURNHAM_REPLY = JSON.parse(readFileSync("test/fixtures/photon/burnham-park-baguio.json", "utf8"));
const PHILIPPINES: Bound = { id: "ph-test", south: 4.5, north: 21.2, west: 116.9, east: 126.7 };
/** The Metro Cebu box the trip bound was before S1: these tests check that a bound narrower than the country holds. */
const CEBU: Bound = { id: "metro-cebu", south: 10.2, north: 10.47, west: 123.74, east: 124.07 };
const OPEN: PhotonGate = { acquire: async () => "ok" };

describe("the query", () => {
  it("is trimmed and collapsed, and sent only at 3 to 80 characters", () => {
    expect(placeQuery("  it   park ")).toBe("it park");
    expect(placeQuery("it")).toBeNull();
    expect(placeQuery("a".repeat(80))).toBe("a".repeat(80));
    expect(placeQuery("a".repeat(81))).toBeNull();
    expect(placeQuery(42)).toBeNull();
    expect(placeQuery("ab\u0000\u0007c")).toBe("ab c");
  });
});

describe("built-in places", () => {
  it("there are about 30, spread over Luzon, the Visayas and Mindanao", () => {
    expect(BUILT_IN_PLACES.length).toBeGreaterThanOrEqual(30);
    expect(BUILT_IN_PLACES.some((p) => p.lat > 14)).toBe(true);
    expect(BUILT_IN_PLACES.some((p) => p.lat < 8.6)).toBe(true);
    expect(BUILT_IN_PLACES.every((p) => inBound(PHILIPPINES, p))).toBe(true);
  });

  it("the trip bound is the Philippines", () => {
    expect(TRIP_BOUND).toEqual({ ...PHILIPPINES, id: "philippines" });
  });

  it("only those inside the active trip bound are offered", () => {
    expect(builtInMatches("city hall", CEBU).map((p) => p.id)).toEqual([
      "built-in:lapu-lapu-city-hall",
      "built-in:talisay-city-hall",
    ]);
    expect(builtInMatches("davao", CEBU)).toEqual([]);
    expect(builtInMatches("davao", PHILIPPINES).map((p) => p.id)).toEqual(["built-in:davao-city-hall"]);
  });

  it("matches word starts, ignoring case and accents", () => {
    expect(builtInMatches("fuente osme", CEBU).map((p) => p.id)).toEqual(["built-in:fuente-osmena"]);
    expect(builtInMatches("IT PAR", CEBU).map((p) => p.id)).toEqual(["built-in:cebu-it-park"]);
    expect(builtInMatches("ark", CEBU)).toEqual([]);
  });
});

describe("Photon's reply", () => {
  it("keeps points in the Philippines inside the bound, one per name and area", () => {
    const places = placesFromPhoton(IT_PARK_REPLY, CEBU);
    expect(places.map((p) => p.name)).toEqual([
      "IT Park BRT Stop",
      "Cebu IT Park Transport Terminal",
      "HVG I.T. Park",
      "Cebu I.T. Park",
      "Bigfoot I.T. and Media Park",
      "Cebu IT Tower",
      "AAS IT Services",
    ]);
    expect(places.every((p) => p.source === "osm" && inBound(CEBU, p))).toBe(true);
    expect(places[0]).toMatchObject({ id: "osm:N13754365857", area: expect.stringContaining("Cebu City") });
  });

  it("drops features outside the bound, outside the country, or with no name or point", () => {
    const body = {
      features: [
        { geometry: { type: "Point", coordinates: [121.0, 14.6] }, properties: { countrycode: "PH", name: "Manila spot" } },
        { geometry: { type: "Point", coordinates: [123.9, 10.3] }, properties: { countrycode: "MY", name: "Wrong country" } },
        { geometry: { type: "Point", coordinates: [123.9, 10.3] }, properties: { countrycode: "PH" } },
        { geometry: { type: "LineString", coordinates: [123.9, 10.3] }, properties: { countrycode: "PH", name: "Line" } },
        { geometry: { type: "Point", coordinates: ["x", 10.3] }, properties: { countrycode: "PH", name: "Bad" } },
        { geometry: { type: "Point", coordinates: [123.9, 10.3] }, properties: { countrycode: "PH", street: "Gorordo Avenue", housenumber: "12" } },
      ],
    };
    expect(placesFromPhoton(body, CEBU).map((p) => p.name)).toEqual(["12 Gorordo Avenue"]);
    expect(placesFromPhoton({ nope: true }, CEBU)).toEqual([]);
    expect(placesFromPhoton(null, CEBU)).toEqual([]);
  });
});

describe("the request to Photon", () => {
  it("is limited to the bound and biased to the phone, rounded to a tenth of a degree", () => {
    const bias = roundBias("10.3456", "123.9123", CEBU);
    expect(bias).toEqual({ lat: 10.3, lon: 123.9 });
    const url = new URL(photonUrl("it park", CEBU, bias));
    expect(url.host).toBe("photon.komoot.io");
    expect(url.searchParams.get("bbox")).toBe("123.74,10.2,124.07,10.47");
    expect(url.searchParams.get("lat")).toBe("10.3");
    expect(url.searchParams.get("lon")).toBe("123.9");
    expect(new URL(photonUrl("x y z", CEBU, null)).searchParams.has("lat")).toBe(false);
  });

  it("drops a bias outside the bound or not a number", () => {
    expect(roundBias("14.6", "121.0", CEBU)).toBeNull();
    expect(roundBias("abc", "121.0", CEBU)).toBeNull();
    expect(roundBias(null, null, CEBU)).toBeNull();
  });
});

describe("the shared Photon queue", () => {
  it("lets one caller a second through across instances", async () => {
    const slots = new MemorySlotStore();
    const queue = new MemoryWaitQueue();
    const a = makePhotonGate(slots, queue, { waitMs: 3_000, pollMs: 50 });
    const b = makePhotonGate(slots, queue, { waitMs: 3_000, pollMs: 50 });
    const t0 = performance.now();
    expect(await a.acquire()).toBe("ok");
    expect(await b.acquire()).toBe("ok");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it("answers busy at once when 20 callers already wait", async () => {
    const queue = new MemoryWaitQueue();
    const now = Date.now();
    for (let i = 0; i < 20; i++) await queue.join(PHOTON_QUEUE_KEY, `w${i}`, now, now + 60_000);
    const claim = vi.fn(async () => true);
    expect(await makePhotonGate({ claim }, queue).acquire()).toBe("busy");
    expect(claim).not.toHaveBeenCalled();
    expect(await queue.join(PHOTON_QUEUE_KEY, "probe", Date.now(), Date.now() + 1)).toBe(21);
  });

  it("an abandoned waiter's place frees at its own expiry, however much traffic keeps arriving", async () => {
    const queue = new MemoryWaitQueue();
    const t = Date.now();
    for (let i = 0; i < 20; i++) await queue.join(PHOTON_QUEUE_KEY, `dead${i}`, t, t + 200);
    const slots = new MemorySlotStore();
    const gate = makePhotonGate(slots, queue, { waitMs: 100, pollMs: 20 });
    expect(await gate.acquire()).toBe("busy");
    await new Promise((r) => setTimeout(r, 120));
    expect(await gate.acquire()).toBe("busy");
    await new Promise((r) => setTimeout(r, 100));
    expect(await gate.acquire()).toBe("ok");
  });

  it("a waiter that is let through or gives up leaves the queue", async () => {
    const queue = new MemoryWaitQueue();
    const slots = new MemorySlotStore();
    expect(await makePhotonGate(slots, queue, { waitMs: 300, pollMs: 50 }).acquire()).toBe("ok");
    expect(await makePhotonGate(slots, queue, { waitMs: 300, pollMs: 50 }).acquire()).toBe("busy");
    await new Promise((r) => setTimeout(r, 0));
    expect(await queue.join(PHOTON_QUEUE_KEY, "probe", Date.now(), Date.now() + 1)).toBe(1);
  });

  it("answers within its wait when joining the queue stalls", async () => {
    const stalled = { join: () => new Promise<number>(() => {}), leave: async () => {} };
    const t0 = performance.now();
    expect(await makePhotonGate(new MemorySlotStore(), stalled, { waitMs: 300 }).acquire()).toBe("busy");
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("answers within its wait when the slot store stalls, and never uses a late grant", async () => {
    const stalled = { claim: () => new Promise<boolean>(() => {}) };
    const t0 = performance.now();
    expect(await makePhotonGate(stalled, new MemoryWaitQueue(), { waitMs: 300, pollMs: 50 }).acquire()).toBe("busy");
    expect(performance.now() - t0).toBeLessThan(500);
    const late = { claim: () => new Promise<boolean>((r) => setTimeout(() => r(true), 400)) };
    expect(await makePhotonGate(late, new MemoryWaitQueue(), { waitMs: 300, pollMs: 50 }).acquire()).toBe("busy");
  });

  it("is unavailable without its stores, or when they fail", async () => {
    expect(await makePhotonGate(null, new MemoryWaitQueue()).acquire()).toBe("unavailable");
    const broken = { join: async () => Promise.reject(new Error("down")), leave: async () => {} };
    expect(await makePhotonGate(new MemorySlotStore(), broken).acquire()).toBe("unavailable");
    const brokenSlots = { claim: async () => Promise.reject(new Error("down")) };
    expect(await makePhotonGate(brokenSlots, new MemoryWaitQueue()).acquire()).toBe("unavailable");
  });
});

describe("the cache", () => {
  it("expires entries and keeps at most its size, dropping the oldest", () => {
    let now = 0;
    const cache = new PlaceCache(2, 1_000, () => now);
    cache.set("a", []);
    cache.set("b", []);
    cache.set("c", []);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toEqual([]);
    now = 1_000;
    expect(cache.get("b")).toBeNull();
  });
});

describe("searching", () => {
  const ok = () => new Response(JSON.stringify(IT_PARK_REPLY), { status: 200 });

  it("puts the built-in match first, then Photon's places, at most 8", async () => {
    const fetchMock = vi.fn(async () => ok());
    const reply = await searchPlaces("IT Park", null, { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: CEBU });
    expect(reply.status).toBe("ok");
    expect(reply.places[0].id).toBe("built-in:cebu-it-park");
    expect(reply.places.length).toBeLessThanOrEqual(8);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("asks Photon once for the same query and rounded place", async () => {
    const fetchMock = vi.fn(async () => ok());
    const deps = { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: CEBU };
    await searchPlaces("IT Park", { lat: 10.3, lon: 123.9 }, deps);
    await searchPlaces("it  park", { lat: 10.3, lon: 123.9 }, deps);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends nothing for a short query", async () => {
    const fetchMock = vi.fn(async () => ok());
    expect(await searchPlaces("it", null, { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: CEBU })).toEqual({
      status: "short",
      places: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says busy or down and offers the built-in places when Photon can't be asked or fails", async () => {
    const cache = new PlaceCache();
    const never = vi.fn(async () => ok());
    const busy = await searchPlaces("talisay", null, { fetch: never, gate: { acquire: async () => "busy" }, cache, bound: CEBU });
    expect(busy).toEqual({ status: "busy", places: [expect.objectContaining({ id: "built-in:talisay-city-hall" })] });
    expect(never).not.toHaveBeenCalled();
    const down = await searchPlaces("talisay", null, { fetch: never, gate: { acquire: async () => "unavailable" }, cache, bound: CEBU });
    expect(down.status).toBe("down");
    const throttled = await searchPlaces("talisay", null, {
      fetch: async () => new Response("slow down", { status: 429 }),
      gate: OPEN,
      cache,
      bound: CEBU,
    });
    expect(throttled.status).toBe("busy");
    const broken = await searchPlaces("talisay", null, {
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
      gate: OPEN,
      cache,
      bound: CEBU,
    });
    expect(broken).toEqual({ status: "down", places: [expect.objectContaining({ id: "built-in:talisay-city-hall" })] });
    expect(cache.size).toBe(0);
  });
});

describe("a slow Photon (#42)", () => {
  /** Photon answering after `ms`, or failing as fetch does when the request's signal aborts first. */
  const photonAfter = (ms: number) =>
    vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify(IT_PARK_REPLY), { status: 200 })), ms);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "TimeoutError"));
          });
        }),
    );

  it("an answer after 4.5 s is used, not shown as place search down", async () => {
    const reply = await searchPlaces("IT Park", null, { fetch: photonAfter(4_500), gate: OPEN, cache: new PlaceCache(), bound: CEBU });
    expect(reply.status).toBe("ok");
    expect(reply.places.some((p) => p.source === "osm")).toBe(true);
  }, 10_000);

  it("Photon gets 6 s, and the queue's wait plus that stays well inside the route's 15 s", () => {
    expect(PHOTON_TIMEOUT_MS).toBe(6_000);
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/places/route.ts", "utf8"))![1]);
    expect(PHOTON_WAIT_MS + PHOTON_TIMEOUT_MS).toBeLessThanOrEqual(maxDuration * 1_000 - 5_000);
  });
});

describe("parts of one place (#57)", () => {
  const names = (places: { name: string }[]) => places.map((p) => p.name);

  it("SM City Baguio is offered once, without its balcony, deliveries, terminals and taxi bay", async () => {
    const reply = await searchPlaces("SM City Baguio", null, {
      fetch: async () => Response.json(SM_BAGUIO_REPLY),
      gate: OPEN,
      cache: new PlaceCache(),
      bound: PHILIPPINES,
    });
    expect(reply.status).toBe("ok");
    expect(names(reply.places)).toEqual(["SM City Baguio"]);
  });

  it("Burnham Park is offered without its lake, fields and rink; places nearby with names of their own stay", async () => {
    const reply = await searchPlaces("Burnham Park Baguio", null, {
      fetch: async () => Response.json(BURNHAM_REPLY),
      gate: OPEN,
      cache: new PlaceCache(),
      bound: PHILIPPINES,
    });
    expect(names(reply.places)).toEqual(["Burnham Park", "Ganza Restaurant", "Solibao Restaurant", "Pine Trees of the World Park"]);
  });

  it("a part the rider types for is kept: 'Burnham Park Lake', 'SM City Baguio sky t'", () => {
    const burnham = placesFromPhoton(BURNHAM_REPLY, PHILIPPINES);
    expect(names(withoutParts(burnham, "Burnham Park Lake"))).toContain("Burnham Park Lake");
    expect(names(withoutParts(burnham, "Burnham Park Lake"))).not.toContain("Burnham Park Skating Rink");
    const sm = placesFromPhoton(SM_BAGUIO_REPLY, PHILIPPINES);
    expect(names(withoutParts(sm, "SM City Baguio sky t"))).toEqual(["SM City Baguio", "SM City Baguio Sky Terrace"]);
  });

  it("a place whose name only starts with another's is kept when it is more than 1 km away", () => {
    const mk = (name: string, lat: number, lon: number) => ({ id: name, name, area: "", lat, lon, source: "osm" as const });
    const hall = mk("City Hall", 16.4137, 120.5915);
    const near = mk("City Hall Annex", 16.4139, 120.5917);
    const far = mk("City Hall Annex", 16.43, 120.5915);
    expect(names(withoutParts([hall, near], "City Hall"))).toEqual(["City Hall"]);
    expect(names(withoutParts([hall, far], "City Hall"))).toEqual(["City Hall", "City Hall Annex"]);
    expect(names(withoutParts([mk("City Hallway", 16.4137, 120.5915), hall], "City Hall"))).toEqual(["City Hallway", "City Hall"]);
  });

  it("a Photon part of a built-in place is folded into the built-in", async () => {
    const reply = await searchPlaces("Baguio City Hall", null, {
      fetch: async () =>
        Response.json({
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: [120.5916, 16.4139] }, properties: { name: "Baguio City Hall Parking", countrycode: "PH", city: "Baguio", osm_type: "N", osm_id: 1 } },
            { type: "Feature", geometry: { type: "Point", coordinates: [120.6, 16.41] }, properties: { name: "Baguio Cathedral", countrycode: "PH", city: "Baguio", osm_type: "N", osm_id: 2 } },
          ],
        }),
      gate: OPEN,
      cache: new PlaceCache(),
      bound: PHILIPPINES,
    });
    expect(names(reply.places)).toEqual(["Baguio City Hall", "Baguio Cathedral"]);
  });
});

describe.skipIf(!process.env.LUSONG_TEST_UPSTASH_URL)("the wait queue on Upstash", () => {
  it("counts live waiters, drops expired ones, and lets one leave", async () => {
    const q = new UpstashWaitQueue(process.env.LUSONG_TEST_UPSTASH_URL!, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "");
    const key = `lusong-test:${crypto.randomUUID()}:waiters`;
    const now = Date.now();
    expect(await q.join(key, "a", now, now + 100)).toBe(1);
    expect(await q.join(key, "b", now, now + 60_000)).toBe(2);
    expect(await q.join(key, "c", now + 200, now + 60_000)).toBe(2);
    await q.leave(key, "b");
    expect(await q.join(key, "d", now + 200, now + 60_000)).toBe(2);
  });
});
