import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_PLACES,
  builtInMatches,
  makePhotonGate,
  MemoryCounterStore,
  PHOTON_QUEUE_KEY,
  PHOTON_SLOT_KEY,
  photonUrl,
  PlaceCache,
  placeQuery,
  placesFromPhoton,
  roundBias,
  searchPlaces,
  type PhotonGate,
} from "./places";
import { MemorySlotStore } from "./router";
import { inBound, TRIP_BOUND, type Bound } from "./trip-bound";

const IT_PARK_REPLY = JSON.parse(readFileSync("test/fixtures/photon/it-park-cebu.json", "utf8"));
const PHILIPPINES: Bound = { id: "ph-test", south: 4.5, north: 21.2, west: 116.9, east: 126.7 };
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

  it("only those inside the active trip bound are offered", () => {
    expect(builtInMatches("city hall", TRIP_BOUND).map((p) => p.id)).toEqual([
      "built-in:lapu-lapu-city-hall",
      "built-in:talisay-city-hall",
    ]);
    expect(builtInMatches("davao", TRIP_BOUND)).toEqual([]);
    expect(builtInMatches("davao", PHILIPPINES).map((p) => p.id)).toEqual(["built-in:davao-city-hall"]);
  });

  it("matches word starts, ignoring case and accents", () => {
    expect(builtInMatches("fuente osme", TRIP_BOUND).map((p) => p.id)).toEqual(["built-in:fuente-osmena"]);
    expect(builtInMatches("IT PAR", TRIP_BOUND).map((p) => p.id)).toEqual(["built-in:cebu-it-park"]);
    expect(builtInMatches("ark", TRIP_BOUND)).toEqual([]);
  });
});

describe("Photon's reply", () => {
  it("keeps points in the Philippines inside the bound, one per name and area", () => {
    const places = placesFromPhoton(IT_PARK_REPLY, TRIP_BOUND);
    expect(places.map((p) => p.name)).toEqual([
      "IT Park BRT Stop",
      "Cebu IT Park Transport Terminal",
      "HVG I.T. Park",
      "Cebu I.T. Park",
      "Bigfoot I.T. and Media Park",
      "Cebu IT Tower",
      "AAS IT Services",
    ]);
    expect(places.every((p) => p.source === "osm" && inBound(TRIP_BOUND, p))).toBe(true);
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
    expect(placesFromPhoton(body, TRIP_BOUND).map((p) => p.name)).toEqual(["12 Gorordo Avenue"]);
    expect(placesFromPhoton({ nope: true }, TRIP_BOUND)).toEqual([]);
    expect(placesFromPhoton(null, TRIP_BOUND)).toEqual([]);
  });
});

describe("the request to Photon", () => {
  it("is limited to the bound and biased to the phone, rounded to a tenth of a degree", () => {
    const bias = roundBias("10.3456", "123.9123", TRIP_BOUND);
    expect(bias).toEqual({ lat: 10.3, lon: 123.9 });
    const url = new URL(photonUrl("it park", TRIP_BOUND, bias));
    expect(url.host).toBe("photon.komoot.io");
    expect(url.searchParams.get("bbox")).toBe("123.74,10.2,124.07,10.47");
    expect(url.searchParams.get("lat")).toBe("10.3");
    expect(url.searchParams.get("lon")).toBe("123.9");
    expect(new URL(photonUrl("x y z", TRIP_BOUND, null)).searchParams.has("lat")).toBe(false);
  });

  it("drops a bias outside the bound or not a number", () => {
    expect(roundBias("14.6", "121.0", TRIP_BOUND)).toBeNull();
    expect(roundBias("abc", "121.0", TRIP_BOUND)).toBeNull();
    expect(roundBias(null, null, TRIP_BOUND)).toBeNull();
  });
});

describe("the shared Photon queue", () => {
  it("lets one caller a second through across instances", async () => {
    const slots = new MemorySlotStore();
    const queue = new MemoryCounterStore();
    const a = makePhotonGate(slots, queue, { waitMs: 3_000, pollMs: 50 });
    const b = makePhotonGate(slots, queue, { waitMs: 3_000, pollMs: 50 });
    const t0 = performance.now();
    expect(await a.acquire()).toBe("ok");
    expect(await b.acquire()).toBe("ok");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it("answers busy at once when 20 callers already wait", async () => {
    const queue = new MemoryCounterStore();
    await queue.add(PHOTON_QUEUE_KEY, 20, 10_000);
    const claim = vi.fn(async () => true);
    const gate = makePhotonGate({ claim }, queue);
    expect(await gate.acquire()).toBe("busy");
    expect(claim).not.toHaveBeenCalled();
    expect(await queue.add(PHOTON_QUEUE_KEY, 0, 10_000)).toBe(20);
  });

  it("gives up after its wait and frees its place in the queue", async () => {
    const slots = new MemorySlotStore();
    await slots.claim(PHOTON_SLOT_KEY, 60_000);
    const queue = new MemoryCounterStore();
    const gate = makePhotonGate(slots, queue, { waitMs: 300, pollMs: 50 });
    const t0 = performance.now();
    expect(await gate.acquire()).toBe("busy");
    expect(performance.now() - t0).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(await queue.add(PHOTON_QUEUE_KEY, 0, 10_000)).toBe(0);
  });

  it("is unavailable without its stores, or when they fail", async () => {
    expect(await makePhotonGate(null, new MemoryCounterStore()).acquire()).toBe("unavailable");
    const broken = { add: async () => Promise.reject(new Error("down")) };
    expect(await makePhotonGate(new MemorySlotStore(), broken).acquire()).toBe("unavailable");
    const brokenSlots = { claim: async () => Promise.reject(new Error("down")) };
    expect(await makePhotonGate(brokenSlots, new MemoryCounterStore()).acquire()).toBe("unavailable");
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
    const reply = await searchPlaces("IT Park", null, { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: TRIP_BOUND });
    expect(reply.status).toBe("ok");
    expect(reply.places[0].id).toBe("built-in:cebu-it-park");
    expect(reply.places.length).toBeLessThanOrEqual(8);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("asks Photon once for the same query and rounded place", async () => {
    const fetchMock = vi.fn(async () => ok());
    const deps = { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: TRIP_BOUND };
    await searchPlaces("IT Park", { lat: 10.3, lon: 123.9 }, deps);
    await searchPlaces("it  park", { lat: 10.3, lon: 123.9 }, deps);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends nothing for a short query", async () => {
    const fetchMock = vi.fn(async () => ok());
    expect(await searchPlaces("it", null, { fetch: fetchMock, gate: OPEN, cache: new PlaceCache(), bound: TRIP_BOUND })).toEqual({
      status: "short",
      places: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says busy or down and offers the built-in places when Photon can't be asked or fails", async () => {
    const cache = new PlaceCache();
    const never = vi.fn(async () => ok());
    const busy = await searchPlaces("talisay", null, { fetch: never, gate: { acquire: async () => "busy" }, cache, bound: TRIP_BOUND });
    expect(busy).toEqual({ status: "busy", places: [expect.objectContaining({ id: "built-in:talisay-city-hall" })] });
    expect(never).not.toHaveBeenCalled();
    const down = await searchPlaces("talisay", null, { fetch: never, gate: { acquire: async () => "unavailable" }, cache, bound: TRIP_BOUND });
    expect(down.status).toBe("down");
    const throttled = await searchPlaces("talisay", null, {
      fetch: async () => new Response("slow down", { status: 429 }),
      gate: OPEN,
      cache,
      bound: TRIP_BOUND,
    });
    expect(throttled.status).toBe("busy");
    const broken = await searchPlaces("talisay", null, {
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
      gate: OPEN,
      cache,
      bound: TRIP_BOUND,
    });
    expect(broken).toEqual({ status: "down", places: [expect.objectContaining({ id: "built-in:talisay-city-hall" })] });
    expect(cache.size).toBe(0);
  });
});
