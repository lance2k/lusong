import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL, CAGAYAN_GFA4_REISSUED, ALL_SAVED, feedOf } from "../test/pagasa-fixtures";
import { watchStores } from "../test/watch-stores";
import { FEED_URL } from "./advisory";
import { MemoryAdvisoryStore, refreshSnapshot, SNAPSHOT_KEY, type AdvisoryProduct, type AdvisorySnapshot } from "./advisory-snapshot";
import { DELIVERY_LIMITS, runDelivery, type DeliveryDeps } from "./alert-delivery";
import { corridorFor, simplifyLine, touches } from "./alert-corridor";
import { alertMessage, MemoryAlertStore, pagasaAlerts, UpstashAlertStore, type Alert, type AlertStore } from "./alerts";
import type { Point } from "./answer";
import type { Channel, SendResult } from "./channel";
import { MemoryWatchStore, type NewWatcher, type WatchStore, type WatchTrip } from "./watch-store";
import { switchOff } from "./watch-tick";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };
const CEBU_TRIP: WatchTrip = { from: BANILAD, to: IT_PARK };
const DAVAO_TRIP: WatchTrip = { from: { lat: 7.0731, lon: 125.6128 }, to: { lat: 7.09, lon: 125.62 } };
const TUGUEGARAO_TRIP: WatchTrip = { from: { lat: 17.6132, lon: 121.727 }, to: { lat: 17.63, lon: 121.74 } };
/** 14:00 PHT: outside every test watcher's 06:00–08:00 window. */
const AFTERNOON = "2026-11-04T14:00:00+08:00";

function fakeClock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), ms: () => t, set: (next: string) => (t = Date.parse(next)), advance: (ms: number) => (t += ms) };
}

async function linked(store: WatchStore, id: string, trip: WatchTrip, chatId: string | null = `chat-${id}`): Promise<NewWatcher> {
  const w: NewWatcher = { id, gen: "g1", trip, window: { startMin: 360, endMin: 480 } };
  await store.create(w, `code-${id}`);
  if (chatId) await store.redeem(`code-${id}`, chatId);
  return w;
}

const CEBU_AREA = { desc: "Cebu", polygons: [], geocodes: ["072200000"] };
const DAVAO_AREA = { desc: "Davao del Sur", polygons: [], geocodes: ["112400000"] };
const COUNTRY_AREA = { desc: "Philippines", polygons: [], geocodes: [] };

function product(id: string, area: AdvisoryProduct["infos"][number]["areas"][number], sent: string, expires: string, event = "General Flood Advisory (Moderate)"): AdvisoryProduct {
  return {
    id,
    link: `https://publicalert.pagasa.dost.gov.ph/output/gfa/${id}.cap`,
    kind: "flood",
    event,
    headline: null,
    sent,
    infos: [{ expires, rainForecast: null, rivers: [], areas: [area] }],
  };
}

function snapshotOf(products: AdvisoryProduct[], fetchedAt: string, generation = Date.parse(fetchedAt)): AdvisorySnapshot {
  return { generation, fetchedAt: new Date(fetchedAt).toISOString(), complete: true, why: null, entries: [], products };
}

async function publish(advisory: MemoryAdvisoryStore, snapshot: AdvisorySnapshot) {
  await advisory.publishIfNewer(SNAPSHOT_KEY, snapshot.generation, JSON.stringify(snapshot), 24 * 3_600_000);
}

/** Records every send it is handed, Telegram's answer included, and answers from `next` (ok when empty). */
class RecordingChannel implements Channel {
  readonly attempts: { chatId: string; text: string; at: number }[] = [];
  next: SendResult[] = [];
  constructor(private readonly clock: () => number) {}
  async send(chatId: string, text: string): Promise<SendResult> {
    this.attempts.push({ chatId, text, at: this.clock() });
    return this.next.shift() ?? { ok: true };
  }
}

function setup(iso = AFTERNOON) {
  const clock = fakeClock(iso);
  const watches = new MemoryWatchStore({ now: clock.ms });
  const alerts = new MemoryAlertStore();
  const advisory = new MemoryAdvisoryStore(clock.ms);
  const channel = new RecordingChannel(clock.ms);
  const deps: DeliveryDeps = {
    watches,
    alerts,
    advisory,
    channel,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
  };
  return { clock, watches, alerts, advisory, channel, deps, deliver: (more: Partial<DeliveryDeps> = {}) => runDelivery({ ...deps, ...more }) };
}

const SENT_AM = "2026-11-04T05:00:00+08:00";
const UNTIL_PM = "2026-11-04T17:00:00+08:00";

describe("alert delivery: who gets what (ledger #7)", () => {
  it("two advisories on one trip are both sent, whatever the trip's answer, each once", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM), product("p2", CEBU_AREA, "2026-11-04T06:00:00+08:00", UNTIL_PM, "Heavy Rainfall Warning")], AFTERNOON));
    expect(await t.deliver()).toMatchObject({ ok: true, sent: 2, due: 2, pagasaHeld: null });
    expect(t.channel.attempts.map((a) => a.text)).toEqual([
      "PAGASA General Flood Advisory (Moderate) for Cebu, sent 4 Nov, 5:00 a.m. PHT, until 4 Nov, 5:00 p.m. PHT. https://publicalert.pagasa.dost.gov.ph/output/gfa/p1.cap",
      "PAGASA Heavy Rainfall Warning for Cebu, sent 4 Nov, 6:00 a.m. PHT, until 4 Nov, 5:00 p.m. PHT. https://publicalert.pagasa.dost.gov.ph/output/gfa/p2.cap",
    ]);
    t.clock.advance(10 * 60_000);
    expect(await t.deliver()).toMatchObject({ sent: 0, due: 0 });
    expect(t.channel.attempts).toHaveLength(2);
  });

  it("an alert is sent outside the watcher's window (14:00 PHT for a 06:00–08:00 watcher)", async () => {
    const t = setup(AFTERNOON);
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    expect(await t.deliver()).toMatchObject({ sent: 1 });
    expect(t.channel.attempts.map((a) => a.chatId)).toEqual(["chat-w1"]);
  });

  it("a nationwide alert reaches every linked watcher, and only linked ones; a regional one only the trips it touches", async () => {
    const t = setup();
    await linked(t.watches, "cebu", CEBU_TRIP);
    await linked(t.watches, "davao", DAVAO_TRIP);
    await linked(t.watches, "tuguegarao", TUGUEGARAO_TRIP);
    await linked(t.watches, "unlinked", CEBU_TRIP, null);
    await publish(t.advisory, snapshotOf([product("tc", COUNTRY_AREA, SENT_AM, UNTIL_PM, "Tropical Cyclone Alert"), product("dv", DAVAO_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    expect(await t.deliver()).toMatchObject({ sent: 4 });
    const got = t.channel.attempts.map((a) => `${a.chatId} ${/output\/gfa\/(\w+)/.exec(a.text)![1]}`).sort();
    expect(got).toEqual(["chat-cebu tc", "chat-davao dv", "chat-davao tc", "chat-tuguegarao tc"]);
    expect(t.channel.attempts.find((a) => a.text.includes("/tc."))!.text).toContain("Tropical Cyclone Alert for the whole country");
  });

  it("a switched-off watcher gets nothing, and switching off leaves no alert history or route line behind", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await t.watches.saveRoute("w1", "g1", [BANILAD, IT_PARK]);
    await publish(t.advisory, snapshotOf([product("p1", COUNTRY_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    expect(await t.deliver()).toMatchObject({ sent: 1 });
    await publish(t.advisory, snapshotOf([product("p1", COUNTRY_AREA, SENT_AM, UNTIL_PM), product("p2", COUNTRY_AREA, SENT_AM, UNTIL_PM)], AFTERNOON, Date.parse(AFTERNOON) + 1));
    await switchOff(t.watches, "w1");
    expect(await t.deliver()).toMatchObject({ sent: 0, watchers: 0 });
    expect(t.channel.attempts).toHaveLength(1);
    expect(t.watches.ttls()).toEqual({});
  });

  it("a batch cut off by its send cap resumes at the next run: everyone gets it once, the skipped first", async () => {
    const t = setup();
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) await linked(t.watches, id, CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("tc", COUNTRY_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    expect(await t.deliver({ limits: { maxSends: 2 } })).toMatchObject({ sent: 2, deferred: 3 });
    expect(await t.deliver({ limits: { maxSends: 2 } })).toMatchObject({ sent: 2, deferred: 1 });
    expect(await t.deliver({ limits: { maxSends: 2 } })).toMatchObject({ sent: 1, deferred: 0 });
    expect(await t.deliver({ limits: { maxSends: 2 } })).toMatchObject({ sent: 0, due: 0 });
    expect(t.channel.attempts.map((a) => a.chatId)).toEqual(["chat-a1", "chat-a2", "chat-a3", "chat-a4", "chat-a5"]);
  });

  it("a run that runs out of time leaves the rest for the next one", async () => {
    const t = setup();
    for (const id of ["a1", "a2"]) await linked(t.watches, id, CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("tc", COUNTRY_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    // Less than a lease and a store call left: nothing is started.
    expect(await t.deliver({ limits: { budgetMs: 12_000 } })).toMatchObject({ sent: 0, deferred: 2 });
    expect(await t.deliver()).toMatchObject({ sent: 2 });
  });

  it("a 429 with retry_after is tried again only after it, at most 3 more times, then given up", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    const refused: SendResult = { ok: false, rejected: true, permanent: false, retryAfterS: 30 };
    t.channel.next = [refused, refused, refused, refused, refused];
    const tries: number[] = [];
    for (let s = 0; s < 200; s += 10) {
      const before = t.channel.attempts.length;
      await t.deliver();
      if (t.channel.attempts.length > before) tries.push(s);
      t.clock.advance(10_000);
      // Each run is quick next to the clock it moves, so the snapshot stays fresh at every step.
    }
    // Sent at 0 s, refused; again no sooner than 30 s after each refusal; four tries in all.
    expect(tries).toEqual([0, 30, 60, 90]);
    expect(await t.watches.alertStates("w1", ["pagasa:p1@1"])).toEqual(["rejected"]);
  });

  it("a refusal without retry_after waits 60 s", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    t.channel.next = [{ ok: false, rejected: true, permanent: false }];
    await t.deliver();
    t.clock.advance(59_000);
    expect(await t.deliver()).toMatchObject({ sent: 0, deferred: 1 });
    t.clock.advance(1_000);
    expect(await t.deliver()).toMatchObject({ sent: 1 });
  });

  it("an ambiguous send counts as delivered and is never tried again", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    t.channel.next = [{ ok: false, rejected: false }];
    expect(await t.deliver()).toMatchObject({ ambiguous: 1 });
    for (let i = 0; i < 3; i++) {
      t.clock.advance(10 * 60_000);
      await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, "2026-11-04T23:00:00+08:00")], t.clock.now().toISOString()));
      expect(await t.deliver()).toMatchObject({ sent: 0, due: 0 });
    }
    expect(t.channel.attempts).toHaveLength(1);
    expect(await t.watches.alertStates("w1", ["pagasa:p1@1"])).toEqual(["ambiguous"]);
  });

  it("a chat that has blocked the bot (403) switches its watcher off", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM), product("p2", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    t.channel.next = [{ ok: false, rejected: true, permanent: true }];
    await t.deliver();
    expect(t.channel.attempts).toHaveLength(1);
    expect(await t.watches.get("w1")).toBeNull();
  });

  it("one chat gets at most one alert a second", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf(["p1", "p2", "p3"].map((id) => product(id, CEBU_AREA, SENT_AM, UNTIL_PM)), AFTERNOON));
    expect(await t.deliver()).toMatchObject({ sent: 3 });
    const at = t.channel.attempts.map((a) => a.at);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(DELIVERY_LIMITS.chatGapMs);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(DELIVERY_LIMITS.chatGapMs);
  });

  it("PAGASA alerts aren't sent from a snapshot that is stale or incomplete (lean safe), and are once it is fresh", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], "2026-11-04T13:20:00+08:00"));
    expect(await t.deliver()).toMatchObject({ sent: 0, pagasaHeld: "the snapshot is older than 30 minutes" });
    await publish(t.advisory, { ...snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON), complete: false, why: "feed: fetch failed" });
    expect(await t.deliver()).toMatchObject({ sent: 0, pagasaHeld: "feed: fetch failed" });
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON, Date.parse(AFTERNOON) + 5));
    expect(await t.deliver()).toMatchObject({ sent: 1, pagasaHeld: null });
  });
});

describe("Update and Cancel act on the referenced products (S4P-5)", () => {
  /** PAGASA's feed listing these saved Cagayan Valley records, refreshed into the snapshot at `iso`. */
  async function refreshAt(advisory: MemoryAdvisoryStore, iso: string, links: string[]) {
    const served = Object.fromEntries([[FEED_URL, feedOf(links)], ...links.map((l) => [l, ALL_SAVED[l]])]);
    const fetch = (async (url: string | URL) => {
      const body = served[String(url)];
      if (body === undefined) throw new TypeError("fetch failed");
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const outcome = await refreshSnapshot({ store: advisory, fetch, now: () => new Date(iso) });
    expect(outcome.outcome).toBe("published");
  }

  it("a Cancel published before delivery means the cancelled advisory is never sent; its reissue is", async () => {
    const t = setup("2026-10-23T05:30:00+08:00");
    await linked(t.watches, "w1", TUGUEGARAO_TRIP);
    // GFA #4 was live at 05:30, but no delivery ran before the 05:45 snapshot that holds its cancellation.
    await refreshAt(t.advisory, "2026-10-23T05:30:00+08:00", [CAGAYAN_GFA4]);
    await refreshAt(t.advisory, "2026-10-23T05:45:00+08:00", [CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL, CAGAYAN_GFA4_REISSUED]);
    t.clock.set("2026-10-23T05:46:00+08:00");
    expect(await t.deliver()).toMatchObject({ sent: 1 });
    expect(t.channel.attempts.map((a) => a.text.match(/gfa\/([\w-]+)\.cap/)![1])).toEqual(["855536fb-a3b5-4721-9015-92cc1dd493dc"]);
  });

  it("an alert a newer snapshot removes while a run is under way isn't sent", async () => {
    const t = setup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM), product("p2", CEBU_AREA, "2026-11-04T06:00:00+08:00", UNTIL_PM)], AFTERNOON));
    const send = t.channel.send.bind(t.channel);
    t.channel.send = async (chatId, text) => {
      // The snapshot that cancels p2 publishes, and its rebuild lands, while p1 is being sent.
      await t.alerts.rebuildPagasa(Date.parse(AFTERNOON) + 1, pagasaAlerts(snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON), t.clock.now()), t.clock.ms());
      return send(chatId, text);
    };
    expect(await t.deliver()).toMatchObject({ sent: 1 });
    expect(t.channel.attempts.map((a) => a.text)).toEqual([expect.stringContaining("/p1.cap")]);
  });
});

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

const alertStores: [string, () => AlertStore][] = [
  ["memory alert store", () => new MemoryAlertStore()],
  ...(upstashUrl ? [["Upstash alert store", () => new UpstashAlertStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [string, () => AlertStore]] : []),
];

function alert(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    version: 1,
    kind: "advisory",
    scope: { nationwide: true },
    sourceUrl: `https://publicalert.pagasa.dost.gov.ph/output/gfa/${id}.cap`,
    sourceOrg: "PAGASA",
    eventAt: "2026-11-04T05:00:00+08:00",
    expiresAt: "2026-11-04T17:00:00+08:00",
    severity: "warn",
    origin: "pagasa",
    fields: { event: "General Flood Advisory (Moderate)", sent: "2026-11-04T05:00:00+08:00", expires: "2026-11-04T17:00:00+08:00" },
    ...overrides,
  };
}

describe.each(alertStores)("the %s", (_name, make) => {
  const now = Date.parse(AFTERNOON);

  it("an older rebuild that lands after a newer one never brings back what the newer one cancelled (out of order)", async () => {
    const store = make();
    expect(await store.rebuildPagasa(2, [alert("pagasa:reissued")], now)).toBe(true);
    expect(await store.rebuildPagasa(1, [alert("pagasa:cancelled"), alert("pagasa:reissued")], now)).toBe(false);
    expect((await store.all(now)).map((a) => a.id)).toEqual(["pagasa:reissued"]);
    expect(await store.isActive("pagasa:cancelled", 1, now)).toBe(false);
    expect(await store.isActive("pagasa:reissued", 1, now)).toBe(true);
  });

  it("a rebuild replaces every PAGASA alert, keeps the sweep's unexpired ones and deletes expired ones", async () => {
    const store = make();
    await store.addIfAbsent([alert("sweep:a", { origin: "sweep" }), alert("sweep:old", { origin: "sweep", expiresAt: "2026-11-04T13:00:00+08:00" })]);
    await store.rebuildPagasa(1, [alert("pagasa:x")], now);
    await store.rebuildPagasa(2, [alert("pagasa:y")], now);
    expect((await store.all(now)).map((a) => a.id).sort()).toEqual(["pagasa:y", "sweep:a"]);
    expect(await store.all(Date.parse("2026-11-04T17:00:00+08:00"))).toEqual([]);
  });

  it("an alert seen again keeps its first version, time and expiry", async () => {
    const store = make();
    expect(await store.addIfAbsent([alert("sweep:a", { origin: "sweep" })])).toBe(1);
    expect(await store.addIfAbsent([alert("sweep:a", { origin: "sweep", eventAt: "2026-11-04T09:00:00+08:00", expiresAt: "2026-11-04T21:00:00+08:00" })])).toBe(0);
    expect(await store.all(now)).toEqual([alert("sweep:a", { origin: "sweep" })]);
  });
});

describe.each(watchStores)("durable claims before a send on the %s (S4P-1, S4P-2)", (_name, makeStore) => {
  function storesSetup() {
    const t = setup();
    const { store: watches, held } = makeStore();
    return { ...t, watches, held, deliver: (more: Partial<DeliveryDeps> = {}) => runDelivery({ ...t.deps, watches, ...more }) };
  }

  it("overlapping runs deliver each alert once", async () => {
    const t = storesSetup();
    for (const id of ["a1", "a2", "a3"]) await linked(t.watches, id, CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("tc", COUNTRY_AREA, SENT_AM, UNTIL_PM), product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    await Promise.all([t.deliver(), t.deliver(), t.deliver()]);
    // A chat's one-second gap can leave some for later runs.
    for (let i = 0; i < 3; i++) {
      t.clock.advance(2_000);
      await t.deliver();
    }
    const pairs = t.channel.attempts.map((a) => `${a.chatId} ${/gfa\/(\w+)/.exec(a.text)![1]}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toHaveLength(6);
  });

  it("a run that dies after Telegram took the message leaves its attempt, and the next run sends nothing", async () => {
    const t = storesSetup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    // The send is taken and the function dies before recording it: the run never returns.
    let delivered = () => {};
    const taken = new Promise<void>((resolve) => (delivered = resolve));
    const dying: Channel = {
      send: async (chatId, text) => {
        t.channel.attempts.push({ chatId, text, at: t.clock.ms() });
        delivered();
        return new Promise<SendResult>(() => {});
      },
    };
    void t.deliver({ channel: dying });
    await taken;
    // Its send lease lapses; the next run finds the attempt.
    await new Promise((resolve) => setTimeout(resolve, 8_100));
    expect(await t.watches.alertStates("w1", ["pagasa:p1@1"])).toEqual([expect.stringMatching(/^attempt:\d+$/)]);
    t.clock.advance(10 * 60_000);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], t.clock.now().toISOString()));
    expect(await t.deliver()).toMatchObject({ sent: 0, due: 0 });
    expect(t.channel.attempts).toHaveLength(1);
  }, 15_000);

  it("a failed state write after the send doesn't send it again", async () => {
    const t = storesSetup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], AFTERNOON));
    const settle = t.watches.settleAlert.bind(t.watches);
    t.watches.settleAlert = async () => {
      throw new Error("store down");
    };
    expect(await t.deliver()).toMatchObject({ sent: 1 });
    t.watches.settleAlert = settle;
    t.clock.advance(10 * 60_000);
    await publish(t.advisory, snapshotOf([product("p1", CEBU_AREA, SENT_AM, UNTIL_PM)], t.clock.now().toISOString()));
    expect(await t.deliver()).toMatchObject({ sent: 0, due: 0 });
    expect(t.channel.attempts).toHaveLength(1);
  });

  it("a stopping watcher's sends are refused, alert and commute alike", async () => {
    const t = storesSetup();
    await linked(t.watches, "w1", CEBU_TRIP);
    expect(await t.watches.markStopping("w1")).toBe(true);
    expect(await t.watches.claimAlert("w1", "g1", "pagasa:p1@1", t.clock.ms(), 1_000)).toEqual({ claimed: false, why: "gone" });
    expect(await t.watches.markSending("w1", "g1", { kind: "go", day: "2026-11-04" })).toBe(false);
    expect(await t.watches.markStopping("nobody")).toBe(false);
  });

  it("consecutive alert sends racing a switch-off, on a slow store: nothing is sent after switchOff returns", async () => {
    const t = storesSetup();
    await linked(t.watches, "w1", CEBU_TRIP);
    await publish(t.advisory, snapshotOf(["p1", "p2", "p3", "p4"].map((id) => product(id, CEBU_AREA, SENT_AM, UNTIL_PM)), AFTERNOON));
    // Every store call takes 150 ms more.
    const slow = new Proxy(t.watches, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return value.apply(target, args);
        };
      },
    });
    const sentAt: number[] = [];
    let firstSend = () => {};
    const started = new Promise<void>((resolve) => (firstSend = resolve));
    const channel: Channel = {
      send: async () => {
        sentAt.push(Date.now());
        firstSend();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      },
    };
    const run = t.deliver({ watches: slow, channel });
    await started;
    await switchOff(slow, "w1", { pollMs: 20 });
    const off = Date.now();
    await run;
    expect(sentAt.length).toBeGreaterThanOrEqual(1);
    expect(sentAt.filter((s) => s >= off)).toEqual([]);
    expect(await t.held()).toEqual({});
  }, 20_000);

  it("switching off deletes the route line and alert history, and refreshing keeps them as long as the watcher", async () => {
    const t = storesSetup();
    await linked(t.watches, "w1", CEBU_TRIP);
    expect(await t.watches.saveRoute("w1", "g1", [BANILAD, IT_PARK])).toBe(true);
    expect(await t.watches.saveRoute("w1", "other-gen", [BANILAD, IT_PARK])).toBe(false);
    expect(await t.watches.routes(["w1", "nobody"])).toEqual([[BANILAD, IT_PARK], null]);
    const claim = await t.watches.claimAlert("w1", "g1", "pagasa:p1@1", t.clock.ms(), 1_000);
    expect(claim).toMatchObject({ claimed: true, tries: 0 });
    const held = await t.held();
    expect(Object.keys(held).sort()).toEqual(["lusong:alert-sent:v1:w1", "lusong:watch:index", "lusong:watch:route:v1:w1", "lusong:watch:w:w1"]);
    for (const ttl of Object.values(held)) expect(ttl).toBeGreaterThan(29 * 24 * 3_600_000);
    expect(await t.watches.refresh("w1")).toBe(true);
    await t.watches.remove("w1");
    expect(await t.held()).toEqual({});
  });
});

describe("the watcher's corridor (S4P-6)", () => {
  // A trip whose road bends 5 km east of the straight line between its ends.
  const from = { lat: 10.3, lon: 123.9 };
  const to = { lat: 10.4, lon: 123.9 };
  const bend = { lat: 10.35, lon: 123.9457 };
  const bentLine = [from, bend, to];
  /** A small square around a spot, as a PAGASA polygon (flat lon, lat ring). */
  const squareAt = (p: Point, halfDeg = 0.002) => [p.lon - halfDeg, p.lat - halfDeg, p.lon + halfDeg, p.lat - halfDeg, p.lon + halfDeg, p.lat + halfDeg, p.lon - halfDeg, p.lat + halfDeg, p.lon - halfDeg, p.lat - halfDeg];
  const polygonAlert = (id: string, p: Point) => alert(id, { scope: { areas: [{ desc: id, polygons: [squareAt(p)], geocodes: [] }] } });

  it("a route bending more than 3 km off the straight line between its ends gets an alert on the bend", async () => {
    const t = setup();
    await linked(t.watches, "w1", { from, to });
    expect(await t.watches.saveRoute("w1", "g1", bentLine)).toBe(true);
    // On the bend, and 5 km west of the straight line, where the road doesn't go.
    await t.alerts.addIfAbsent([polygonAlert("on-the-bend", bend), polygonAlert("west", { lat: 10.35, lon: 123.8543 })]);
    await publish(t.advisory, snapshotOf([], AFTERNOON));
    await t.deliver();
    expect(t.channel.attempts.map((a) => a.text)).toEqual([expect.stringContaining("on-the-bend")]);
  });

  it("an alert within 1 km of the stored line touches it; one 2 km off doesn't", () => {
    const corridor = corridorFor({ from, to }, bentLine);
    const near = { lat: 10.35, lon: 123.9457 + 0.008 };
    const far = { lat: 10.35, lon: 123.9457 + 0.02 };
    expect(touches(polygonAlert("near", near), corridor).touches).toBe(true);
    expect(touches(polygonAlert("far", far), corridor).touches).toBe(false);
    expect(touches(alert("pt", { scope: { point: near, radiusM: 0 } }), corridor).touches).toBe(true);
    expect(touches(alert("pt", { scope: { point: far, radiusM: 0 } }), corridor).touches).toBe(false);
  });

  it("before any line is stored, the box around both ends grown by 20 km is the corridor", () => {
    const corridor = corridorFor({ from, to }, null);
    expect(touches(polygonAlert("15 km east", { lat: 10.35, lon: 123.9 + 0.137 }), corridor).touches).toBe(true);
    expect(touches(polygonAlert("30 km east", { lat: 10.35, lon: 123.9 + 0.274 }), corridor).touches).toBe(false);
    expect(touches(alert("codes", { scope: { codes: ["0702200000"] } }), corridor).touches).toBe(true);
    expect(touches(alert("codes", { scope: { codes: ["1102400000"] } }), corridor).touches).toBe(false);
  });

  it("a stored line keeps at most 200 points, its ends and its bends", () => {
    const wiggly = Array.from({ length: 2_000 }, (_, i) => ({ lat: 10.3 + i * 0.00005, lon: 123.9 + (i === 1_000 ? 0.05 : 0) }));
    const simple = simplifyLine(wiggly);
    expect(simple.length).toBeLessThanOrEqual(200);
    expect(simple[0]).toEqual(wiggly[0]);
    expect(simple.at(-1)).toEqual(wiggly.at(-1));
    expect(simple).toContainEqual(wiggly[1_000]);
  });
});

describe("the rider's text", () => {
  it("comes from the template and PAGASA's validated fields only: control characters and long names are cut", () => {
    const a = alert("pagasa:x", { scope: { areas: [] }, fields: { event: "Flood\nAdvisory", sent: SENT_AM, expires: UNTIL_PM } });
    const [p] = pagasaAlerts(snapshotOf([product("x", CEBU_AREA, SENT_AM, UNTIL_PM, "General\u0007 Flood   Advisory\n(Moderate)")], AFTERNOON), new Date(AFTERNOON));
    expect(p.fields).toMatchObject({ event: "General Flood Advisory (Moderate)" });
    expect(alertMessage(a, ["Cebu", "Bohol", "Leyte", "Samar", "x".repeat(100)])).toBe(
      `PAGASA Flood Advisory for Cebu, Bohol, Leyte and 2 more, sent 4 Nov, 5:00 a.m. PHT, until 4 Nov, 5:00 p.m. PHT. https://publicalert.pagasa.dost.gov.ph/output/gfa/pagasa:x.cap`,
    );
  });
});

describe("store commands at 100 watchers with 3 nationwide alerts (S4P-9)", () => {
  it("one list, one route read, one history read per watcher, and five per send", async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) await linked(t.watches, `w${String(i).padStart(3, "0")}`, CEBU_TRIP);
    await publish(t.advisory, snapshotOf(["n1", "n2", "n3"].map((id) => product(id, COUNTRY_AREA, SENT_AM, UNTIL_PM)), AFTERNOON));
    const calls: Record<string, number> = {};
    const count = <T extends object>(store: T, name: string) =>
      new Proxy(store, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls[`${name}.${String(key)}`] = (calls[`${name}.${String(key)}`] ?? 0) + 1;
            return value.apply(target, args);
          };
        },
      });
    const watches = count(t.watches, "watches");
    const alerts = count(t.alerts, "alerts");
    let runs = 0;
    let sent = 0;
    while (sent < 300 && runs < 20) {
      runs += 1;
      sent += (await t.deliver({ watches, alerts })).sent;
      t.clock.advance(2_000);
    }
    expect(sent).toBe(300);
    // 40 sends a run: 8 runs. Measured counts, per run and per send.
    expect(runs).toBe(8);
    expect(calls["watches.list"]).toBe(runs);
    expect(calls["watches.routes"]).toBe(runs);
    expect(calls["watches.alertStates"]).toBeLessThanOrEqual(100 * runs);
    for (const perSend of ["watches.takeSendLease", "watches.claimAlert", "watches.settleAlert", "watches.releaseSendLease", "alerts.isActive"]) {
      expect(calls[perSend]).toBe(300);
    }
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    // Per run: rebuild, alert list, watcher list, cursor read, route read, cursor write; then one history read a watcher.
    expect(total).toBe(runs * (6 + 100) + 300 * 5);
  });
});
