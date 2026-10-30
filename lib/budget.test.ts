import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  budgetFromEnv,
  costMicros,
  createBudget,
  MemoryBudgetStore,
  MUSE_INPUT_TOKEN_BOUND,
  UpstashBudgetStore,
  RESERVE_MICROS,
  type Admitted,
  type BudgetStore,
  type MeteredUsage,
} from "./budget";
import { MUSE_MAX_COMPLETION_TOKENS } from "./readings";

const NOON = new Date("2026-11-05T04:00:00Z");
const R = RESERVE_MICROS;
/** Three SAM images and no Muse call: $0.0075. */
const THREE_SAM_IMAGES: MeteredUsage = { samImages: 3, museInputTokens: 0, museOutputTokens: 0, webSearchQueries: 0, transcribeSeconds: 0, complete: true };
/** A settle that refunds the whole reservation, so a second refund shows up as room for one more check. */
const NOTHING_SPENT: MeteredUsage = { samImages: 0, museInputTokens: 0, museOutputTokens: 0, webSearchQueries: 0, transcribeSeconds: 0, complete: true };

function admitted(a: Awaited<ReturnType<ReturnType<typeof createBudget>["admit"]>>): Admitted {
  if (!a.ok) throw new Error(`expected an admission, got ${a.reason}`);
  return a;
}

/** The real store runs against Redis behind serverless-redis-http (Upstash's REST API), when one is up. */
const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";
const stores: [string, () => BudgetStore][] = [
  ["memory store", () => new MemoryBudgetStore()],
  ...(upstashUrl
    ? [["Upstash store", () => new UpstashBudgetStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [
        string,
        () => BudgetStore,
      ]]
    : []),
];

describe.each(stores)("%s", (_name, makeStore) => {
  function budgetFor(reservations: number, ipLimit = 10) {
    return budgetOfMicros(reservations * R + R - 1, ipLimit);
  }

  function budgetOfMicros(micros: number, ipLimit = 10) {
    return createBudget({ store: makeStore(), budgetUsd: micros / 1e6, ipLimit });
  }

  it("concurrent admissions never exceed the budget", async () => {
    const budget = budgetFor(10);
    const admissions = await Promise.all(
      Array.from({ length: 50 }, (_, i) => budget.admit(`203.0.113.${i}`, NOON)),
    );
    expect(admissions.filter((a) => a.ok)).toHaveLength(10);
    expect(admissions.filter((a) => !a.ok).every((a) => !a.ok && a.reason === "budget")).toBe(true);
  });

  it("refuses the eleventh check from one IP without touching the budget", async () => {
    const budget = budgetFor(12, 10);
    for (let i = 0; i < 10; i++) expect((await budget.admit("198.51.100.7", NOON)).ok).toBe(true);
    expect(await budget.admit("198.51.100.7", NOON)).toEqual({ ok: false, reason: "ip" });
    expect((await budget.admit("198.51.100.8", NOON)).ok).toBe(true);
    expect((await budget.admit("198.51.100.9", NOON)).ok).toBe(true);
    expect(await budget.admit("198.51.100.10", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("a run with no client address is held to the daily cap but not to any address's limit", async () => {
    const budget = budgetFor(4, 1);
    expect((await budget.admit(null, NOON)).ok).toBe(true);
    expect((await budget.admit(null, NOON)).ok).toBe(true);
    expect((await budget.admit("192.0.2.1", NOON)).ok).toBe(true);
    expect(await budget.admit("192.0.2.1", NOON)).toEqual({ ok: false, reason: "ip" });
    expect((await budget.admit(null, NOON)).ok).toBe(true);
    expect(await budget.admit(null, NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("a reservation that is not a positive whole number of µ$ is refused and changes nothing", async () => {
    const budget = budgetFor(1, 1);
    for (const reserve of [-R, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await budget.admit("192.0.2.1", NOON, reserve)).toEqual({ ok: false, reason: "unavailable" });
      expect(await budget.admit(null, NOON, reserve)).toEqual({ ok: false, reason: "unavailable" });
    }
    expect((await budget.admit("192.0.2.1", NOON)).ok).toBe(true);
    expect(await budget.admit("192.0.2.2", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("the store skips the address check when there is no address", async () => {
    const store = makeStore();
    const admit = (id: string) =>
      store.admit({ id, day: "2026-11-05", ipKey: null, reserveMicros: R, budgetMicros: 2 * R, ipLimit: 0 });
    expect(await admit("first")).toBe("admitted");
    expect(await admit("second")).toBe("admitted");
    expect(await admit("third")).toBe("budget");
  });

  it("a budget refusal does not use up the IP's checks", async () => {
    const budget = budgetOfMicros(R, 2);
    const first = admitted(await budget.admit("192.0.2.1", NOON));
    for (let i = 0; i < 3; i++) expect(await budget.admit("192.0.2.2", NOON)).toEqual({ ok: false, reason: "budget" });
    await budget.settle(first, NOTHING_SPENT, true);
    expect((await budget.admit("192.0.2.2", NOON)).ok).toBe(true);
  });

  it("a complete usage refunds the reservation down to the actual cost", async () => {
    const budget = budgetOfMicros(R + 7_500);
    await budget.settle(admitted(await budget.admit("192.0.2.1", NOON)), THREE_SAM_IMAGES, true);
    expect((await budget.admit("192.0.2.2", NOON)).ok).toBe(true);
    expect(await budget.admit("192.0.2.3", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("an admitted request whose upstream fails keeps its reservation", async () => {
    const budget = budgetOfMicros(R + 7_500);
    await budget.settle(admitted(await budget.admit("192.0.2.1", NOON)), THREE_SAM_IMAGES, false);
    expect(await budget.admit("192.0.2.2", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("a usage record marked incomplete (a retried or unmetered call) refunds nothing", async () => {
    const budget = budgetOfMicros(R + 7_500);
    await budget.settle(admitted(await budget.admit("192.0.2.1", NOON)), { ...THREE_SAM_IMAGES, complete: false }, true);
    expect(await budget.admit("192.0.2.2", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("settling one reservation twice refunds once", async () => {
    const budget = budgetOfMicros(R + 7_500);
    const first = admitted(await budget.admit("192.0.2.1", NOON));
    await budget.settle(first, NOTHING_SPENT, true);
    await budget.settle(first, NOTHING_SPENT, true);
    expect((await budget.admit("192.0.2.2", NOON)).ok).toBe(true);
    expect(await budget.admit("192.0.2.3", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("concurrent settles of one reservation refund once", async () => {
    const budget = budgetOfMicros(R + 7_500);
    const first = admitted(await budget.admit("192.0.2.1", NOON));
    await Promise.all(Array.from({ length: 5 }, () => budget.settle(first, NOTHING_SPENT, true)));
    expect((await budget.admit("192.0.2.2", NOON)).ok).toBe(true);
    expect(await budget.admit("192.0.2.3", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("an overrun is charged, not ignored", async () => {
    const overrun: MeteredUsage = { samImages: 3, museInputTokens: 80_000, museOutputTokens: 5_000, webSearchQueries: 0, transcribeSeconds: 0, complete: true };
    const overrunMicros = 3 * 2_500 + 80_000 * 1.25 + 5_000 * 4.25;
    expect(overrunMicros).toBeGreaterThan(R);
    const budget = budgetOfMicros(overrunMicros + R - 1);
    await budget.settle(admitted(await budget.admit("192.0.2.1", NOON)), overrun, true);
    expect(await budget.admit("192.0.2.2", NOON)).toEqual({ ok: false, reason: "budget" });
  });

  it("a settle naming another day changes nothing", async () => {
    const store = makeStore();
    const admit = (id: string) =>
      store.admit({ id, day: "2026-11-05", ipKey: id, reserveMicros: R, budgetMicros: R + 7_500, ipLimit: 10 });
    expect(await admit("first")).toBe("admitted");
    expect(await store.settle({ id: "first", day: "2026-11-06", chargeMicros: 0 })).toBe(false);
    expect(await admit("second")).toBe("budget");
    expect(await store.settle({ id: "first", day: "2026-11-05", chargeMicros: 0 })).toBe(true);
    expect(await admit("third")).toBe("admitted");
  });

  it("a refund after midnight goes back to the day it was reserved on", async () => {
    const budget = budgetOfMicros(R + 7_500);
    const lateNight = new Date("2026-11-05T23:59:59Z");
    await budget.settle(admitted(await budget.admit("192.0.2.1", lateNight)), THREE_SAM_IMAGES, true);
    expect((await budget.admit("192.0.2.2", lateNight)).ok).toBe(true);
    expect(await budget.admit("192.0.2.3", lateNight)).toEqual({ ok: false, reason: "budget" });
    expect((await budget.admit("192.0.2.3", new Date("2026-11-06T00:00:01Z"))).ok).toBe(true);
  });
});

describe.skipIf(!upstashUrl)("the Upstash store's keys", () => {
  async function keysMatching(pattern: string): Promise<string[]> {
    const res = await fetch(upstashUrl!, {
      method: "POST",
      headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(["KEYS", pattern]),
    });
    return ((await res.json()) as { result: string[] }).result;
  }

  it("a run with no client address creates no per-address counter", async () => {
    const prefix = `lusong-test-${randomUUID()}`;
    const budget = createBudget({ store: new UpstashBudgetStore(upstashUrl!, upstashToken, prefix), budgetUsd: (3 * R) / 1e6, ipLimit: 10 });
    expect((await budget.admit(null, NOON)).ok).toBe(true);
    expect(await keysMatching(`${prefix}:ip:*`)).toEqual([]);
    expect(await keysMatching(`${prefix}:spent:*`)).toHaveLength(1);
    expect((await budget.admit("192.0.2.1", NOON)).ok).toBe(true);
    expect(await keysMatching(`${prefix}:ip:*`)).toHaveLength(1);
  });
});

describe("the reservation", () => {
  it("covers every attempt at the input bound", async () => {
    const everyAttempt: MeteredUsage = {
      samImages: 8,
      museInputTokens: 2 * MUSE_INPUT_TOKEN_BOUND,
      museOutputTokens: 2 * MUSE_MAX_COMPLETION_TOKENS,
      webSearchQueries: 0,
      transcribeSeconds: 0,
      complete: true,
    };
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: (2 * R) / 1e6, ipLimit: 10 });
    await budget.settle(admitted(await budget.admit("192.0.2.1", NOON)), everyAttempt, true);
    expect((await budget.admit("192.0.2.2", NOON)).ok).toBe(true);
  });
});

describe("the price of each operation (dev.meta.ai/docs/pricing-rate-limits, 2026-10-30)", () => {
  it("Voice Transcribe costs $0.18 per hour of audio: an hour is 180,000 µ$, 30 s is 1,500 µ$", () => {
    const audio = (transcribeSeconds: number): MeteredUsage => ({ samImages: 0, museInputTokens: 0, museOutputTokens: 0, webSearchQueries: 0, transcribeSeconds, complete: true });
    expect(costMicros(audio(3_600))).toBe(180_000);
    expect(costMicros(audio(30))).toBe(1_500);
  });
});

describe("configuration fails closed", () => {
  const someone = "192.0.2.1";

  it("memory mode in a deployment refuses checks", async () => {
    for (const env of [
      { LUSONG_BUDGET_STORE: "memory", VERCEL: "1" },
      { LUSONG_BUDGET_STORE: "memory", NODE_ENV: "production" },
    ]) {
      expect(await budgetFromEnv(env).admit(someone, NOON)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("no store configured refuses checks", async () => {
    expect(await budgetFromEnv({ NODE_ENV: "test" }).admit(someone, NOON)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("an unreadable budget refuses checks", async () => {
    const env = { LUSONG_BUDGET_STORE: "memory", NODE_ENV: "development", DAILY_BUDGET_USD: "ten" };
    expect(await budgetFromEnv(env).admit(someone, NOON)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("the KV_REST_API_* names that Vercel's Upstash integration sets configure the store", async () => {
    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("Authorization") ?? "" });
      return Response.json({ result: "admitted" });
    });
    try {
      const env = { NODE_ENV: "production", VERCEL: "1", KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-token" };
      expect((await budgetFromEnv(env).admit(someone, NOON)).ok).toBe(true);
      expect(calls).toEqual([{ url: "https://kv.example", auth: "Bearer kv-token" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("memory mode in local development admits", async () => {
    const env = { LUSONG_BUDGET_STORE: "memory", NODE_ENV: "development" };
    expect((await budgetFromEnv(env).admit(someone, NOON)).ok).toBe(true);
  });

  it("a store that throws on admit refuses the check", async () => {
    const broken: BudgetStore = {
      admit: () => Promise.reject(new Error("ECONNREFUSED")),
      settle: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const budget = createBudget({ store: broken, budgetUsd: 10, ipLimit: 10 });
    expect(await budget.admit(someone, NOON)).toEqual({ ok: false, reason: "unavailable" });
  });
});

