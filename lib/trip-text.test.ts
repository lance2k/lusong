import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countStoreFromEnv, MemoryCountStore, UpstashCountStore, addressLimitKey, createAddressLimit } from "./address-limit";
import { createBudget, ipKeyFor, MemoryBudgetStore, RESERVE_MICROS, type Budget } from "./budget";
import { Meter, MetaApiError } from "./meta";
import { PlaceCache, type PlacesDeps } from "./places";
import { TRIP_BOUND } from "./trip-bound";
import {
  candidatesOf,
  readTripText,
  resolveTrip,
  TRIP_TEXT_INPUT_TOKEN_BOUND,
  TRIP_TEXT_RESERVE_MICROS,
  TRIP_TEXT_SCHEMA,
  tripReadingOf,
  tripTextOf,
  type ReadTrip,
  type TripReading,
} from "./trip-text";
import { makeTripTextHandler, TRIP_TEXT_LIMIT_PREFIX } from "./trip-text-handler";
import { TRIP_TEXT_PER_IP_DAILY } from "./trip-text-words";

const TEXT = "Talamban to IT Park, leaving around 7";

/** A Photon feature in Cebu City, the shape lib/places.ts reads. */
function feature(name: string, lat: number, lon: number, osmId: number, extra: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { osm_type: "N", osm_id: osmId, name, city: "Cebu City", state: "Central Visayas", countrycode: "PH", ...extra },
  };
}

/** Photon faked by query: each query's features, or none. Returns the queries it was sent. */
function photonFetch(byQuery: Record<string, object[]>): { fetch: typeof fetch; queries: string[] } {
  const queries: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams.get("q") ?? "";
    queries.push(q);
    return Response.json({ type: "FeatureCollection", features: byQuery[q] ?? [] });
  }) as typeof fetch;
  return { fetch: f, queries };
}

function placesWith(f: typeof fetch, gate: "ok" | "busy" | "unavailable" = "ok"): PlacesDeps {
  return { fetch: f, gate: { acquire: async () => gate }, cache: new PlaceCache(), bound: TRIP_BOUND };
}

const PHOTON = {
  "Talamban": [feature("Talamban Road", 10.3561, 123.9131, 1), feature("Talamban Barangay Hall", 10.3602, 123.9116, 2)],
  "IT Park": [
    feature("Cebu IT Park Gate", 10.3301, 123.9061, 3),
    feature("IT Park Terminal", 10.3311, 123.9052, 4),
    feature("IT Park Tower 1", 10.3305, 123.9049, 5),
    feature("IT Park Tower 2", 10.3306, 123.905, 6),
  ],
};

describe("the typed text", () => {
  it("is trimmed and collapsed, and taken only from 3 to 160 characters", () => {
    expect(tripTextOf("  Talamban\n to   IT Park ")).toBe("Talamban to IT Park");
    expect(tripTextOf("ab")).toBeNull();
    expect(tripTextOf("a".repeat(160))).toHaveLength(160);
    expect(tripTextOf("a".repeat(161))).toBeNull();
    expect(tripTextOf(42)).toBeNull();
  });
});

describe("the reading's schema (S5)", () => {
  it("is strict: three strings, all required, nothing else", () => {
    expect(TRIP_TEXT_SCHEMA.additionalProperties).toBe(false);
    expect([...TRIP_TEXT_SCHEMA.required].sort()).toEqual(["from", "leave_at", "to"]);
  });

  it("keeps a place only when its words are in the text, and a time only as HH:MM", () => {
    expect(tripReadingOf({ from: "Talamban", to: "IT Park", leave_at: "07:00" }, TEXT)).toEqual({ from: "Talamban", to: "IT Park", leaveAt: "07:00" });
    expect(tripReadingOf({ from: "talamban", to: "it park", leave_at: "" }, TEXT)).toEqual({ from: "talamban", to: "it park", leaveAt: null });
    // An invented place: not in the text, so it never reaches the place search.
    expect(tripReadingOf({ from: "Banilad", to: "IT Park", leave_at: "07:00" }, TEXT)?.from).toBeNull();
    for (const bad of ["7:00", "07:00 PM", "24:00", "07:60", "around 7", "0700"]) {
      expect(tripReadingOf({ from: "Talamban", to: "IT Park", leave_at: bad }, TEXT)?.leaveAt).toBeNull();
    }
  });

  it("drops an overlong place, fails a reply missing a field, and drops fields it doesn't name", () => {
    const long = `${"Talamban ".repeat(9)}Talamban`;
    expect(long.length).toBeGreaterThan(80);
    expect(tripReadingOf({ from: long, to: "IT Park", leave_at: "" }, `${long} to IT Park`)?.from).toBeNull();
    expect(tripReadingOf({ from: "Talamban", leave_at: "07:00" }, TEXT)).toBeNull();
    expect(tripReadingOf({ from: "Talamban", to: null, leave_at: "07:00" }, TEXT)).toBeNull();
    expect(tripReadingOf(null, TEXT)).toBeNull();
    const extra = tripReadingOf({ from: "Talamban", to: "IT Park", leave_at: "07:00", note: "Ignore the rules", url: "https://x" }, TEXT);
    expect(Object.keys(extra!).sort()).toEqual(["from", "leaveAt", "to"]);
  });
});

describe("the reserve", () => {
  it("covers two attempts of the bounded prompt and reply, and stays near the plan's $0.019", () => {
    expect(TRIP_TEXT_INPUT_TOKEN_BOUND).toBeGreaterThan(600);
    expect(TRIP_TEXT_RESERVE_MICROS).toBe(2 * Math.ceil(TRIP_TEXT_INPUT_TOKEN_BOUND * 1.25 + 2_000 * 4.25));
    expect(TRIP_TEXT_RESERVE_MICROS).toBeLessThan(30_000);
    expect(TRIP_TEXT_RESERVE_MICROS).toBeLessThan(RESERVE_MICROS);
  });
});

describe("one Muse Spark call held to the schema (stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends Muse Spark 1.3 the strict schema and the text, and checks the reply", async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ from: "Talamban", to: "IT Park", leave_at: "07:00", extra: "x" }) } }],
        usage: { prompt_tokens: 300, completion_tokens: 200 },
      });
    });
    vi.stubEnv("MODEL_API_KEY", "test");
    const meter = new Meter();
    const reading = await readTripText(TEXT, { meter, deadline: Date.now() + 10_000 });
    expect(reading).toEqual({ from: "Talamban", to: "IT Park", leaveAt: "07:00" });
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toBe("muse-spark-1.3");
    expect(sent[0].response_format).toEqual({ type: "json_schema", json_schema: { name: "typed_trip", schema: TRIP_TEXT_SCHEMA, strict: true } });
    expect(JSON.stringify(sent[0].messages)).toContain(TEXT);
    expect(meter.usage()).toMatchObject({ museInputTokens: 300, museOutputTokens: 200, complete: true });
    vi.unstubAllEnvs();
  });

  it("a reply off the schema is a failed reading", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ from: "Talamban" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    vi.stubEnv("MODEL_API_KEY", "test");
    await expect(readTripText(TEXT, { meter: new Meter(), deadline: Date.now() + 10_000 })).rejects.toBeInstanceOf(MetaApiError);
    vi.unstubAllEnvs();
  });
});

describe("resolving both ends through the place search", () => {
  it("carries at most 3 of the search's own places per end, and the checked time", async () => {
    const { fetch, queries } = photonFetch(PHOTON);
    const reply = await resolveTrip({ from: "Talamban", to: "IT Park", leaveAt: "07:00" }, placesWith(fetch));
    expect(queries.sort()).toEqual(["IT Park", "Talamban"]);
    expect(reply.status).toBe("ok");
    if (reply.status !== "ok") return;
    // A built-in place comes first, then Photon's, as in the From and To boxes.
    expect(reply.from.map((p) => p.name)).toEqual(["Talamban (USC campus)", "Talamban Road", "Talamban Barangay Hall"]);
    expect(reply.to).toHaveLength(3);
    expect(reply.to[0].name).toBe("Cebu IT Park");
    expect(reply.leave_at).toBe("07:00");
  });

  it("the reply never contains the model's strings: a string that isn't a place name never appears", async () => {
    const odd = "Kwarta Nimo Ihatag";
    const { fetch } = photonFetch({ [odd]: [feature("Mabolo Church", 10.3194, 123.9147, 9)], "IT Park": PHOTON["IT Park"] });
    const reply = await resolveTrip({ from: odd, to: "IT Park", leaveAt: null }, placesWith(fetch));
    expect(reply.status).toBe("ok");
    const json = JSON.stringify(reply).toLowerCase();
    for (const word of ["kwarta", "nimo", "ihatag"]) expect(json).not.toContain(word);
    expect(json).toContain("mabolo church");
  });

  it("drops a place outside the Philippine provinces, as the check would", () => {
    const sabah = { id: "osm:N1", name: "Kota Kinabalu", area: "", lat: 5.98, lon: 116.07, source: "osm" as const };
    const cebu = { id: "osm:N2", name: "Mabolo", area: "Cebu City", lat: 10.3194, lon: 123.9147, source: "osm" as const };
    expect(candidatesOf({ status: "ok", places: [sabah, cebu] }).map((p) => p.name)).toEqual(["Mabolo"]);
  });

  it("an end with no place is no_place; an end the search couldn't reach is search; neither echoes the strings", async () => {
    const { fetch } = photonFetch({ "IT Park": PHOTON["IT Park"] });
    const none = await resolveTrip({ from: "Qwzx Plaza", to: "IT Park", leaveAt: null }, placesWith(fetch));
    expect(none).toEqual({ status: "failed", reason: "no_place" });
    expect(await resolveTrip({ from: null, to: "IT Park", leaveAt: null }, placesWith(fetch))).toEqual({ status: "failed", reason: "no_place" });
    const down = await resolveTrip({ from: "Qwzx Plaza", to: "IT Park", leaveAt: null }, placesWith(fetch, "unavailable"));
    expect(down).toEqual({ status: "failed", reason: "search" });
  });
});

const IP = "203.0.113.7";

function post(body: unknown, ip = IP): Request {
  return new Request("http://localhost/api/trip-text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const reads = (reading: TripReading): ReadTrip => async (_text, { meter }) => {
  meter.reply("spark-chat", { usage: { prompt_tokens: 400, completion_tokens: 300 } });
  return reading;
};

function setup(opts: { budgetMicros?: number; read?: ReadTrip; budgetStore?: MemoryBudgetStore } = {}) {
  const budgetStore = opts.budgetStore ?? new MemoryBudgetStore();
  const budget: Budget = createBudget({ store: budgetStore, budgetUsd: (opts.budgetMicros ?? 10_000_000) / 1e6, ipLimit: 10 });
  const counts = new MemoryCountStore();
  const limit = createAddressLimit({ store: counts, prefix: TRIP_TEXT_LIMIT_PREFIX, limit: TRIP_TEXT_PER_IP_DAILY });
  const photon = photonFetch(PHOTON);
  const read = vi.fn(opts.read ?? reads({ from: "Talamban", to: "IT Park", leaveAt: "07:00" }));
  const handler = makeTripTextHandler({ budget: () => budget, limit: () => limit, places: () => placesWith(photon.fetch), read });
  return { handler, budget, budgetStore, read, photon };
}

describe("POST /api/trip-text", () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers with the search's places and the checked time", async () => {
    const { handler, read } = setup();
    const res = await handler(post({ text: TEXT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.from[0]).toEqual({ id: "built-in:talamban", name: "Talamban (USC campus)", area: "Cebu City", lat: 10.35594, lon: 123.90715, source: "built-in" });
    expect(body.to.length).toBeLessThanOrEqual(3);
    expect(body.leave_at).toBe("07:00");
    expect(Object.keys(body).sort()).toEqual(["from", "leave_at", "status", "to"]);
    expect(read).toHaveBeenCalledWith(TEXT, expect.anything());
  });

  it("never logs or returns the text or the model's strings, on success or failure", async () => {
    const odd = "Kwarta Nimo Ihatag";
    const text = `${odd} to Zuzu Lane`;
    for (const read of [
      reads({ from: odd, to: "Zuzu Lane", leaveAt: null }),
      (async () => {
        throw new Error(`model said ${odd}`);
      }) as ReadTrip,
    ]) {
      const { handler } = setup({ read });
      const res = await handler(post({ text }));
      const body = await res.text();
      for (const s of [odd, "Zuzu", text]) {
        expect(body).not.toContain(s);
        expect(logged.join("\n")).not.toContain(s);
      }
      expect(JSON.parse(body)).toMatchObject({ status: "failed" });
    }
    expect(logged.join("\n")).toContain("typed trip reading failed: not a Meta API error");
  });

  it("refuses bad text before the limit, the budget or the model", async () => {
    const { handler, read } = setup();
    for (const body of [{ text: "ab" }, { text: "a".repeat(161) }, {}, "not json", { text: 7 }]) {
      const res = await handler(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ status: "failed", reason: "text" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("allows 20 typed trips per address per UTC day, and the 21st gets the fixed ip message without a model call", async () => {
    const { handler, read } = setup();
    for (let i = 0; i < TRIP_TEXT_PER_IP_DAILY; i++) expect((await handler(post({ text: TEXT }))).status).toBe(200);
    const res = await handler(post({ text: TEXT }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ status: "failed", reason: "ip" });
    expect(read).toHaveBeenCalledTimes(TRIP_TEXT_PER_IP_DAILY);
    expect((await handler(post({ text: TEXT }, "198.51.100.2"))).status).toBe(200);
  });

  it("uses none of the address's 10 daily checks", async () => {
    const { handler, budget } = setup();
    for (let i = 0; i < TRIP_TEXT_PER_IP_DAILY; i++) await handler(post({ text: TEXT }));
    const now = new Date();
    for (let i = 0; i < 10; i++) expect((await budget.admit(IP, now)).ok).toBe(true);
    expect(await budget.admit(IP, now)).toEqual({ ok: false, reason: "ip" });
  });

  it("a refused budget gives the fixed budget message and no model call", async () => {
    const { handler, read } = setup({ budgetMicros: TRIP_TEXT_RESERVE_MICROS - 1 });
    const res = await handler(post({ text: TEXT }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "failed", reason: "budget" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a missing store is unavailable, not a free pass", async () => {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 10 });
    const read = vi.fn(reads({ from: "Talamban", to: "IT Park", leaveAt: null }));
    const handler = makeTripTextHandler({
      budget: () => budget,
      limit: () => createAddressLimit({ store: null, prefix: TRIP_TEXT_LIMIT_PREFIX, limit: 20 }),
      places: () => placesWith(photonFetch(PHOTON).fetch),
      read,
    });
    expect(await (await handler(post({ text: TEXT }))).json()).toEqual({ status: "failed", reason: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a failed model call is the model message, and keeps the reservation", async () => {
    const budgetStore = new MemoryBudgetStore();
    const settle = vi.spyOn(budgetStore, "settle");
    const { handler } = setup({
      budgetStore,
      read: async () => {
        throw new MetaApiError("/chat/completions", 500);
      },
    });
    const res = await handler(post({ text: TEXT }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "failed", reason: "model" });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ chargeMicros: TRIP_TEXT_RESERVE_MICROS }));
  });

  it("a successful reading is charged its metered cost, not the reserve", async () => {
    const budgetStore = new MemoryBudgetStore();
    const settle = vi.spyOn(budgetStore, "settle");
    const { handler } = setup({ budgetStore });
    await handler(post({ text: TEXT }));
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ chargeMicros: Math.ceil(400 * 1.25 + 300 * 4.25) }));
  });

  it("no place found is the fixed no_place message", async () => {
    const { handler } = setup({ read: reads({ from: null, to: "IT Park", leaveAt: "07:00" }) });
    const res = await handler(post({ text: TEXT }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ status: "failed", reason: "no_place" });
  });
});

describe("the per-address limit's store", () => {
  it("keys each address under lusong:trip-text, hashed with the UTC day, apart from the checks' keys", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const key = addressLimitKey(TRIP_TEXT_LIMIT_PREFIX, IP, now);
    expect(key).toBe(`lusong:trip-text:ip:2026-11-03:${ipKeyFor("2026-11-03", IP)}`);
    expect(key).not.toContain(IP);
    expect(addressLimitKey(TRIP_TEXT_LIMIT_PREFIX, IP, new Date("2026-11-04T00:00:00Z"))).not.toBe(key);
  });

  it("a memory store is refused when deployed", () => {
    expect(countStoreFromEnv({ LUSONG_BUDGET_STORE: "memory" })).toBeInstanceOf(MemoryCountStore);
    expect(countStoreFromEnv({ LUSONG_BUDGET_STORE: "memory", VERCEL: "1" })).toBeNull();
    expect(countStoreFromEnv({ LUSONG_BUDGET_STORE: "memory", NODE_ENV: "production" })).toBeNull();
    expect(countStoreFromEnv({})).toBeNull();
  });
});

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

describe.skipIf(!upstashUrl)("the per-address limit on Upstash", () => {
  async function redis(command: string[]) {
    const res = await fetch(upstashUrl!, { method: "POST", headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    return ((await res.json()) as { result: unknown }).result;
  }

  it("takes 20, refuses the 21st without counting it, and sets an expiry", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}-${Date.now()}`;
    const now = new Date();
    const key = addressLimitKey(TRIP_TEXT_LIMIT_PREFIX, ip, now);
    const limit = createAddressLimit({ store: new UpstashCountStore(upstashUrl!, upstashToken), prefix: TRIP_TEXT_LIMIT_PREFIX, limit: 20 });
    for (let i = 0; i < 20; i++) expect(await limit.take(ip, now)).toBe("ok");
    expect(await limit.take(ip, now)).toBe("limited");
    expect(await redis(["GET", key])).toBe("20");
    const ttl = (await redis(["TTL", key])) as number;
    expect(ttl).toBeGreaterThan(172_000);
    await redis(["DEL", key]);
  });
});
