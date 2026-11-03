import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryAlertStore } from "./alerts";
import { createBudget, MemoryBudgetStore, UpstashBudgetStore, type BudgetStore, type SweepLedger } from "./budget";
import type { Meter } from "./meta";
import type { SafeFetchResult } from "./safe-fetch";
import {
  MemorySweepStore,
  PERSIST_RESERVE_MS,
  RIDER_FLOOR_MICROS,
  runSweep,
  SWEEP_DAILY_CAP_MICROS,
  SWEEP_GAP_MS,
  SWEEP_LIMITS,
  SWEEP_MAX_OUTPUT_TOKENS,
  SWEEP_MAX_TOOL_CALLS,
  SWEEP_RESERVE_MICROS,
  UpstashSweepStore,
  wonderCostMicros,
  type SweepDeps,
  type SweepStore,
} from "./sweep";

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";
const DAY = "2026-11-04";
const NOW = new Date("2026-11-04T02:00:00Z");
const BUDGET = 10_000_000;

const ledgers: [string, () => BudgetStore & SweepLedger][] = [
  ["memory ledger", () => new MemoryBudgetStore()],
  ...(upstashUrl ? [["Upstash ledger", () => new UpstashBudgetStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [string, () => BudgetStore & SweepLedger]] : []),
];

const sweepStores: [string, () => SweepStore][] = [
  ["memory sweep store", () => new MemorySweepStore()],
  ...(upstashUrl ? [["Upstash sweep store", () => new UpstashSweepStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [string, () => SweepStore]] : []),
];

const admitSweep = (ledger: SweepLedger) =>
  ledger.admitSweep({ id: randomUUID(), day: DAY, reserveMicros: SWEEP_RESERVE_MICROS, totalCapMicros: BUDGET - RIDER_FLOOR_MICROS, sweepCapMicros: SWEEP_DAILY_CAP_MICROS });

describe("the sweep's reserve (S4P-3)", () => {
  it("is 2 attempts × (4 searches + 20,000 input + 3,000 output tokens) at Wonder's rates: $0.30, four a day $1.20", () => {
    expect(SWEEP_RESERVE_MICROS).toBe(300_000);
    expect(4 * SWEEP_RESERVE_MICROS).toBeLessThanOrEqual(SWEEP_DAILY_CAP_MICROS);
  });

  it("Wonder calls are charged at Wonder's rate: the probe's 4,037 in, 1,551 out and 2 searches cost $0.052168", () => {
    expect(wonderCostMicros({ samImages: 0, museInputTokens: 4_037, museOutputTokens: 1_551, webSearchQueries: 2, transcribeSeconds: 0, complete: true })).toBe(
      4_037 * 4 + 1_551 * 20 + 2 * 2_500,
    );
  });
});

describe.each(ledgers)("the sweep's admission in the riders' day on the %s (ledger #6/#11)", (_name, make) => {
  it("is refused when it would leave less than $7.00 for riders", async () => {
    const store = make();
    const riders = createBudget({ store, budgetUsd: 10, ipLimit: 100 });
    const rider = await riders.admit(null, NOW, 2_800_000);
    expect(rider.ok).toBe(true);
    // $2.80 + $0.30 > $3.00.
    expect(await admitSweep(store)).toBe("budget");
  });

  it("a rider admitted after a sweep still finds the rest of the day's budget", async () => {
    const store = make();
    const riders = createBudget({ store, budgetUsd: 10, ipLimit: 100 });
    await riders.admit(null, NOW, 2_700_000);
    expect(await admitSweep(store)).toBe("admitted");
    // $3.00 taken; the riders' $7.00 is all there, and no more.
    expect((await riders.admit(null, NOW, RIDER_FLOOR_MICROS)).ok).toBe(true);
    expect(await riders.admit(null, NOW, 1)).toEqual({ ok: false, reason: "budget" });
  });

  it("is refused past $1.50 of the day's sweep spend, counting what settlement charged above the reserve", async () => {
    const store = make();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      ids.push(id);
      expect(await store.admitSweep({ id, day: DAY, reserveMicros: SWEEP_RESERVE_MICROS, totalCapMicros: 3_000_000, sweepCapMicros: SWEEP_DAILY_CAP_MICROS })).toBe("admitted");
      // A reply over the input bound is still charged in full: $0.65 against a $0.30 reserve.
      expect(await store.settleSweep({ id, day: DAY, chargeMicros: 650_000 })).toBe(true);
    }
    // $1.30 spent: one more reserve would make $1.60.
    expect(await admitSweep(store)).toBe("sweep");
    expect(await store.settleSweep({ id: ids[0], day: DAY, chargeMicros: 1 })).toBe(false);
  });

  it("a rider's settle can't close a sweep's reservation, nor a sweep's settle a rider's", async () => {
    const store = make();
    const id = randomUUID();
    await store.admitSweep({ id, day: DAY, reserveMicros: SWEEP_RESERVE_MICROS, totalCapMicros: 3_000_000, sweepCapMicros: SWEEP_DAILY_CAP_MICROS });
    expect(await store.settle({ id, day: DAY, chargeMicros: 0 })).toBe(false);
    const riders = createBudget({ store, budgetUsd: 10, ipLimit: 100 });
    const rider = await riders.admit(null, NOW, 1_000);
    if (!rider.ok) throw new Error("admitted");
    expect(await store.settleSweep({ id: rider.id, day: DAY, chargeMicros: 0 })).toBe(false);
  });
});

describe.each(sweepStores)("the day's sweep slots on the %s (S4P-3)", (_name, make) => {
  it("at most 4 a UTC day, at least 3 hours apart", async () => {
    const store = make();
    const t0 = Date.parse("2026-11-04T00:00:00Z");
    expect(await store.claimSlot(DAY, t0, SWEEP_GAP_MS, 4)).toBe(1);
    expect(await store.claimSlot(DAY, t0 + SWEEP_GAP_MS - 1, SWEEP_GAP_MS, 4)).toBeNull();
    expect(await store.claimSlot(DAY, t0 + SWEEP_GAP_MS, SWEEP_GAP_MS, 4)).toBe(2);
    expect(await store.claimSlot(DAY, t0 + 2 * SWEEP_GAP_MS, SWEEP_GAP_MS, 4)).toBe(3);
    expect(await store.claimSlot(DAY, t0 + 3 * SWEEP_GAP_MS, SWEEP_GAP_MS, 4)).toBe(4);
    expect(await store.claimSlot(DAY, t0 + 4 * SWEEP_GAP_MS, SWEEP_GAP_MS, 4)).toBeNull();
  });

  it("two invocations racing for one slot: only one gets it", async () => {
    const store = make();
    const t0 = Date.parse("2026-11-04T00:00:00Z");
    const got = await Promise.all([store.claimSlot(DAY, t0, SWEEP_GAP_MS, 4), store.claimSlot(DAY, t0, SWEEP_GAP_MS, 4)]);
    expect(got.filter((n) => n !== null)).toHaveLength(1);
  });

  it("keeps a run's candidates and what was decided for each", async () => {
    const store = make();
    await store.saveCandidates("r1", [CANDIDATE, { ...CANDIDATE, place: "Colon Street" }]);
    await store.markCandidate("r1", 0, "admitted");
    expect(await store.openRun()).toEqual({ run: "r1", candidates: [{ ...CANDIDATE, done: "admitted" }, { ...CANDIDATE, place: "Colon Street" }] });
    await store.closeRun("r1");
    expect(await store.openRun()).toBeNull();
  });
});

describe.skipIf(!upstashUrl)("the candidates' write on Upstash (S4D-5)", () => {
  it("is one atomic call: the candidates and the open-run pointer together", async () => {
    const store = new UpstashSweepStore(upstashUrl!, upstashToken, `lusong-test-${randomUUID()}`);
    const real = globalThis.fetch;
    let calls = 0;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return real(...args);
    });
    try {
      await store.saveCandidates("r1", [CANDIDATE, { ...CANDIDATE, place: "Colon Street" }]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toBe(1);
    expect(await store.openRun()).toEqual({ run: "r1", candidates: [CANDIDATE, { ...CANDIDATE, place: "Colon Street" }] });
  });
});

const URL_GOV = "https://mandauecity.gov.ph/advisories/fortuna";
const CANDIDATE = { url: URL_GOV, place: "A.S. Fortuna Street", province: "Cebu", kind: "closure" as const };
const PAGE = `<html><head><meta property="article:published_time" content="2026-11-04T09:30:00+08:00"></head><body>A.S. Fortuna Street in Mandaue City, Cebu is closed to traffic due to flooding.</body></html>`;

/** A Responses-API reply shaped like the saved S4P-3 Wonder probe (probes/s4/max-tool-calls-3-wonder.json): its item kinds and usage. */
function wonderReply(items: unknown[], searches = 2, usage = { input_tokens: 4_037, output_tokens: 1_551 }) {
  return {
    id: "resp_sweep",
    status: "completed",
    max_tool_calls: SWEEP_MAX_TOOL_CALLS,
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", phase: "commentary", content: [{ type: "output_text", text: "Searching for road closures.", annotations: [] }] },
      ...Array.from({ length: searches }, (_, i) => ({ type: "web_search_call", status: "completed", action: { type: "search", query: `q${i}` } })),
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ items }), annotations: [] }] },
    ],
    usage: { ...usage, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1_000 }, total_tokens: usage.input_tokens + usage.output_tokens },
  };
}

function sweepHarness(reply: unknown = wonderReply([{ ...CANDIDATE, organisation: "Model's own name", event_date: "2026-10-01" }])) {
  const ledger = new MemoryBudgetStore();
  const sweeps = new MemorySweepStore(() => NOW.getTime());
  const alerts = new MemoryAlertStore();
  const calls: Record<string, unknown>[] = [];
  const fetched: string[] = [];
  const deps: SweepDeps = {
    sweeps,
    alerts,
    ledger,
    budgetMicros: BUDGET,
    wonder: async (body, _attemptMs, _deadline, meter: Meter) => {
      calls.push(body);
      meter.reply("spark-responses", reply);
      return reply;
    },
    admit: {
      fetchPage: async (url): Promise<SafeFetchResult> => {
        fetched.push(url);
        return url === URL_GOV ? { ok: true, url, status: 200, contentType: "text/html", body: PAGE } : { ok: true, url, status: 404, contentType: "text/html", body: "" };
      },
      geocode: async () => ({ status: "ok", places: [{ id: "osm:1", name: "A. S. Fortuna Street", area: "Mandaue", lat: 10.338, lon: 123.918, source: "osm", feature: { key: "highway", type: "street" } }] }),
    },
    now: () => NOW,
    enabled: true,
  };
  return { ledger, sweeps, alerts, calls, fetched, deps, sweep: (more: Partial<SweepDeps> = {}) => runSweep({ ...deps, ...more }) };
}

describe("one sweep (S4P-3, S4P-8; no paid call: Wonder is stubbed)", () => {
  it("asks Wonder once with web search capped at 4 tool calls and 3,000 output tokens, charges Wonder's rate, and admits what the page supports", async () => {
    const h = sweepHarness();
    const summary = await h.sweep();
    expect(summary).toMatchObject({ ok: true, discovery: "ran", slot: 1, candidates: 1, admitted: 1, refused: 0, left: 0, chargedMicros: 4_037 * 4 + 1_551 * 20 + 2 * 2_500 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ model: "muse-wonder-1.0", tools: [{ type: "web_search" }], max_tool_calls: 4, max_output_tokens: SWEEP_MAX_OUTPUT_TOKENS });
    expect(h.ledger.spentOn(DAY)).toEqual({ total: 52_168, sweep: 52_168 });
    const [alert] = await h.alerts.all(NOW.getTime());
    expect(alert).toMatchObject({ origin: "sweep", severity: "warn", sourceOrg: "the Mandaue City government" });
    expect(JSON.stringify(alert)).not.toMatch(/Model's own name|2026-10-01/);
  });

  it("a reply carrying more tool calls than the cap is dropped whole, and still charged", async () => {
    const h = sweepHarness(wonderReply([CANDIDATE], 5));
    expect(await h.sweep()).toMatchObject({ ok: false, discovery: "failed", candidates: 0, admitted: 0 });
    expect(h.fetched).toEqual([]);
    expect(h.ledger.spentOn(DAY).sweep).toBe(4_037 * 4 + 1_551 * 20 + 5 * 2_500);
  });

  it("a failed Wonder call keeps its whole reservation charged", async () => {
    const h = sweepHarness();
    const summary = await h.sweep({
      wonder: async (_body, _a, _d, meter) => {
        meter.failedAttempt();
        throw new Error("HTTP 500");
      },
    });
    expect(summary).toMatchObject({ ok: false, discovery: "failed", chargedMicros: SWEEP_RESERVE_MICROS });
    expect(h.ledger.spentOn(DAY).sweep).toBe(SWEEP_RESERVE_MICROS);
  });

  it("the next invocation within 3 hours makes no Wonder call; the fifth slot of a day is never claimed", async () => {
    const h = sweepHarness();
    await h.sweep();
    expect(await h.sweep()).toMatchObject({ discovery: "not_due" });
    expect(h.calls).toHaveLength(1);
  });

  it("is refused when the riders' $7.00 would be touched, with no Wonder call", async () => {
    const h = sweepHarness();
    const riders = createBudget({ store: h.ledger, budgetUsd: 10, ipLimit: 100 });
    await riders.admit(null, NOW, 2_900_000);
    expect(await h.sweep()).toMatchObject({ discovery: "budget" });
    expect(h.calls).toEqual([]);
  });

  it("switched off (LUSONG_SWEEP unset), no Wonder call is made", async () => {
    const h = sweepHarness();
    expect(await h.sweep({ enabled: false })).toMatchObject({ discovery: "off" });
    expect(h.calls).toEqual([]);
  });

  it("candidates survive a cut-off invocation: the next one admits them without asking Wonder again", async () => {
    const h = sweepHarness(wonderReply([CANDIDATE, { ...CANDIDATE, url: "https://mandauecity.gov.ph/advisories/other" }]));
    // No time is left for admission after discovery.
    expect(await h.sweep({ limits: { budgetMs: PERSIST_RESERVE_MS + 500, wonderAttemptMs: 0, minAdmitMs: 5_000 } })).toMatchObject({ discovery: "ran", admitted: 0, left: 2 });
    expect(await h.sweep()).toMatchObject({ discovery: "continued", admitted: 1, refused: 1, left: 0 });
    expect(h.calls).toHaveLength(1);
    // Every candidate decided: the next invocation is a new discovery, which isn't due yet.
    expect(await h.sweep()).toMatchObject({ discovery: "not_due" });
  });

  it("a late Wonder reply and 5 s store answers still finish under 60 s, the candidates kept for the next invocation (S4D-5)", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const h = sweepHarness(wonderReply([CANDIDATE, { ...CANDIDATE, url: "https://mandauecity.gov.ph/advisories/other" }]));
      let slow = false;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const slowly = <T extends object>(store: T): T =>
        new Proxy(store, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              if (slow) await wait(5_000);
              return value.apply(target, args);
            };
          },
        });
      const wonder: SweepDeps["wonder"] = async (body, attemptMs, deadline, meter) => {
        // The reply lands as late as the call allows; every store answer after it takes 5 s.
        await wait(Math.min(attemptMs, deadline - Date.now()));
        slow = true;
        return h.deps.wonder(body, attemptMs, deadline, meter);
      };
      const started = Date.now();
      const running = h.sweep({ wonder, ledger: slowly(h.ledger), sweeps: slowly(h.sweeps) });
      await vi.runAllTimersAsync();
      const summary = await running;
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(Date.now() - started).toBeLessThanOrEqual(SWEEP_LIMITS.budgetMs);
      expect(summary).toMatchObject({ discovery: "ran", admitted: 0 });
      slow = false;
      const next = h.sweep();
      await vi.runAllTimersAsync();
      expect(await next).toMatchObject({ discovery: "continued", admitted: 1, refused: 1, left: 0 });
      expect(h.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a model reply that isn't the schema yields no candidates and fetches nothing", async () => {
    const h = sweepHarness({ ...wonderReply([]), output: [{ type: "message", content: [{ type: "output_text", text: "Here are some closures: Fortuna Street.", annotations: [] }] }] });
    expect(await h.sweep()).toMatchObject({ discovery: "ran", candidates: 0 });
    expect(h.fetched).toEqual([]);
  });
});
