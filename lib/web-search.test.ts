import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBudget, MemoryBudgetStore } from "./budget";
import type { WebPlan } from "./web-search";
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
  WEB_SEARCH_LEASE_KEY,
  SEARCH_LEASE_MS,
  UpstashKvStore,
  type KvStore,
} from "./web-search";
import { fakeMeta, META_RESPONSES_URL, searchReply } from "../test/muse-derived";

const NOW = new Date("2026-10-30T02:00:00Z"); // 10:00 PHT, 2026-10-30
/** A search budget with room for many searches. */
const roomy = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 });
const closures = (items: object[]) => JSON.stringify({ closures: items });
/** `summary` is a field a model might add: Lusong never keeps it. */
const MABOLO = { place: "Juan Luna Ave, Mabolo", lat: 10.3175, lon: 123.9146, url: "https://example.ph/mabolo-flood", date: "2026-10-30", kind: "flooded", summary: "Passable to all types of vehicles." };

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
    expect(sent.input).toContain('"kind"');
    expect(sent.input).not.toContain("summary");
    expect(web).toEqual({
      state: "searched",
      searchedAt: NOW.toISOString(),
      findings: [
        { id: "web-0", place: "Juan Luna Ave, Mabolo", at: { lat: 10.3175, lon: 123.9146 }, url: "https://example.ph/mabolo-flood", sourceDate: "2026-10-30", kind: "flooded" },
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

  describe("a finding's link counts only if the search tool itself opened or cited that page (review 🔴T7-8)", () => {
    it("in the real reply's shape, a link the tool opened is kept and one it never opened is dropped", async () => {
      const real = JSON.parse(readFileSync("test/fixtures/muse/real-2026-10-30-responses-web-search-capped-3000.json", "utf8")).body;
      const opened = "https://pco.gov.ph/news_releases/pbbm-orders-assistance-for-cebu-flood-victims/";
      const text = closures([{ ...MABOLO, url: opened }, { ...MABOLO, url: "https://cebu-roads.example.ph/all-clear" }]);
      const final = { type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
      fakeMeta({ search: [{ ...real, status: "completed", output: [...real.output, final] }] });

      const web = await searchOnce(new MemoryKvStore());

      expect(web.findings.map((f) => [f.id, f.url])).toEqual([["web-0", opened]]);
    });

    it("a link with a sentence in its host, path, query or fragment that the tool never opened is dropped", async () => {
      const unopened = [
        "https://start-your-trip-now.example.ph/mabolo",
        "https://example.ph/the-road-is-open-to-every-vehicle",
        "https://example.ph/mabolo?note=Proceed+with+your+trip",
        "https://example.ph/mabolo-flood#Start-your-trip-now",
      ];
      fakeMeta({ search: [searchReply(closures(unopened.map((url) => ({ ...MABOLO, url }))), 11, undefined, ["https://example.ph/mabolo-flood?x=1", "https://example.ph/mabolo"])] });

      const web = await searchOnce(new MemoryKvStore());

      expect(web).toMatchObject({ state: "searched", findings: [] });
    });

    it("a link to a page the tool opened is kept without its fragment, whatever fragment either side gave", async () => {
      fakeMeta({ search: [searchReply(closures([{ ...MABOLO, url: "https://example.ph/mabolo-flood#Start-your-trip-now" }]), 11, undefined, ["https://example.ph/mabolo-flood#top"])] });

      const web = await searchOnce(new MemoryKvStore());

      expect(web.findings.map((f) => f.url)).toEqual(["https://example.ph/mabolo-flood"]);
    });

    it("a page the reply cites in a url_citation annotation counts as one the tool produced", async () => {
      const reply = searchReply(closures([MABOLO]), 11, undefined, []);
      const final = reply.output[reply.output.length - 1] as { content: { annotations: unknown[] }[] };
      final.content[0].annotations = [{ type: "url_citation", url: MABOLO.url, start_index: 0, end_index: 1 }];
      fakeMeta({ search: [reply] });

      expect((await searchOnce(new MemoryKvStore())).findings.map((f) => f.url)).toEqual([MABOLO.url]);
    });
  });

  it("a finding's kind must be one of the four, or it is dropped", async () => {
    const kinds = ["closed", "flooded", "not_passable", "other_blocking", "passable", "Closed", undefined, 3];
    fakeMeta({ search: [searchReply(closures(kinds.map((kind) => ({ ...MABOLO, kind }))))] });

    const web = await searchOnce(new MemoryKvStore());

    expect(web.findings.map((f) => [f.id, f.kind])).toEqual([["web-0", "closed"], ["web-1", "flooded"], ["web-2", "not_passable"], ["web-3", "other_blocking"]]);
  });

  it("a place must read as a place name: a sentence, a long text or odd characters drop the finding (review 🔴2)", async () => {
    const places = [
      "Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue",
      "Osmeña Blvd.",
      "The road is passable to all types of vehicles.",
      "Pwede na! Mabolo",
      "Mabolo: open",
      "a".repeat(81),
      "Go now the road is open and dry all the way to IT Park",
      "<b>Mabolo</b>",
    ];
    fakeMeta({ search: [searchReply(closures(places.map((place) => ({ ...MABOLO, place }))))] });

    const web = await searchOnce(new MemoryKvStore());

    expect(web.findings.map((f) => f.place)).toEqual(["Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue", "Osmeña Blvd."]);
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
    const again = await planWebSearch(store, now, roomy());
    expect(again).toMatchObject({ kind: "search" });
    await runWebSearch(again, { store, now, deadline: Date.now() + 40_000, meter: new Meter() });
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
    const down = () => Promise.reject(new Error("down"));
    const broken: KvStore = { get: down, set: down, setIfAbsent: down, deleteIfEquals: down, compareAndSet: down };

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

  it("a stored finding that fails today's checks, such as one kept with a free summary and no kind, is searched again", async () => {
    const store = new MemoryKvStore();
    const finding = { id: "web-0", place: "Juan Luna Ave, Mabolo", at: null, url: "https://example.ph/m", sourceDate: null, summary: "Passable to all types of vehicles." };
    const evidence = { state: "searched", searchedAt: NOW.toISOString(), findings: [finding] };
    const record = (findings: object[]) => JSON.stringify({ expiresAt: NOW.getTime() + 60_000, startedAt: NOW.getTime(), evidence: { ...evidence, findings }, pages: [finding.url] });
    await store.set(WEB_SEARCH_KEY, record([{ ...finding, summary: undefined, kind: "closed" }]), 60_000);
    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "cached" });

    await store.set(WEB_SEARCH_KEY, record([finding]), 60_000);
    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "search" });
  });

  it("a stored finding whose link isn't among the pages its search opened, or a record without them, is searched again (review 🔴T7-8)", async () => {
    const store = new MemoryKvStore();
    const finding = { id: "web-0", place: "Juan Luna Ave, Mabolo", at: null, url: "https://example.ph/m", sourceDate: null, kind: "closed" };
    const record = (extra: object) =>
      JSON.stringify({ expiresAt: NOW.getTime() + 60_000, startedAt: NOW.getTime(), evidence: { state: "searched", searchedAt: NOW.toISOString(), findings: [finding] }, ...extra });

    await store.set(WEB_SEARCH_KEY, record({ pages: ["https://example.ph/m"] }), 60_000);
    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "cached" });

    for (const extra of [{ pages: ["https://example.ph/other"] }, {}, { pages: "https://example.ph/m" }, { pages: ["https://example.ph/m#Start-your-trip-now"] }]) {
      await store.set(WEB_SEARCH_KEY, record(extra), 60_000);
      expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "search" });
      await store.deleteIfEquals(WEB_SEARCH_LEASE_KEY, (await store.get(WEB_SEARCH_LEASE_KEY))!);
    }
  });

  it("a search with links to Unicode paths is stored and read back from the cache, with no second search (review 🟡T7-9)", async () => {
    const accented = "https://example.ph/balita/baha-sa-Osmeña-Blvd";
    // 119 characters as the model writes it, 919 once percent-encoded: past the 500 limit only in its stored form.
    const thai = `https://example.ph/${"ข่าว".repeat(25)}`;
    let now = NOW;
    const store = new MemoryKvStore(() => now.getTime());
    const meta = fakeMeta({ search: [searchReply(closures([{ ...MABOLO, url: accented }, { ...MABOLO, url: thai }])), searchReply(closures([]))] });

    const first = await searchOnce(store, now);
    now = new Date(NOW.getTime() + 60_000);
    const second = await searchOnce(store, now);

    expect(first.findings.map((f) => f.url)).toEqual(["https://example.ph/balita/baha-sa-Osme%C3%B1a-Blvd"]);
    expect(second).toEqual(first);
    expect(meta.searchRequests).toHaveLength(1);
  });

  it("a stored record that can't be read is searched again", async () => {
    const store = new MemoryKvStore();
    await store.set(WEB_SEARCH_KEY, "{not json", 60_000);

    expect(await planWebSearch(store, NOW, roomy())).toMatchObject({ kind: "search" });
  });

  it("a search whose result can't be stored still answers this check", async () => {
    fakeMeta({ search: [searchReply(closures([MABOLO]))] });
    const down = () => Promise.reject(new Error("down"));
    const readOnly: KvStore = { get: async () => null, set: down, setIfAbsent: async () => true, deleteIfEquals: async () => {}, compareAndSet: down };

    expect(await searchOnce(readOnly)).toMatchObject({ state: "searched", findings: [{ id: "web-0" }] });
  });
});

const OLDER = closures([{ ...MABOLO, place: "Older Street" }]);
const NEWER = closures([{ ...MABOLO, place: "Newer Street" }]);
const stored = async (store: KvStore) => JSON.parse((await store.get(WEB_SEARCH_KEY))!).evidence;

/**
 * Two searches overlap past the lease: the older one's read of the stored result is held until the newer one has
 * searched and stored, then the older one writes. The older lease is given up as if it had lapsed, so this runs the
 * same against a store with a real clock.
 */
async function olderPausedWhileNewerStores(store: KvStore) {
  const later = new Date(NOW.getTime() + SEARCH_LEASE_MS);
  const older = await planWebSearch(store, NOW, roomy());
  if (older.kind !== "search") throw new Error(`the older check planned ${older.kind}`);
  await store.deleteIfEquals(WEB_SEARCH_LEASE_KEY, older.lease.token);
  const newer = await planWebSearch(store, later, roomy());
  expect(newer.kind).toBe("search");
  const realFetch = globalThis.fetch;
  const { fetchMock } = fakeMeta({ search: [searchReply(OLDER), searchReply(NEWER)] });
  // Meta is scripted; a real store's own requests still reach it.
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url) === META_RESPONSES_URL ? fetchMock(url, init) : realFetch(url, init)));

  let reached!: () => void;
  const atRead = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const pausing = new Proxy(store, {
    get(target, prop) {
      if (prop === "get") {
        return async (key: string) => {
          const value = await target.get(key);
          if (key === WEB_SEARCH_KEY && !paused) {
            paused = true;
            reached();
            await held;
          }
          return value;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const olderDone = runWebSearch(older, { store: pausing, now: NOW, deadline: Date.now() + 40_000, meter: new Meter() });
  await atRead;
  await runWebSearch(newer, { store, now: later, deadline: Date.now() + 40_000, meter: new Meter() });
  release();
  await olderDone;
}

describe("one search at a time, and the newest result kept (review 🟡3)", () => {
  const run = (plan: WebPlan, store: KvStore, now: Date) => runWebSearch(plan, { store, now, deadline: Date.now() + 40_000, meter: new Meter() });

  it("concurrent misses make one search: the others run without it and say why", async () => {
    expect(WEB_SEARCH_LEASE_KEY.startsWith("lusong:")).toBe(true);
    const store = new MemoryKvStore();
    const meta = fakeMeta({ search: [searchReply(closures([MABOLO]))] });

    const plans = await Promise.all([1, 2, 3].map(() => planWebSearch(store, NOW, roomy())));
    const results = await Promise.all(plans.map((plan) => run(plan, store, NOW)));

    expect(plans.map((p) => p.kind).sort()).toEqual(["off", "off", "search"]);
    expect(plans.filter((p) => p.kind === "off")).toEqual([
      { kind: "off", why: "another check is searching the web right now" },
      { kind: "off", why: "another check is searching the web right now" },
    ]);
    expect(meta.searchRequests).toHaveLength(1);
    expect(results.filter((r) => r.state === "searched")).toHaveLength(1);
  });

  it("the lease is given back when the search ends, failed or not, and when the check is refused", async () => {
    let now = NOW;
    const store = new MemoryKvStore(() => now.getTime());
    fakeMeta({ search: [searchReply("no JSON")] });

    await run(await planWebSearch(store, now, roomy()), store, now);
    expect(await store.get(WEB_SEARCH_LEASE_KEY)).toBeNull();

    now = new Date(NOW.getTime() + WEB_SEARCH_FAILED_CACHE_MS);
    const refused = await planWebSearch(store, now, roomy());
    expect(refused).toMatchObject({ kind: "search" });
    await releaseWebSearch(refused);
    expect(await store.get(WEB_SEARCH_LEASE_KEY)).toBeNull();
  });

  it("a search the cap refuses gives the lease back", async () => {
    const store = new MemoryKvStore();
    const spent = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 0.000_001, ipLimit: 1 });

    expect(await planWebSearch(store, NOW, spent)).toMatchObject({ kind: "off" });
    expect(await store.get(WEB_SEARCH_LEASE_KEY)).toBeNull();
  });

  it("the cache is read again once the lease is held: a search another check just stored is used, not repeated", async () => {
    const inner = new MemoryKvStore();
    const fresh = { expiresAt: NOW.getTime() + 60_000, startedAt: NOW.getTime(), evidence: { state: "searched", searchedAt: NOW.toISOString(), findings: [] }, pages: [] };
    let reads = 0;
    const store: KvStore = {
      get: async (key) => (key === WEB_SEARCH_KEY && reads++ === 0 ? null : key === WEB_SEARCH_KEY ? JSON.stringify(fresh) : inner.get(key)),
      set: (k, v, t) => inner.set(k, v, t),
      setIfAbsent: (k, v, t) => inner.setIfAbsent(k, v, t),
      deleteIfEquals: (k, v) => inner.deleteIfEquals(k, v),
      compareAndSet: (k, e, v, t) => inner.compareAndSet(k, e, v, t),
    };

    expect(await planWebSearch(store, NOW, roomy())).toEqual({ kind: "cached", evidence: fresh.evidence });
    expect(await inner.get(WEB_SEARCH_LEASE_KEY)).toBeNull();
  });

  it("a lease that can't be taken because the store fails means no search", async () => {
    const store = new MemoryKvStore();
    store.setIfAbsent = () => Promise.reject(new Error("down"));

    expect(await planWebSearch(store, NOW, roomy())).toEqual({ kind: "off", why: "store unreachable" });
  });

  describe(`a search still running after its ${SEARCH_LEASE_MS / 1000} s lease lapses`, () => {
    async function overlapping(first: "older" | "newer", older: string, newer: string) {
      let now = NOW;
      const store = new MemoryKvStore(() => now.getTime());
      const a = await planWebSearch(store, now, roomy());
      now = new Date(NOW.getTime() + SEARCH_LEASE_MS);
      const b = await planWebSearch(store, now, roomy());
      expect([a.kind, b.kind]).toEqual(["search", "search"]);
      const order = first === "newer" ? [newer, older] : [older, newer];
      fakeMeta({ search: order.map((text) => searchReply(text)) });
      if (first === "newer") {
        await run(b, store, new Date(NOW.getTime() + SEARCH_LEASE_MS));
        await run(a, store, NOW);
      } else {
        await run(a, store, NOW);
        await run(b, store, new Date(NOW.getTime() + SEARCH_LEASE_MS));
      }
      return store;
    }

    it("an older search that finishes last never replaces the newer result", async () => {
      const store = await overlapping("newer", OLDER, NEWER);
      expect((await stored(store)).findings.map((f: { place: string }) => f.place)).toEqual(["Newer Street"]);
    });

    it("an older failure that finishes last never replaces the newer success", async () => {
      const store = await overlapping("newer", "no JSON", NEWER);
      expect(await stored(store)).toMatchObject({ state: "searched", findings: [{ place: "Newer Street" }] });
    });

    it("a newer failure never replaces a success still fresh", async () => {
      const store = await overlapping("older", OLDER, "no JSON");
      expect(await stored(store)).toMatchObject({ state: "searched", findings: [{ place: "Older Street" }] });
    });

    it("a newer success replaces an older one", async () => {
      const store = await overlapping("older", OLDER, NEWER);
      expect((await stored(store)).findings.map((f: { place: string }) => f.place)).toEqual(["Newer Street"]);
    });

    it("an older search paused between reading the stored result and writing its own never replaces a newer one stored meanwhile (review 🟡T7-10)", async () => {
      const store = new MemoryKvStore();
      await olderPausedWhileNewerStores(store);
      expect((await stored(store)).findings.map((f: { place: string }) => f.place)).toEqual(["Newer Street"]);
    });
  });
});

describe("the Upstash store's lease commands", () => {
  function upstash(result: unknown) {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), Response.json({ result })));
    return { store: new UpstashKvStore("https://u.example", "t"), sent };
  }

  it("takes a lease with SET NX PX, held only when Redis says OK", async () => {
    const held = upstash("OK");
    expect(await held.store.setIfAbsent(WEB_SEARCH_LEASE_KEY, "token-1", 80_000)).toBe(true);
    expect(held.sent).toEqual([["SET", WEB_SEARCH_LEASE_KEY, "token-1", "NX", "PX", "80000"]]);
    vi.unstubAllGlobals();
    expect(await upstash(null).store.setIfAbsent(WEB_SEARCH_LEASE_KEY, "token-1", 80_000)).toBe(false);
  });

  it("gives a lease back only if it still holds the same token, in one script", async () => {
    const { store, sent } = upstash(1);
    await store.deleteIfEquals(WEB_SEARCH_LEASE_KEY, "token-1");
    expect(sent).toEqual([["EVAL", expect.stringContaining('redis.call("GET", KEYS[1]) == ARGV[1]'), "1", WEB_SEARCH_LEASE_KEY, "token-1"]]);
  });

  it("stores a search only over the value it read, in one script, set only when Redis says 1 (review 🟡T7-10)", async () => {
    const replaced = upstash(1);
    expect(await replaced.store.compareAndSet(WEB_SEARCH_KEY, '{"old":1}', '{"new":1}', 60_000)).toBe(true);
    expect(await replaced.store.compareAndSet(WEB_SEARCH_KEY, null, '{"new":1}', 60_000)).toBe(true);
    expect(replaced.sent).toEqual([
      ["EVAL", expect.stringContaining('redis.call("SET", KEYS[1], ARGV[3], "PX", ARGV[4])'), "1", WEB_SEARCH_KEY, "equals", '{"old":1}', '{"new":1}', "60000"],
      ["EVAL", expect.any(String), "1", WEB_SEARCH_KEY, "absent", "", '{"new":1}', "60000"],
    ]);
    vi.unstubAllGlobals();
    expect(await upstash(0).store.compareAndSet(WEB_SEARCH_KEY, null, '{"new":1}', 60_000)).toBe(false);
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

  it("sets a key only while it holds the value expected, or is absent when none is (review 🟡T7-10)", async () => {
    const store = new UpstashKvStore(upstashUrl!, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "", `lusong-test-${randomUUID()}`);
    expect(await store.compareAndSet(WEB_SEARCH_KEY, '{"a":1}', '{"b":1}', 60_000)).toBe(false);
    expect(await store.get(WEB_SEARCH_KEY)).toBeNull();
    expect(await store.compareAndSet(WEB_SEARCH_KEY, null, '{"a":1}', 60_000)).toBe(true);
    expect(await store.compareAndSet(WEB_SEARCH_KEY, null, '{"b":1}', 60_000)).toBe(false);
    expect(await store.compareAndSet(WEB_SEARCH_KEY, '{"b":1}', '{"c":1}', 60_000)).toBe(false);
    expect(await store.compareAndSet(WEB_SEARCH_KEY, '{"a":1}', '{"c":1}', 300)).toBe(true);
    expect(await store.get(WEB_SEARCH_KEY)).toBe('{"c":1}');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await store.get(WEB_SEARCH_KEY)).toBeNull();
  });

  it("an older search paused between its read and its write never replaces a newer one stored meanwhile (review 🟡T7-10)", async () => {
    const store = new UpstashKvStore(upstashUrl!, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "", `lusong-test-${randomUUID()}`);
    await olderPausedWhileNewerStores(store);
    expect((await stored(store)).findings.map((f: { place: string }) => f.place)).toEqual(["Newer Street"]);
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
