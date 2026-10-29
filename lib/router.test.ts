import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  fetchRoute,
  makeValhallaGate,
  MemorySlotStore,
  slotStoreFromEnv,
  UpstashSlotStore,
  VALHALLA_SLOT_KEY,
  VALHALLA_URL,
  wayIdFromLocate,
  type SlotStore,
} from "./router";

const PLAIN = readFileSync("test/fixtures/valhalla/banilad-itpark-plain.json", "utf8");
const LOCATE = JSON.parse(readFileSync("test/fixtures/valhalla/locate-sample-pins.json", "utf8"));
const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };

type Reply = () => Response | Promise<Response>;

function valhalla(replies: Reply[]) {
  const starts: { at: number; url: string; init: RequestInit }[] = [];
  const queue = [...replies];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    starts.push({ at: performance.now(), url: String(url), init: init ?? {} });
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  });
  return { fetch: fetchMock as unknown as typeof fetch, starts };
}
const ok = (): Reply => () => new Response(PLAIN, { status: 200 });
const dropped = (): Reply => () => Promise.reject(new TypeError("fetch failed"));

const gateOn = (store: SlotStore | null) => makeValhallaGate(store);

describe("the plain motorbike route from Valhalla", () => {
  it("decodes the Banilad → IT Park route saved on 2026-10-30: 2.55 km, 11.3 min, 127 points", async () => {
    const { fetch } = valhalla([ok()]);
    const result = await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: gateOn(new MemorySlotStore()) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.lengthKm).toBe(2.552);
    expect(result.route.timeMin).toBeCloseTo(11.35, 2);
    expect(result.route.line).toHaveLength(127);
    expect(result.route.line[0]).toEqual({ lat: 10.345797, lon: 123.911131 });
    expect(result.route.line[126]).toEqual({ lat: 10.33073, lon: 123.905825 });
    expect(result.route.streets).toContain("Governor M. Cuenco Avenue");
  });

  it("asks for costing motorcycle with a named User-Agent and client id", async () => {
    const { fetch, starts } = valhalla([ok()]);
    await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: gateOn(new MemorySlotStore()) });
    expect(starts).toHaveLength(1);
    expect(starts[0].url).toBe(`${VALHALLA_URL}/route`);
    const headers = new Headers(starts[0].init.headers);
    expect(headers.get("user-agent")).toBe("Lusong/0.1 (hackathon entry; github.com/lance2k/lusong)");
    expect(headers.get("x-client-id")).toBe("lusong");
    expect(JSON.parse(String(starts[0].init.body))).toEqual({
      locations: [BANILAD, IT_PARK],
      costing: "motorcycle",
      directions_options: { units: "kilometers" },
    });
  });

  it("an unreachable server is an explicit state after one retry, not an empty route", async () => {
    const { fetch, starts } = valhalla([dropped()]);
    const result = await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: gateOn(new MemorySlotStore()) });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(starts).toHaveLength(2);
    expect(starts[1].at - starts[0].at).toBeGreaterThanOrEqual(1_000);
  });

  it.each([
    { name: "HTTP 503", reply: () => new Response("busy", { status: 503 }) },
    { name: "a body that isn't a trip", reply: () => Response.json({ trip: { legs: [] } }) },
  ])("$name is unreachable", async ({ reply }) => {
    const { fetch } = valhalla([reply]);
    expect(await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: gateOn(new MemorySlotStore()) })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("Valhalla's 'no path could be found' is no_route, not retried", async () => {
    const { fetch, starts } = valhalla([() => Response.json({ error_code: 442, error: "No path could be found for input" }, { status: 400 })]);
    expect(await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: gateOn(new MemorySlotStore()) })).toEqual({
      ok: false,
      reason: "no_route",
    });
    expect(starts).toHaveLength(1);
  });
});

describe("one request a second to Valhalla, shared through the store (🔴P7)", () => {
  const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
  const stores: [string, () => SlotStore][] = [
    ["memory store", () => new MemorySlotStore()],
    ...(upstashUrl
      ? [["Upstash store", () => new UpstashSlotStore(upstashUrl, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "", `lusong-test-${randomUUID()}`)] as [
          string,
          () => SlotStore,
        ]]
      : []),
  ];

  it.each(stores)("two instances on one %s: concurrent requests start at least 1 s apart", async (_name, makeStore) => {
    const store = makeStore();
    const { fetch, starts } = valhalla([ok()]);
    const instanceA = makeValhallaGate(store);
    const instanceB = makeValhallaGate(store);
    const results = await Promise.all([
      fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: instanceA }),
      fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: instanceB }),
      fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: instanceA }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const times = starts.map((s) => s.at).sort((a, b) => a - b);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1_000);
  }, 10_000);

  it("claims the slot with SET lusong:valhalla:slot NX PX before the request", async () => {
    const claims: unknown[] = [];
    const store: SlotStore = {
      async claim(key, ttlMs) {
        claims.push([key, ttlMs]);
        return true;
      },
    };
    const { fetch } = valhalla([ok()]);
    await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: makeValhallaGate(store) });
    expect(VALHALLA_SLOT_KEY).toBe("lusong:valhalla:slot");
    expect(claims).toEqual([[VALHALLA_SLOT_KEY, 1_050]]);
  });

  it("a slot that stays taken past the bounded wait gives 'busy' and no request", async () => {
    const store: SlotStore = { claim: async () => false };
    const { fetch, starts } = valhalla([ok()]);
    const gate = makeValhallaGate(store, { waitMs: 300, pollMs: 50 });
    expect(await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate })).toEqual({ ok: false, reason: "busy" });
    expect(starts).toHaveLength(0);
  });

  it.each([
    { name: "no store configured", store: null },
    { name: "a store that throws", store: { claim: async () => Promise.reject(new Error("Upstash HTTP 500")) } as SlotStore },
  ])("$name: fails closed, with no request", async ({ store }) => {
    const { fetch, starts } = valhalla([ok()]);
    expect(await fetchRoute({ from: BANILAD, to: IT_PARK }, { fetch, gate: makeValhallaGate(store) })).toEqual({
      ok: false,
      reason: "gate_unavailable",
    });
    expect(starts).toHaveLength(0);
  });

  it("the Upstash store sends SET key 1 NX PX ttl and reads OK / null", async () => {
    const bodies: unknown[] = [];
    const replies = [{ result: "OK" }, { result: null }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json(replies.shift());
      }),
    );
    try {
      const store = new UpstashSlotStore("https://upstash.example", "token");
      expect(await store.claim("lusong:valhalla:slot", 1_050)).toBe(true);
      expect(await store.claim("lusong:valhalla:slot", 1_050)).toBe(false);
      expect(bodies[0]).toEqual(["SET", "lusong:valhalla:slot", "1", "NX", "PX", "1050"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("OSM way ids from Valhalla /locate (🔴P4)", () => {
  it("each sample pin's nearest edge gives its way id (5 pins, one request, 2026-10-30 01:32 PHT)", () => {
    // The third pin sits on the corner of M.J. Cuenco Avenue and H. Joaquino Street: both ways at 0 m, so no way id.
    expect(LOCATE.map(wayIdFromLocate)).toEqual([1116002958, 1207204799, null, 50873803, 237982309]);
  });

  it("two different ways at the same nearest distance is no way id", () => {
    const edge = (way: number, distance: number) => ({ distance, edge_info: { way_id: way } });
    expect(wayIdFromLocate({ edges: [edge(1, 0.5), edge(2, 0.5), edge(3, 9)] })).toBeNull();
    expect(wayIdFromLocate({ edges: [edge(1, 0.5), edge(2, 3)] })).toBe(1);
    expect(wayIdFromLocate({ edges: null })).toBeNull();
  });
});

describe("the slot store from the environment", () => {
  it.each([
    { name: "Upstash REST variables", env: { UPSTASH_REDIS_REST_URL: "https://u.example", UPSTASH_REDIS_REST_TOKEN: "t" }, kind: "UpstashSlotStore" },
    { name: "Vercel's KV variables", env: { KV_REST_API_URL: "https://u.example", KV_REST_API_TOKEN: "t" }, kind: "UpstashSlotStore" },
    { name: "the local memory switch", env: { LUSONG_BUDGET_STORE: "memory" }, kind: "MemorySlotStore" },
    { name: "the memory switch on Vercel", env: { LUSONG_BUDGET_STORE: "memory", VERCEL: "1" }, kind: null },
    { name: "nothing set", env: {}, kind: null },
  ])("$name ⇒ $kind", ({ env, kind }) => {
    const store = slotStoreFromEnv(env);
    expect(store ? store.constructor.name : null).toBe(kind);
  });
});
