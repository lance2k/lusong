import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REPORT_LIFETIME_MS } from "./answer";
import { seedReport } from "../test/seed-report";
import {
  MemoryReportStore,
  PHOTO_CLAIM_MS,
  REPORT_TTL_MARGIN_MS,
  REPORT_TTL_MS,
  reportStoreFromEnv,
  toReport,
  UpstashReportStore,
  type ReportStore,
  type StoredPhotoReport,
  type StoredVoiceReport,
} from "./report-store";

const T0 = new Date("2026-10-30T00:00:00Z");

function report(overrides: Partial<StoredPhotoReport> = {}): StoredPhotoReport {
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

function voiceReport(overrides: Partial<StoredVoiceReport> = {}): StoredVoiceReport {
  return {
    id: randomUUID(),
    kind: "voice",
    at: { lat: 10.338566, lon: 123.911461 },
    wayId: 1116002958,
    place: "Governor M. Cuenco Avenue",
    receivedAt: T0.toISOString(),
    claim: { place: "Cuenco", depth: "knee_or_deeper", passable: "no" },
    audioHash: randomUUID().replaceAll("-", ""),
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

/** A store, and how many entries its index holds: a second entry for one note is what the duplicate guard prevents. */
type Made = { store: ReportStore; indexEntries: () => Promise<number> };

const stores: [string, (opts?: { claimMs?: number }) => Made][] = [
  [
    "memory store",
    (opts) => {
      const store = new MemoryReportStore(opts);
      return { store, indexEntries: async () => (store.dump()["lusong:reports"] ?? []).length };
    },
  ],
  ...(upstashUrl
    ? [
        [
          "Upstash store",
          (opts?: { claimMs?: number }) => {
            const prefix = `lusong-test-${randomUUID()}`;
            return {
              store: new UpstashReportStore(upstashUrl, upstashToken, prefix, { now: () => T0.getTime(), ...opts }),
              indexEntries: async () => Number(await upstash(["ZCARD", `${prefix}:reports`])),
            };
          },
        ] as [string, (opts?: { claimMs?: number }) => Made],
      ]
    : []),
];

const CLAIMED = { state: "claimed", token: expect.any(String) };

/** The claim's token, failing the test if the note couldn't be claimed. */
async function owned(claiming: Promise<{ state: string; token?: string }>): Promise<string> {
  const claim = await claiming;
  if (claim.state !== "claimed" || !claim.token) throw new Error(`expected a claim, got ${claim.state}`);
  return claim.token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(stores)("%s", (_name, makeStore) => {
  it("a saved report is read back as it was saved", async () => {
    const { store } = makeStore();
    const saved = report();
    expect(await seedReport(store, saved)).toEqual({ state: "saved" });
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([saved]);
  });

  it("a report 3 h old is not read back, though its record outlives it by the margin", async () => {
    const { store } = makeStore();
    await seedReport(store, report());
    expect(await store.recent(new Date(T0.getTime() + REPORT_LIFETIME_MS - 1))).toHaveLength(1);
    expect(await store.recent(new Date(T0.getTime() + REPORT_LIFETIME_MS))).toEqual([]);
  });

  it("a photo is claimed once; a second claim while it is read is told it is in flight", async () => {
    const { store } = makeStore();
    expect(await store.claimPhoto("abc")).toEqual(CLAIMED);
    expect(await store.claimPhoto("abc")).toEqual({ state: "in_flight" });
    expect(await store.claimPhoto("def")).toEqual(CLAIMED);
  });

  it("once its report is saved, the same photo is a duplicate of that report", async () => {
    const { store } = makeStore();
    const saved = report({ photoHash: "abc" });
    const token = await owned(store.claimPhoto("abc"));
    expect(await store.save(saved, token)).toEqual({ state: "saved" });
    expect(await store.claimPhoto("abc")).toEqual({ state: "duplicate", report: saved });
    await store.releasePhoto("abc", token);
    expect(await store.claimPhoto("abc")).toEqual({ state: "duplicate", report: saved });
  });

  it("a released claim lets the photo be sent again", async () => {
    const { store } = makeStore();
    await store.releasePhoto("abc", await owned(store.claimPhoto("abc")));
    expect(await store.claimPhoto("abc")).toEqual(CLAIMED);
  });

  it("a voice report is read back with its claim beside the photo reports", async () => {
    const { store } = makeStore();
    const photo = report();
    const voice = voiceReport({ receivedAt: new Date(T0.getTime() + 1_000).toISOString() });
    await seedReport(store, photo);
    await seedReport(store, voice);
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([photo, voice]);
  });

  it("a voice note is claimed by its audio's hash: once, then in flight, then a duplicate of its report", async () => {
    const { store } = makeStore();
    const saved = voiceReport({ audioHash: "abc" });
    const token = await owned(store.claimVoice("abc"));
    expect(await store.claimVoice("abc")).toEqual({ state: "in_flight" });
    await store.save(saved, token);
    expect(await store.claimVoice("abc")).toEqual({ state: "duplicate", report: saved });
    await store.releaseVoice("abc", token);
    expect(await store.claimVoice("abc")).toEqual({ state: "duplicate", report: saved });
  });

  it("a photo and a voice note with the same hash never stand for each other", async () => {
    const { store } = makeStore();
    await seedReport(store, voiceReport({ audioHash: "abc" }));
    expect(await store.claimPhoto("abc")).toEqual(CLAIMED);
    await store.releaseVoice("def", "no-such-claim");
    expect(await store.claimVoice("def")).toEqual(CLAIMED);
  });
});

describe.each(stores)("the duplicate guard on the %s: one note, one report, one index entry", (_name, makeStore) => {
  it("two claims on two notes carry different tokens", async () => {
    const { store } = makeStore();
    expect(await owned(store.claimVoice("abc"))).not.toBe(await owned(store.claimVoice("def")));
  });

  it("a second save for the same audio hands back the first report and writes nothing", async () => {
    const { store, indexEntries } = makeStore();
    const first = voiceReport({ audioHash: "abc" });
    const token = await owned(store.claimVoice("abc"));
    expect(await store.save(first, token)).toEqual({ state: "saved" });
    expect(await store.save(voiceReport({ audioHash: "abc" }), token)).toEqual({ state: "duplicate", report: first });
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([first]);
    expect(await indexEntries()).toBe(1);
  });

  it("a save from a claim that was given up and taken by a resend writes nothing; the resend's save is the report", async () => {
    const { store, indexEntries } = makeStore();
    const gaveUp = await owned(store.claimVoice("abc"));
    await store.releaseVoice("abc", gaveUp);
    const resend = await owned(store.claimVoice("abc"));
    expect(await store.save(voiceReport({ audioHash: "abc" }), gaveUp)).toEqual({ state: "not_owner" });
    const theReport = voiceReport({ audioHash: "abc" });
    expect(await store.save(theReport, resend)).toEqual({ state: "saved" });
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([theReport]);
    expect(await indexEntries()).toBe(1);
  });

  it("an original save that lands after its lapsed claim's resend was saved hands back the resend's report", async () => {
    const { store, indexEntries } = makeStore({ claimMs: 300 });
    const original = await owned(store.claimVoice("abc"));
    await sleep(400);
    const resend = await owned(store.claimVoice("abc"));
    const theReport = voiceReport({ audioHash: "abc" });
    expect(await store.save(theReport, resend)).toEqual({ state: "saved" });
    expect(await store.save(voiceReport({ audioHash: "abc" }), original)).toEqual({ state: "duplicate", report: theReport });
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([theReport]);
    expect(await indexEntries()).toBe(1);
  });

  it("a save with no claim behind it writes nothing", async () => {
    const { store, indexEntries } = makeStore();
    expect(await store.save(voiceReport({ audioHash: "abc" }), "no-such-claim")).toEqual({ state: "not_owner" });
    expect(await store.recent(new Date(T0.getTime() + 60_000))).toEqual([]);
    expect(await indexEntries()).toBe(0);
  });

  it("a release from a claim that was given up leaves the resend's claim in place", async () => {
    const { store } = makeStore();
    const gaveUp = await owned(store.claimVoice("abc"));
    await store.releaseVoice("abc", gaveUp);
    await owned(store.claimVoice("abc"));
    await store.releaseVoice("abc", gaveUp);
    expect(await store.claimVoice("abc")).toEqual({ state: "in_flight" });
  });

  it("a photo's save is held to its claim the same way", async () => {
    const { store, indexEntries } = makeStore();
    const gaveUp = await owned(store.claimPhoto("abc"));
    await store.releasePhoto("abc", gaveUp);
    const resend = await owned(store.claimPhoto("abc"));
    expect(await store.save(report({ photoHash: "abc" }), gaveUp)).toEqual({ state: "not_owner" });
    const theReport = report({ photoHash: "abc" });
    expect(await store.save(theReport, resend)).toEqual({ state: "saved" });
    expect(await store.save(report({ photoHash: "abc" }), resend)).toEqual({ state: "duplicate", report: theReport });
    expect(await indexEntries()).toBe(1);
  });
});

describe("a stored voice report in the answer rules' terms", () => {
  it.each([
    [{ place: null, depth: "knee_or_deeper", passable: "no" }, "knee_deep_or_deeper"],
    [{ place: null, depth: "below_knee", passable: "yes" }, "passable"],
  ] as const)("%o says %s, and carries no photo reading", (claim, says) => {
    expect(toReport(voiceReport({ claim }))).toMatchObject({ reading: { source: "voice", says }, place: "Governor M. Cuenco Avenue" });
  });
});

describe("expiry in the memory store (🟡P15)", () => {
  it("the record, the index and the photo's hash all go at 3 h plus the margin, not before", async () => {
    const clock = steppedClock();
    const store = new MemoryReportStore({ now: clock.now });
    const saved = report({ photoHash: "abc" });
    await seedReport(store, saved);
    clock.advance(REPORT_TTL_MS - 1);
    expect(store.keys().sort()).toEqual([`lusong:report:${saved.id}`, "lusong:report-photo:abc", "lusong:reports"].sort());
    clock.advance(1);
    expect(store.keys()).toEqual([]);
    expect(await store.claimPhoto("abc")).toEqual(CLAIMED);
  });

  it("an unfinished claim lapses, so a read that died mid-way doesn't hold the photo for 3 h", async () => {
    const clock = steppedClock();
    const store = new MemoryReportStore({ now: clock.now });
    await store.claimPhoto("abc");
    clock.advance(PHOTO_CLAIM_MS);
    expect(await store.claimPhoto("abc")).toEqual(CLAIMED);
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
    await seedReport(store, saved);
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
