import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REPORT_LIFETIME_MS } from "./answer";
import {
  MemoryReportStore,
  PHOTO_CLAIM_MS,
  REPORT_TTL_MARGIN_MS,
  REPORT_TTL_MS,
  reportStoreFromEnv,
  UpstashReportStore,
  type ReportStore,
  type StoredReport,
} from "./report-store";

const T0 = new Date("2026-10-30T00:00:00Z");

function report(overrides: Partial<StoredReport> = {}): StoredReport {
  return {
    id: randomUUID(),
    kind: "photo",
    at: { lat: 10.338566, lon: 123.911461 },
    wayId: 1116002958,
    place: "Governor M. Cuenco Avenue",
    receivedAt: T0.toISOString(),
    capturedAt: "2026-10-29T23:40:00.000Z",
    verdict: { kind: "no_flood" },
    photoHash: randomUUID().replaceAll("-", ""),
    ...overrides,
  };
}

/** A clock the memory store reads, so expiry can be stepped through without waiting. */
function steppedClock(start = T0.getTime()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

async function upstash(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(upstashUrl!, {
    method: "POST",
    headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
  });
  return ((await res.json()) as { result: unknown }).result;
}

const stores: [string, () => ReportStore][] = [
  ["memory store", () => new MemoryReportStore()],
  ...(upstashUrl
    ? [["Upstash store", () => new UpstashReportStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [
        string,
        () => ReportStore,
      ]]
    : []),
];

describe.each(stores)("%s", (_name, makeStore) => {
  it("a saved report is read back as it was saved", async () => {
    const store = makeStore();
    const saved = report();
    await store.save(saved);
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([saved]);
  });

  it("a report 3 h old is not read back, though its record outlives it by the margin", async () => {
    const store = makeStore();
    await store.save(report());
    expect(await store.recent(new Date(T0.getTime() + REPORT_LIFETIME_MS - 1))).toHaveLength(1);
    expect(await store.recent(new Date(T0.getTime() + REPORT_LIFETIME_MS))).toEqual([]);
  });

  it("a photo is claimed once; a second claim while it is read is told it is in flight", async () => {
    const store = makeStore();
    expect(await store.claimPhoto("abc")).toEqual({ state: "claimed" });
    expect(await store.claimPhoto("abc")).toEqual({ state: "in_flight" });
    expect(await store.claimPhoto("def")).toEqual({ state: "claimed" });
  });

  it("once its report is saved, the same photo is a duplicate of that report", async () => {
    const store = makeStore();
    const saved = report({ photoHash: "abc" });
    expect(await store.claimPhoto("abc")).toEqual({ state: "claimed" });
    await store.save(saved);
    expect(await store.claimPhoto("abc")).toEqual({ state: "duplicate", report: saved });
    await store.releasePhoto("abc");
    expect(await store.claimPhoto("abc")).toEqual({ state: "duplicate", report: saved });
  });

  it("a released claim lets the photo be sent again", async () => {
    const store = makeStore();
    await store.claimPhoto("abc");
    await store.releasePhoto("abc");
    expect(await store.claimPhoto("abc")).toEqual({ state: "claimed" });
  });
});

describe("expiry in the memory store (🟡P15)", () => {
  it("the record, the index and the photo's hash all go at 3 h plus the margin, not before", async () => {
    const clock = steppedClock();
    const store = new MemoryReportStore({ now: clock.now });
    await store.claimPhoto("abc");
    const saved = report({ photoHash: "abc" });
    await store.save(saved);
    clock.advance(REPORT_TTL_MS - 1);
    expect(store.keys().sort()).toEqual([`lusong:report:${saved.id}`, "lusong:report-photo:abc", "lusong:reports"].sort());
    clock.advance(1);
    expect(store.keys()).toEqual([]);
    expect(await store.claimPhoto("abc")).toEqual({ state: "claimed" });
  });

  it("an unfinished claim lapses, so a read that died mid-way doesn't hold the photo for 3 h", async () => {
    const clock = steppedClock();
    const store = new MemoryReportStore({ now: clock.now });
    await store.claimPhoto("abc");
    clock.advance(PHOTO_CLAIM_MS);
    expect(await store.claimPhoto("abc")).toEqual({ state: "claimed" });
  });

  it("the margin is named and positive", () => {
    expect(REPORT_TTL_MS).toBe(REPORT_LIFETIME_MS + REPORT_TTL_MARGIN_MS);
    expect(REPORT_TTL_MARGIN_MS).toBeGreaterThan(0);
  });
});

describe.runIf(upstashUrl)("expiry on the Upstash stand-in (🟡P15)", () => {
  it("the record, the index and the photo's hash carry one expiry and are gone after it", async () => {
    const prefix = `lusong-test-${randomUUID()}`;
    const ttlMs = 1_200;
    const store = new UpstashReportStore(upstashUrl!, upstashToken, prefix, { ttlMs });
    const saved = report({ photoHash: "abc", receivedAt: new Date().toISOString() });
    await store.claimPhoto("abc");
    await store.save(saved);
    const keys = [`${prefix}:report:${saved.id}`, `${prefix}:report-photo:abc`, `${prefix}:reports`];
    const ttls = (await Promise.all(keys.map((k) => upstash(["PTTL", k])))) as number[];
    for (const ttl of ttls) expect(ttl).toBeGreaterThan(ttlMs - 300);
    for (const ttl of ttls) expect(ttl).toBeLessThanOrEqual(ttlMs);
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 200));
    expect(await Promise.all(keys.map((k) => upstash(["EXISTS", k])))).toEqual([0, 0, 0]);
    expect(await store.recent(new Date())).toEqual([]);
  });
});

describe("which store", () => {
  it("the memory store is never chosen in a deployment", () => {
    expect(reportStoreFromEnv({ LUSONG_BUDGET_STORE: "memory", VERCEL: "1" })).toBeNull();
    expect(reportStoreFromEnv({ LUSONG_BUDGET_STORE: "memory", NODE_ENV: "production" })).toBeNull();
    expect(reportStoreFromEnv({ LUSONG_BUDGET_STORE: "memory" })).toBeInstanceOf(MemoryReportStore);
  });

  it("reports live in the same Upstash database as the budget, under the same variables", () => {
    expect(reportStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeInstanceOf(UpstashReportStore);
    expect(reportStoreFromEnv({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" })).toBeInstanceOf(UpstashReportStore);
    expect(reportStoreFromEnv({})).toBeNull();
  });
});
