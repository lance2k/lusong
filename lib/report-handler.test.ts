import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { samEmpty, samFixture, serverError, stubMeta } from "../test/meta-stub";
import { withExifTime } from "./exif";
import { createBudget, MemoryBudgetStore, RESERVE_MICROS as R, type Budget } from "./budget";
import { makeReportHandler } from "./report-handler";
import { MemoryReportStore, UpstashReportStore, type ReportStore, type StoredPhotoReport } from "./report-store";
import { REPORT_LIFETIME_MS } from "./answer";
import type { ValhallaGate } from "./router";

const photo = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));
const otherPhoto = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-2.jpg"));
const LOCATE = JSON.parse(readFileSync("test/fixtures/valhalla/locate-sample-pins.json", "utf8"));
/** The first sample pin, on Governor M. Cuenco Avenue, Apas (way 1116002958). */
const PIN = { lat: 10.338566, lon: 123.911461 };
const NOW = new Date("2026-10-30T01:00:00Z");

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

/** Every key the store holds, with its value: a string, or a sorted set's members. */
type Held = Record<string, string | string[]>;
interface StoreUnderTest {
  store: ReportStore;
  held(): Promise<Held>;
}

const memoryStore = (): StoreUnderTest => {
  const store = new MemoryReportStore();
  return { store, held: async () => store.dump() };
};
const upstashStore = (): StoreUnderTest => {
  const prefix = `lusong-test-${randomUUID()}`;
  return {
    store: new UpstashReportStore(upstashUrl!, upstashToken, prefix),
    async held() {
      const call = async (command: string[]) => {
        const res = await fetch(upstashUrl!, {
          method: "POST",
          headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
        return ((await res.json()) as { result: unknown }).result;
      };
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, page] = (await call(["SCAN", cursor, "MATCH", `${prefix}:*`, "COUNT", "1000"])) as [string, string[]];
        keys.push(...page);
        cursor = next;
      } while (cursor !== "0");
      const out: Held = {};
      for (const key of keys) {
        const type = await call(["TYPE", key]);
        out[key.replace(prefix, "lusong")] = type === "zset" ? ((await call(["ZRANGE", key, "0", "-1"])) as string[]) : String(await call(["GET", key]));
      }
      return out;
    },
  };
};
const stores: [string, () => StoreUnderTest][] = [
  ["memory store", memoryStore],
  ...(upstashUrl ? [["Upstash store", upstashStore] as [string, () => StoreUnderTest]] : []),
];

function post(ip: string, opts: { bytes?: Uint8Array; lat?: unknown; lon?: unknown } = {}): Request {
  const form = new FormData();
  form.set("photo", new File([new Uint8Array(opts.bytes ?? photo)], "photo.jpg", { type: "image/jpeg" }));
  form.set("lat", String(opts.lat ?? PIN.lat));
  form.set("lon", String(opts.lon ?? PIN.lon));
  return new Request("http://localhost/api/report", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
}

/** Valhalla's /locate faked with the saved reply for the first sample pin. */
function locate(reply: () => Response | Promise<Response> = () => Response.json([LOCATE[0]])) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    requests.push(String(url));
    return reply();
  });
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}
const open: ValhallaGate = { acquire: async () => "ok" };

function handlerWith(
  opts: {
    store?: ReportStore | null;
    ipLimit?: number;
    budgetMicros?: number;
    valhalla?: ReturnType<typeof locate>;
    now?: () => Date;
    gate?: ValhallaGate;
    admitDelayMs?: number;
    settleDelayMs?: number;
    budget?: Budget;
    timing?: Parameters<typeof makeReportHandler>[0]["timing"];
  } = {},
) {
  const budget =
    opts.budget ?? createBudget({ store: new MemoryBudgetStore(), budgetUsd: (opts.budgetMicros ?? 10 * R) / 1e6, ipLimit: opts.ipLimit ?? 10 });
  const slowBudget: Budget = {
    admit: async (...args) => (await sleep(opts.admitDelayMs ?? 0), budget.admit(...args)),
    settle: async (...args) => (await sleep(opts.settleDelayMs ?? 0), budget.settle(...args)),
  };
  const store = opts.store === undefined ? new MemoryReportStore() : opts.store;
  const valhalla = opts.valhalla ?? locate();
  return makeReportHandler({
    budget: () => slowBudget,
    store: () => store,
    gate: () => opts.gate ?? open,
    fetch: valhalla.fetch,
    now: opts.now ?? (() => NOW),
    timing: opts.timing,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reply that never comes: the call ends only when its own timeout aborts it. */
const hangs = (signal?: AbortSignal | null) =>
  new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(stores)("a photo report on the %s", (_name, makeStore) => {
  it("is stored with its pin, time and verdict, and the photo itself is not stored", async () => {
    const calls = stubMeta();
    const { store, held } = makeStore();
    const res = await handlerWith({ store })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(4);

    const everything = await held();
    const recordKey = Object.keys(everything).find((k) => k.startsWith("lusong:report:"))!;
    const record = JSON.parse(everything[recordKey] as string);
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: "photo",
      at: PIN,
      wayId: 1116002958,
      place: "Governor M. Cuenco Avenue",
      receivedAt: "2026-10-30T01:00:00.000Z",
      capturedAt: null,
      verdict: { kind: "no_flood" },
      photoHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(everything).toEqual({
      [`lusong:report:${record.id}`]: expect.any(String),
      [`lusong:report-photo:${record.photoHash}`]: record.id,
      "lusong:reports": [record.id],
    });
    // The photo is 517 KB; what the store holds is the record, the id twice and the hash.
    expect(JSON.stringify(everything).length).toBeLessThan(1_000);
  });
});

describe("the reporter", () => {
  it("is shown what Lusong read, where, and what the report does for others", async () => {
    stubMeta();
    const res = await handlerWith()(post("192.0.2.1"));
    expect(await res.json()).toEqual({
      duplicate: false,
      stored: true,
      report: {
        id: expect.any(String),
        place: "Governor M. Cuenco Avenue",
        received: "30 Oct, 9:00 a.m. PHT",
        captured: null,
        depth: "no flood water seen",
        passability: "No flood water in the photo",
        role: "neutral",
        counts: true,
        effect: expect.stringContaining("carries no time it was taken"),
        mmdaCredit: expect.stringContaining("MMDA"),
      },
    });
  });

  it("over the per-address daily limit, is refused with the existing message, and nothing is read or stored", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const valhalla = locate();
    const handler = handlerWith({ store, ipLimit: 1, valhalla });
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    const before = store.dump();
    const refused = await handler(post("192.0.2.1", { bytes: otherPhoto }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "You've used today's checks. They start again at 8:00 a.m. Philippine time.",
      reason: "ip",
    });
    expect(calls).toHaveLength(4);
    expect(valhalla.requests).toHaveLength(1);
    expect(store.dump()).toEqual(before);
    expect((await handler(post("192.0.2.2", { bytes: otherPhoto }))).status).toBe(200);
  });
});

describe("a dry photo counts as clear only when it was taken within the hour before it was sent (🔴P8)", () => {
  // NOW is 9:00 a.m. PHT; EXIF times are read as PHT.
  it.each([
    ["taken 20 min before", "2026:10:30 08:40:00", "clear"],
    ["taken exactly 60 min before", "2026:10:30 08:00:00", "clear"],
    ["taken 61 min before", "2026:10:30 07:59:00", "neutral"],
    ["taken a day before", "2026:10:29 08:40:00", "neutral"],
    ["timed after it was sent", "2026:10:30 09:05:00", "neutral"],
  ])("%s ⇒ %s", async (_when, exifTime, role) => {
    stubMeta();
    const store = new MemoryReportStore();
    const res = await handlerWith({ store })(post("192.0.2.1", { bytes: withExifTime(photo, exifTime) }));
    expect((await res.json()).report.role).toBe(role);
    const [stored] = (await store.recent(NOW)) as StoredPhotoReport[];
    expect(stored.capturedAt).toBe(new Date(`${exifTime.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T")}+08:00`).toISOString());
  });

  it("an old phone photo (EXIF 24 Jul 2024, 5:25 p.m.) is stored with that capture time and cannot clear", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    const res = await handlerWith({ store })(post("192.0.2.1", { bytes: new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1-exif.jpg")) }));
    const body = await res.json();
    expect(body.report).toMatchObject({ role: "neutral", captured: "24 Jul, 5:25 p.m. PHT" });
    expect(body.report.effect).toContain("isn't within the hour before you sent it");
    expect(((await store.recent(NOW)) as StoredPhotoReport[])[0].capturedAt).toBe("2024-07-24T09:25:53.000Z");
  });

  it("a deep-water photo blocks whatever its capture time", async () => {
    stubMeta({
      sam: { "flood water": samFixture("test/fixtures/sam/quiapo-1__flood_water.json"), person: samFixture("test/fixtures/sam/quiapo-1__person.json") },
      muse: () =>
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  is_flooded_street: true,
                  caveats: "",
                  readings: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"].map((label) => ({ label, waterline: "mid_thigh", in_water: true, is_child: false, note: "" })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    });
    const res = await handlerWith()(post("192.0.2.1"));
    const { report } = await res.json();
    expect(report).toMatchObject({ role: "block", passability: "Not passable to any vehicle (MMDA gauge, Metro Manila)" });
  });
});

describe("the same photo sent again within 3 h (🔴P8)", () => {
  it("is one report, read and paid for once", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const valhalla = locate();
    const handler = handlerWith({ store, ipLimit: 1, valhalla });
    const first = await (await handler(post("192.0.2.1"))).json();
    const again = await handler(post("192.0.2.1"));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...first, duplicate: true });
    expect(calls).toHaveLength(4);
    expect(valhalla.requests).toHaveLength(1);
    expect(await store.recent(NOW)).toHaveLength(1);
  });

  it("with its capture time edited to look fresh, is still the same photo", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const handler = handlerWith({ store });
    await handler(post("192.0.2.1", { bytes: withExifTime(photo, "2026:10:30 07:00:00") }));
    const again = await (await handler(post("192.0.2.2", { bytes: withExifTime(photo, "2026:10:30 08:55:00") }))).json();
    expect(again).toMatchObject({ duplicate: true, report: { role: "neutral" } });
    expect(calls).toHaveLength(4);
    expect(await store.recent(NOW)).toHaveLength(1);
  });

  it("while the first send is still being read, is turned away without a second read", async () => {
    let finishRead = () => {};
    const reading = new Promise<void>((resolve) => (finishRead = resolve));
    const calls = stubMeta({ sam: { "flood water": async () => (await reading, samEmpty()()) } });
    const handler = handlerWith();
    const first = handler(post("192.0.2.1"));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    const second = await handler(post("192.0.2.2"));
    expect(second.status).toBe(409);
    finishRead();
    expect((await first).status).toBe(200);
    expect(calls).toHaveLength(4);
  });

  it("after a read that failed, is read again", async () => {
    stubMeta({ sam: { person: serverError() } });
    const store = new MemoryReportStore();
    const handler = handlerWith({ store });
    expect((await handler(post("192.0.2.1"))).status).toBe(502);
    expect(store.dump()).toEqual({});
    const calls = stubMeta();
    expect((await handler(post("192.0.2.1"))).status).toBe(200);
    expect(calls).toHaveLength(4);
  });
});

describe("the reported spot's road", () => {
  it("when Valhalla can't be reached, the report is stored without a way id", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    const valhalla = locate(() => Promise.reject(new TypeError("fetch failed")));
    expect((await handlerWith({ store, valhalla })(post("192.0.2.1"))).status).toBe(200);
    expect(await store.recent(NOW)).toEqual([expect.objectContaining({ wayId: null, place: null })]);
    expect(valhalla.requests).toHaveLength(1);
  });
});

describe("refused before anything is paid for", () => {
  it.each([
    ["no location", { lat: "", lon: "" }, 400],
    ["a location that is not a number", { lat: "abc", lon: "123.9" }, 400],
    ["a location outside the Philippines", { lat: 35.68, lon: 139.76 }, 400],
    ["a location in Metro Manila, outside Metro Cebu", { lat: 14.5547, lon: 121.0244 }, 400],
  ])("%s", async (_why, pin, status) => {
    const calls = stubMeta();
    const form = post("192.0.2.1", pin);
    expect((await handlerWith()(form)).status).toBe(status);
    expect(calls).toHaveLength(0);
  });

  it("no report store: refused, no read", async () => {
    const calls = stubMeta();
    const res = await handlerWith({ store: null })(post("192.0.2.1"));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("a report store that can't be reached: refused, no read", async () => {
    const calls = stubMeta();
    const broken = new MemoryReportStore();
    broken.claimPhoto = async () => {
      throw new Error("Upstash HTTP 500");
    };
    expect((await handlerWith({ store: broken })(post("192.0.2.1"))).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("one deadline for the whole request (route maxDuration 120 s)", () => {
  /** Scaled down from 110 s, 12 s and 3 s so the test runs in seconds; the handler logic is the same. */
  /** Save, release and settle get 150 ms each, the response 150 ms: a 600 ms reserve, like 3 × 5 s + 2 s scaled. */
  const timing = { budgetMs: 3_000, storeCallMs: 150, responseMs: 150, minReadMs: 400, locateMinMs: 800 };

  /** A store whose claim is slow, as an Upstash call near its 5 s timeout would be. */
  function slowClaimStore(delayMs: number) {
    const store = new MemoryReportStore();
    const claim = store.claimPhoto.bind(store);
    store.claimPhoto = async (hash) => (await sleep(delayMs), claim(hash));
    return store;
  }

  it("slow claim and admission, then a Meta call that never answers: answered within the budget, the claim freed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => hangs(init.signal)));
    const store = slowClaimStore(500);
    const started = Date.now();
    const res = await handlerWith({ store, admitDelayMs: 500, timing })(post("192.0.2.1"));
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(store.dump()).toEqual({});
  }, 10_000);

  it("a read that leaves too little time for /locate: stored without a way id, no /locate, answered within the budget", async () => {
    const calls = stubMeta({ sam: { "flood water": async () => (await sleep(1_900), samEmpty()()) } });
    const store = new MemoryReportStore();
    const valhalla = locate();
    const started = Date.now();
    const res = await handlerWith({ store, valhalla, timing })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(calls).toHaveLength(4);
    expect(valhalla.requests).toHaveLength(0);
    expect(await store.recent(NOW)).toEqual([expect.objectContaining({ wayId: null, verdict: { kind: "no_flood" } })]);
  }, 10_000);

  it("a Valhalla gate that never grants is given up in time: stored and answered within the budget", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    const started = Date.now();
    const never: ValhallaGate = { acquire: () => new Promise(() => {}) };
    const res = await handlerWith({ store, gate: never, timing })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(await store.recent(NOW)).toEqual([expect.objectContaining({ wayId: null })]);
  }, 20_000);

  it("a /locate that never answers is cut off in time: stored and answered within the budget", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    const valhalla = { requests: [] as string[], fetch: (async (url: string, init?: RequestInit) => (valhalla.requests.push(String(url)), hangs(init?.signal))) as unknown as typeof fetch };
    const started = Date.now();
    const res = await handlerWith({ store, valhalla, timing })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(valhalla.requests).toHaveLength(1);
    expect(await store.recent(NOW)).toEqual([expect.objectContaining({ wayId: null })]);
  }, 20_000);

  /** A multipart body that sends its first bytes and then nothing more, as a stalled upload would. */
  function stalledUpload(): Request {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("--x\r\nContent-Disposition: form-data; name=\"lat\"\r\n\r\n10.33\r\n"));
      },
    });
    return new Request("http://localhost/api/report", {
      method: "POST",
      body,
      headers: { "content-type": "multipart/form-data; boundary=x", "x-forwarded-for": "192.0.2.1" },
      duplex: "half",
    } as RequestInit);
  }

  function watchedBudget() {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: R / 1e6, ipLimit: 10 });
    const admit = vi.spyOn(budget, "admit");
    return { budget, admit };
  }

  it("an upload that stalls is cut off at the deadline: 408, nothing claimed, nothing reserved", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const { budget, admit } = watchedBudget();
    const started = Date.now();
    const res = await handlerWith({ store, budget, timing })(stalledUpload());
    expect(res.status).toBe(408);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(store.dump()).toEqual({});
    expect(admit).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  }, 10_000);

  it("a claim that leaves no time for admission and a read: 503, the claim freed, nothing reserved, no Meta call", async () => {
    const calls = stubMeta();
    const store = slowClaimStore(2_100);
    const { budget, admit } = watchedBudget();
    const res = await handlerWith({ store, budget, timing })(post("192.0.2.1"));
    expect(res.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    await vi.waitFor(() => expect(store.dump()).toEqual({}), { timeout: 2_000 });
  }, 10_000);

  it("an admission that leaves no time for a read: 503, no Meta call, the reservation refunded and the claim freed", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const { budget, admit } = watchedBudget();
    const settle = vi.spyOn(budget, "settle");
    const res = await handlerWith({ store, budget, admitDelayMs: 2_100, timing })(post("192.0.2.1"));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
    // The late reservation lands after the answer; once it is settled, the budget (room for exactly one) is free again.
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(admit).toHaveBeenCalledTimes(1);
    expect((await budget.admit("192.0.2.9", NOW)).ok).toBe(true);
    expect(store.dump()).toEqual({});
  }, 10_000);

  it("a save that never answers: answered within the budget, not stored", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    store.save = () => new Promise(() => {});
    const started = Date.now();
    const res = await handlerWith({ store, timing })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect((await res.json()).stored).toBe(false);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
  }, 10_000);

  it("a slow failed save, a slow release and a slow settle after a late read all fit in the budget", async () => {
    stubMeta({ sam: { "flood water": async () => (await sleep(2_300), samEmpty()()) } });
    const store = new MemoryReportStore();
    store.save = async () => {
      await sleep(140);
      throw new Error("Upstash HTTP 500");
    };
    const release = store.releasePhoto.bind(store);
    store.releasePhoto = async (hash) => (await sleep(140), release(hash));
    const started = Date.now();
    const res = await handlerWith({ store, settleDelayMs: 140, timing })(post("192.0.2.1"));
    expect(res.status).toBe(200);
    expect((await res.json()).stored).toBe(false);
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
  }, 10_000);

  it("the real budget leaves the route's 120 s limit room past the reserve for saving and settling", async () => {
    const { REQUEST_BUDGET_MS, FINISH_RESERVE_MS } = await import("./report-handler");
    // The route module imports through the "@/" alias, which vitest doesn't resolve, so its limit is read from source.
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/report/route.ts", "utf8"))?.[1]);
    expect(maxDuration).toBe(120);
    expect(REQUEST_BUDGET_MS).toBeLessThan(maxDuration * 1_000);
    // A failed save, its release and the settle are each one Upstash call bounded at 5 s, run one after another.
    expect(FINISH_RESERVE_MS).toBeGreaterThanOrEqual(3 * 5_000);
  });
});

describe("what the reporter is told the report does", () => {
  const fresh = () => withExifTime(photo, "2026:10:30 08:40:00");

  it("a new clearing report counts for the next 3 h", async () => {
    stubMeta();
    const { report } = await (await handlerWith()(post("192.0.2.1", { bytes: fresh() }))).json();
    expect(report).toMatchObject({ role: "clear", counts: true });
    expect(report.effect).toBe("Others checking a trip through here will count this spot as clear for the next 3 h.");
  });

  it("a duplicate sent 1 min before the 3 h are up is told the time left", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    await handlerWith({ store })(post("192.0.2.1", { bytes: fresh() }));
    const later = new Date(NOW.getTime() + REPORT_LIFETIME_MS - 60_000);
    const { duplicate, report } = await (await handlerWith({ store, now: () => later })(post("192.0.2.1", { bytes: fresh() }))).json();
    expect(duplicate).toBe(true);
    expect(report).toMatchObject({ role: "clear", counts: true });
    expect(report.effect).toBe("Others checking a trip through here will count this spot as clear for the next 1 min.");
  });

  it("a duplicate sent at 3 h is told the report no longer counts", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    await handlerWith({ store })(post("192.0.2.1", { bytes: fresh() }));
    const later = new Date(NOW.getTime() + REPORT_LIFETIME_MS);
    const { duplicate, report } = await (await handlerWith({ store, now: () => later })(post("192.0.2.1", { bytes: fresh() }))).json();
    expect(duplicate).toBe(true);
    expect(report.counts).toBe(false);
    expect(report.effect).toBe("Lusong received this photo over 3 hours ago, so it no longer counts in anyone's check. Send a new photo of the street.");
  });

  it("a report that couldn't be saved doesn't claim to count for others", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    store.save = async () => {
      throw new Error("Upstash HTTP 500");
    };
    const body = await (await handlerWith({ store })(post("192.0.2.1", { bytes: fresh() }))).json();
    expect(body).toMatchObject({ stored: false, report: { counts: false, depth: "no flood water seen" } });
    expect(body.report.effect).toBe("Lusong couldn't save the report, so it doesn't count in anyone's check. Try sending it again in a minute.");
  });
});
