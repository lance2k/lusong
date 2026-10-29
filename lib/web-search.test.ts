import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBudget, MemoryBudgetStore } from "./budget";
import { Meter } from "./meta";
import {
  MAX_WEB_FINDINGS,
  MemoryKvStore,
  planWebSearch,
  releaseWebSearch,
  SEARCH_BUDGET_PREFIX,
  SEARCH_DAILY_BUDGET_USD,
  SEARCH_RESERVE_MICROS,
  runWebSearch,
  searchStoreFromEnv,
  SEARCH_MAX_OUTPUT_TOKENS,
  WEB_SEARCH_CACHE_MS,
  WEB_SEARCH_FAILED_CACHE_MS,
  WEB_SEARCH_KEY,
  UpstashKvStore,
  type KvStore,
} from "./web-search";
import { fakeMeta, searchReply } from "../test/muse-derived";

const NOW = new Date("2026-10-30T02:00:00Z"); // 10:00 PHT, 2026-10-30
/** A search budget with room for many searches. */
const roomy = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 });
const closures = (items: object[]) => JSON.stringify({ closures: items });
const MABOLO = { place: "Juan Luna Ave, Mabolo", lat: 10.3175, lon: 123.9146, url: "https://example.ph/mabolo-flood", date: "2026-10-30", summary: "Knee-deep flood, road closed." };

async function searchOnce(store: KvStore | null, at: Date = NOW, deadline = Date.now() + 40_000) {
  return runWebSearch(await planWebSearch(store, at, roomy()), { store, now: at, deadline, meter: new Meter() });
}

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the web search for road closures in Metro Cebu today", () => {
  it("asks Muse Spark once with web_search, a capped output and today's date in Philippine time", async () => {
    const meta = fakeMeta({ search: [searchReply(closures([MABOLO]))] });

    const web = await searchOnce(new MemoryKvStore());

    expect(meta.searchRequests).toHaveLength(1);
    const sent = meta.searchRequests[0];
    expect(sent.tools).toEqual([{ type: "web_search" }]);
    expect(sent.max_output_tokens).toBe(SEARCH_MAX_OUTPUT_TOKENS);
    expect(sent.input).toContain("2026-10-30");
    expect(web).toEqual({
      state: "searched",
      searchedAt: NOW.toISOString(),
      findings: [
        { id: "web-0", place: "Juan Luna Ave, Mabolo", at: { lat: 10.3175, lon: 123.9146 }, url: "https://example.ph/mabolo-flood", sourceDate: "2026-10-30", summary: "Knee-deep flood, road closed." },
      ],
    });
  });

  it("a finding without a location, or with one outside Metro Cebu, is kept with no location", async () => {
    fakeMeta({
      search: [
        searchReply(
          closures([
            { ...MABOLO, lat: null, lon: null },
            { ...MABOLO, lat: 14.5995, lon: 120.9842 },
            { ...MABOLO, lat: "10.3175", lon: "123.9146" },
          ]),
        ),
      ],
    });

    const web = await searchOnce(new MemoryKvStore());

    expect(web.findings.map((f) => f.at)).toEqual([null, null, null]);
  });

  it("an undated finding, or one with a malformed date, has no source date", async () => {
    fakeMeta({ search: [searchReply(closures([{ ...MABOLO, date: null }, { ...MABOLO, date: "30 Oct" }, { ...MABOLO, date: "2026-02-30" }]))] });

    const web = await searchOnce(new MemoryKvStore());

    expect(web.findings.map((f) => f.sourceDate)).toEqual([null, null, null]);
  });

  it("a finding with no place, or a link that isn't http(s), is dropped", async () => {
    fakeMeta({
      search: [
        searchReply(closures([{ ...MABOLO, place: "" }, { ...MABOLO, url: "javascript:alert(1)" }, { ...MABOLO, url: "not a url" }, MABOLO])),
      ],
    });

    const web = await searchOnce(new MemoryKvStore());

    expect(web.findings.map((f) => f.id)).toEqual(["web-3"]);
  });

  it(`keeps at most ${MAX_WEB_FINDINGS} findings`, async () => {
    fakeMeta({ search: [searchReply(closures(Array.from({ length: 12 }, () => MABOLO)))] });

    expect((await searchOnce(new MemoryKvStore())).findings).toHaveLength(MAX_WEB_FINDINGS);
  });

  it("the JSON may sit inside other words, and finding none is a search that found nothing", async () => {
    fakeMeta({ search: [searchReply(`Here is what I found:\n${closures([])}\nStay dry.`)] });

    expect(await searchOnce(new MemoryKvStore())).toEqual({ state: "searched", searchedAt: NOW.toISOString(), findings: [] });
  });

  it("the real reply cut off at max_output_tokens is a failed search, not one that found nothing", async () => {
    const real = JSON.parse(readFileSync("test/fixtures/muse/real-2026-10-30-responses-web-search-capped-3000.json", "utf8")).body;
    fakeMeta({ search: [real] });

    expect(await searchOnce(new MemoryKvStore())).toMatchObject({ state: "failed", why: "search cut off", findings: [] });
  });

  it("a reply with no readable JSON is a failed search", async () => {
    fakeMeta({ search: [searchReply("Mabolo is flooded according to reports.")] });

    expect(await searchOnce(new MemoryKvStore())).toMatchObject({ state: "failed", why: "unreadable reply" });
  });

  it("a search that errors is a failed search", async () => {
    fakeMeta({ search: [new Response("{}", { status: 500 }), new Response("{}", { status: 500 })] });

    expect(await searchOnce(new MemoryKvStore())).toMatchObject({ state: "failed", why: "search failed" });
  });
});

describe("one search is shared by every check for a while", () => {
  it(`is stored under the lusong: prefix and reused for ${WEB_SEARCH_CACHE_MS / 60_000} minutes by any check`, async () => {
    expect(WEB_SEARCH_KEY.startsWith("lusong:")).toBe(true);
    let now = NOW;
    const store = new MemoryKvStore(() => now.getTime());
    const meta = fakeMeta({ search: [searchReply(closures([MABOLO])), searchReply(closures([]))] });

    const first = await searchOnce(store, now);
    now = new Date(NOW.getTime() + WEB_SEARCH_CACHE_MS - 1);
    expect(await planWebSearch(store, now, roomy())).toEqual({ kind: "cached", evidence: first });
    expect(await searchOnce(store, now)).toEqual(first);
    expect(meta.searchRequests).toHaveLength(1);

    now = new Date(NOW.getTime() + WEB_SEARCH_CACHE_MS);
    expect(await planWebSearch(store, now, roomy())).toMatchObject({ kind: "search" });
    await searchOnce(store, now);
    expect(meta.searchRequests).toHaveLength(2);
  });

  it(`a failed search is reused for ${WEB_SEARCH_FAILED_CACHE_MS / 60_000} minutes, so a failing search isn't paid for on every check`, async () => {
    let now = NOW;
    const store = new MemoryKvStore(() => now.getTime());
    fakeMeta({ search: [searchReply("no JSON here")] });

    await searchOnce(store, now);
    now = new Date(NOW.getTime() + WEB_SEARCH_FAILED_CACHE_MS - 1);
    expect(await planWebSearch(store, now, roomy())).toMatchObject({ kind: "cached", evidence: { state: "failed" } });
    now = new Date(NOW.getTime() + WEB_SEARCH_FAILED_CACHE_MS);
    expect(await planWebSearch(store, now, roomy())).toMatchObject({ kind: "search" });
  });

  it("with no shared store, or one that can't be read, there is no search: each check would pay for its own", async () => {
    const meta = fakeMeta({ search: [] });
    const broken: KvStore = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
    };

    expect(await planWebSearch(null, NOW, roomy())).toEqual({ kind: "off", why: "no shared store" });
    expect(await planWebSearch(broken, NOW, roomy())).toEqual({ kind: "off", why: "store unreachable" });
    expect(await searchOnce(null)).toEqual({ state: "not_run", why: "no shared store", searchedAt: null, findings: [] });
    expect(meta.searchRequests).toHaveLength(0);
  });

  it("a stored record past its own expiry is searched again, whatever the store's TTL", async () => {
    const store = new MemoryKvStore();
    const evidence = { state: "searched", searchedAt: NOW.toISOString(), findings: [] };
    await store.set(WEB_SEARCH_KEY, JSON.stringify({ expiresAt: NOW.getTime(), evidence }), 24 * 3_600_000);

    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "search" });
  });

  it("a stored record that can't be read is searched again", async () => {
    const store = new MemoryKvStore();
    await store.set(WEB_SEARCH_KEY, "{not json", 60_000);

    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "search" });
  });

  it("a search whose result can't be stored still answers this check", async () => {
    fakeMeta({ search: [searchReply(closures([MABOLO]))] });
    const readOnly: KvStore = { get: async () => null, set: () => Promise.reject(new Error("down")) };

    expect(await searchOnce(readOnly)).toMatchObject({ state: "searched", findings: [{ id: "web-0" }] });
  });
});

/** The real store runs against Redis behind serverless-redis-http (Upstash's REST API), when one is up. */
const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
describe.skipIf(!upstashUrl)("the Upstash store for the shared search", () => {
  it("gives back what was set until its time runs out", async () => {
    const store = new UpstashKvStore(upstashUrl!, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "", `lusong-test-${randomUUID()}`);
    expect(await store.get(WEB_SEARCH_KEY)).toBeNull();
    await store.set(WEB_SEARCH_KEY, '{"a":1}', 300);
    expect(await store.get(WEB_SEARCH_KEY)).toBe('{"a":1}');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await store.get(WEB_SEARCH_KEY)).toBeNull();
  });
});

describe("the shared search store from the environment: the budget's store and switches", () => {
  it.each([
    { name: "Upstash REST variables", env: { UPSTASH_REDIS_REST_URL: "https://u.example", UPSTASH_REDIS_REST_TOKEN: "t" }, kind: "UpstashKvStore" },
    { name: "Vercel's KV variables", env: { KV_REST_API_URL: "https://u.example", KV_REST_API_TOKEN: "t" }, kind: "UpstashKvStore" },
    { name: "the local memory switch", env: { LUSONG_BUDGET_STORE: "memory" }, kind: "MemoryKvStore" },
    { name: "the memory switch on Vercel", env: { LUSONG_BUDGET_STORE: "memory", VERCEL: "1" }, kind: null },
    { name: "nothing set", env: {}, kind: null },
  ])("$name ⇒ $kind", ({ env, kind }) => {
    const store = searchStoreFromEnv(env);
    expect(store ? store.constructor.name : null).toBe(kind);
  });
});

describe(`today's web search spend is capped at $${SEARCH_DAILY_BUDGET_USD}, apart from the daily budget`, () => {
  const capped = (micros: number) => createBudget({ store: new MemoryBudgetStore(), budgetUsd: micros / 1e6, ipLimit: 1 });
  /** The probe search's usage: 90,257 × 1.25 + 3,000 × 4.25 + 11 × 2,500 = 153,071.25, charged as 153,072 µ$. */
  const PROBE_SEARCH_COST = 153_072;

  it("keeps its ledger in the budget's store under lusong:", () => {
    expect(SEARCH_BUDGET_PREFIX.startsWith("lusong:")).toBe(true);
  });

  it("past the cap, no search request is made and the check says why", async () => {
    const meta = fakeMeta({ search: [] });
    const store = new MemoryKvStore();

    const plan = await planWebSearch(store, NOW, capped(SEARCH_RESERVE_MICROS - 1));
    const web = await runWebSearch(plan, { store, now: NOW, deadline: Date.now() + 40_000, meter: new Meter() });

    expect(plan).toEqual({ kind: "off", why: "today's web search budget is used up" });
    expect(web).toEqual({ state: "not_run", why: "today's web search budget is used up", searchedAt: null, findings: [] });
    expect(meta.searchRequests).toHaveLength(0);
  });

  it("a search settles at its metered cost, so the next fits only if that cost plus a reservation does", async () => {
    for (const [room, searches] of [[0, 2], [-1, 1]] as const) {
      const budget = capped(SEARCH_RESERVE_MICROS + PROBE_SEARCH_COST + room);
      const meta = fakeMeta({ search: [searchReply(closures([])), searchReply(closures([]))] });
      const meter = new Meter();
      const first = await planWebSearch(new MemoryKvStore(), NOW, budget);
      await runWebSearch(first, { store: null, now: NOW, deadline: Date.now() + 40_000, meter });
      const second = await planWebSearch(new MemoryKvStore(), NOW, budget);
      await runWebSearch(second, { store: null, now: NOW, deadline: Date.now() + 40_000, meter });

      expect(meta.searchRequests).toHaveLength(searches);
      expect(meter.usage().webSearchQueries).toBe(11 * searches);
      vi.unstubAllGlobals();
    }
  });

  it("a search that never runs, because the check was refused, gives its reservation back", async () => {
    const budget = capped(SEARCH_RESERVE_MICROS);

    const plan = await planWebSearch(new MemoryKvStore(), NOW, budget);
    expect(plan).toMatchObject({ kind: "search" });
    await releaseWebSearch(plan);

    expect(await planWebSearch(new MemoryKvStore(), NOW, budget)).toMatchObject({ kind: "search" });
  });

  it("a cached search touches no budget", async () => {
    const store = new MemoryKvStore();
    fakeMeta({ search: [searchReply(closures([]))] });
    await runWebSearch(await planWebSearch(store, NOW, roomy()), { store, now: NOW, deadline: Date.now() + 40_000, meter: new Meter() });

    expect(await planWebSearch(store, NOW, capped(1))).toMatchObject({ kind: "cached" });
  });

  it("a search budget that can't be reached means no search", async () => {
    const unreachable = createBudget({ store: null, budgetUsd: 3, ipLimit: 1 });

    expect(await planWebSearch(new MemoryKvStore(), NOW, unreachable)).toEqual({ kind: "off", why: "the web search budget can't be read" });
  });
});
