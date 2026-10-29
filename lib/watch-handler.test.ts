import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FakeChannel } from "../test/fake-channel";
import { FEED, SAVED } from "../test/pagasa-fixtures";
import { watchStores } from "../test/watch-stores";
import { FEED_URL } from "./advisory";
import { createBudget, MemoryBudgetStore, type Budget } from "./budget";
import { makeCommuteCheck } from "./commute-handler";
import { MemoryReportStore } from "./report-store";
import { makeValhallaGate, MemorySlotStore, VALHALLA_URL } from "./router";
import { makeTelegramWebhook, makeTickHandler, makeWatchHandler, sameSecret } from "./watch-handler";
import { MemoryWatchStore, type WatchStore } from "./watch-store";
import { runTick, switchOff, TICK_LIMITS, type TickSummary } from "./watch-tick";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };
/** Noon on 2026-10-29: no GFA entry in the saved feed's last 24 h, so no advisory. */
const NOON = new Date("2026-10-29T12:00:00+08:00");
const BOT = "lusong_test_bot";
const HOOK_SECRET = "hook-secret_1";
const TICK_SECRET = "tick-secret_1";

const openBudget = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 100 });

function watchApi(store: WatchStore | null, budget: Budget = openBudget(), botUsername: string | null = BOT) {
  return makeWatchHandler({ store: () => store, budget: () => budget, botUsername: () => botUsername, now: () => NOON });
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1", ...headers },
  });
}

const watchCall = (body: unknown) => post("http://localhost/api/watch", body);
const switchOn = (window = { start: "11:00", end: "13:00" }) => watchCall({ action: "on", from: BANILAD, to: IT_PARK, window });

function telegram(text: string, chat: { id: number; type: string } = { id: 4242, type: "private" }, secret: string | null = HOOK_SECRET) {
  return post(
    "http://localhost/api/watch/telegram",
    { update_id: 1, message: { message_id: 1, date: 0, chat, from: { id: chat.id, is_bot: false, first_name: "R" }, text } },
    secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
  );
}

function codeFrom(link: string): string {
  const url = new URL(link);
  expect(`${url.origin}${url.pathname}`).toBe(`https://t.me/${BOT}`);
  return url.searchParams.get("start")!;
}

/** Switches a watcher on and follows its link from chat 4242; returns the phone's token. */
async function linked(store: WatchStore, channel = new FakeChannel()) {
  const on = await (await watchApi(store)(switchOn())).json();
  const hook = makeTelegramWebhook({ secret: () => HOOK_SECRET, store: () => store, channel: () => channel });
  expect((await hook(telegram(`/start ${codeFrom(on.link)}`))).status).toBe(200);
  return on.watcher as string;
}

describe("sameSecret", () => {
  it("matches only the configured secret, and nothing when none is configured", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("abcd", "abc")).toBe(false);
    expect(sameSecret(null, "abc")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
    expect(sameSecret("abc", undefined)).toBe(false);
  });
});

describe("POST /api/watch", () => {
  it("switching on keeps the trip and window, and hands back a token and a one-time Telegram link", async () => {
    const store = new MemoryWatchStore({ now: () => NOON.getTime() });
    const res = await watchApi(store)(switchOn());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.watcher).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeFrom(body.link)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.window).toEqual({ start: "11:00", end: "13:00" });
    expect(Date.parse(body.linkExpiresAt) - NOON.getTime()).toBe(15 * 60_000);
    const [w] = await store.list();
    expect(w).toMatchObject({ trip: { from: BANILAD, to: IT_PARK }, window: { startMin: 660, endMin: 780 }, chatId: null });
    // The store is keyed by a hash of the token, so what it holds can't switch a watcher off.
    expect(JSON.stringify(store.ttls())).not.toContain(body.watcher);
  });

  it("says the watcher isn't set up yet when there is no bot or no store, and keeps nothing", async () => {
    const store = new MemoryWatchStore();
    for (const api of [watchApi(store, openBudget(), null), watchApi(null)]) {
      const res = await api(switchOn());
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("The watcher isn't set up yet.");
    }
    expect(store.ttls()).toEqual({});
  });

  it.each([
    ["no trip", { action: "on", window: { start: "06:00", end: "08:00" } }],
    ["an end outside Metro Cebu", { action: "on", from: BANILAD, to: { lat: 35.68, lon: 139.76 }, window: { start: "06:00", end: "08:00" } }],
    ["a window that ends before it starts", { action: "on", from: BANILAD, to: IT_PARK, window: { start: "08:00", end: "06:00" } }],
    ["a window over 4 hours", { action: "on", from: BANILAD, to: IT_PARK, window: { start: "05:00", end: "09:30" } }],
    ["an unknown action", { action: "explode" }],
    ["a token that isn't one", { action: "off", watcher: "../../etc" }],
    ["not JSON", "{"],
  ])("refuses %s", async (_label, body) => {
    const store = new MemoryWatchStore();
    expect((await watchApi(store)(watchCall(body))).status).toBe(400);
    expect(store.ttls()).toEqual({});
  });

  it("switching on goes through the per-address admission", async () => {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 1 });
    const admit = vi.spyOn(budget, "admit");
    const api = watchApi(new MemoryWatchStore(), budget);
    expect((await api(switchOn())).status).toBe(200);
    expect((await api(switchOn())).status).toBe(429);
    expect(admit.mock.calls[0][0]).toBe("192.0.2.1");
  });

  it("says so when Lusong is already watching as many trips as it can", async () => {
    const res = await watchApi(new MemoryWatchStore({ maxWatchers: 0 }))(switchOn());
    expect(res.status).toBe(409);
  });

  it("status says waiting, then linked once the rider follows the link; a new link replaces the old", async () => {
    const store = new MemoryWatchStore();
    const api = watchApi(store);
    const on = await (await api(switchOn())).json();
    expect(await (await api(watchCall({ action: "status", watcher: on.watcher }))).json()).toEqual({ state: "waiting", window: { start: "11:00", end: "13:00" } });
    const again = await (await api(watchCall({ action: "link", watcher: on.watcher }))).json();
    const hook = makeTelegramWebhook({ secret: () => HOOK_SECRET, store: () => store, channel: () => new FakeChannel() });
    await hook(telegram(`/start ${codeFrom(on.link)}`));
    expect((await (await api(watchCall({ action: "status", watcher: on.watcher }))).json()).state).toBe("waiting");
    await hook(telegram(`/start ${codeFrom(again.link)}`));
    expect((await (await api(watchCall({ action: "status", watcher: on.watcher }))).json()).state).toBe("linked");
  });

  it("status and link for a watcher that is gone say it is off", async () => {
    const api = watchApi(new MemoryWatchStore());
    const token = "x".repeat(43);
    for (const action of ["status", "link"]) {
      const res = await api(watchCall({ action, watcher: token }));
      expect(res.status).toBe(404);
      expect((await res.json()).state).toBe("off");
    }
  });

  it("switching off when the store fails says so, so the phone keeps the token to try again", async () => {
    const store = new MemoryWatchStore();
    const token = await linked(store);
    store.remove = async () => {
      throw new Error("store down");
    };
    expect((await watchApi(store)(watchCall({ action: "off", watcher: token }))).status).toBe(503);
  });
});

/** Acceptance criterion 3. */
describe.each(watchStores)("switching a watcher off, against the %s", (_name, make) => {
  it("deletes its trip, chat binding, history and link code: no key of it is left", async () => {
    const { store, held } = make();
    const channel = new FakeChannel();
    const token = await linked(store, channel);
    const second = await (await watchApi(store)(switchOn({ start: "06:00", end: "08:00" }))).json();
    const before = await held();
    expect(Object.keys(before).some((k) => k.startsWith("lusong:watch-code:"))).toBe(true);
    // History: a tick that sends a message records the answer it sent.
    await runTick({ store, channel, now: () => NOON, pageUrl: "https://lusong.example/", check: async () => ({ ok: true, kind: "go" }) });
    expect(channel.sent.at(-1)?.text).toContain("At 12:00 PHT: Go");
    expect((await store.list()).find((w) => w.chatId === "4242")?.lastKind).toBe("go");

    const api = watchApi(store);
    for (const t of [token, second.watcher]) {
      const res = await api(watchCall({ action: "off", watcher: t }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: "off" });
    }
    expect(await held()).toEqual({});
    expect((await api(watchCall({ action: "status", watcher: token }))).status).toBe(404);
    // Switching off twice is still off.
    expect((await api(watchCall({ action: "off", watcher: token }))).status).toBe(200);
  });
});

describe.each(watchStores)("switching a watcher off while a message is being sent, against the %s", (_name, make) => {
  it("returns only after the send it found under way: never a send after it says off", async () => {
    const { store, held } = make();
    const channel = new FakeChannel();
    const token = await linked(store, channel);
    const events: string[] = [];
    const send = channel.send.bind(channel);
    channel.send = async (chatId, text) => {
      events.push("send");
      return send(chatId, text);
    };
    // The tick pauses right after its last check that the watcher is still on.
    let paused!: () => void;
    const atPause = new Promise<void>((resolve) => (paused = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const markSending = store.markSending.bind(store);
    store.markSending = async (...args) => {
      const current = await markSending(...args);
      paused();
      await gate;
      return current;
    };
    const tick = runTick({ store, channel, now: () => NOON, pageUrl: "https://lusong.example/", check: async () => ({ ok: true, kind: "go" }) });
    await atPause;
    const off = watchApi(store)(watchCall({ action: "off", watcher: token })).then((res) => events.push(`off ${res.status}`));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([]);
    resume();
    await Promise.all([tick, off]);
    expect(events).toEqual(["send", "off 200"]);
    expect(await held()).toEqual({});
  });

  it("a switch-off that can't get the send lease within its wait deletes the watcher anyway", async () => {
    const { store, held } = make();
    const token = await linked(store);
    const id = (await store.list())[0].id;
    expect(await store.takeSendLease(id, 60_000)).not.toBeNull();
    const started = Date.now();
    await switchOff(store, id, { waitMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(await held()).toEqual({});
    expect((await watchApi(store)(watchCall({ action: "status", watcher: token }))).status).toBe(404);
  });
});

describe("POST /api/watch/telegram", () => {
  const hookWith = (store: WatchStore, channel: FakeChannel, secret: { value: string | undefined } = { value: HOOK_SECRET }) =>
    makeTelegramWebhook({ secret: () => secret.value, store: () => store, channel: () => channel });

  it("refuses every call while its secret is unset, and any call without the matching header", async () => {
    const store = new MemoryWatchStore();
    const on = await (await watchApi(store)(switchOn())).json();
    const channel = new FakeChannel();
    expect((await hookWith(store, channel, { value: undefined })(telegram(`/start ${codeFrom(on.link)}`))).status).toBe(503);
    expect((await hookWith(store, channel)(telegram(`/start ${codeFrom(on.link)}`, undefined, null))).status).toBe(401);
    expect((await hookWith(store, channel)(telegram(`/start ${codeFrom(on.link)}`, undefined, "wrong"))).status).toBe(401);
    expect((await store.list())[0].chatId).toBeNull();
    expect(channel.sent).toEqual([]);
  });

  it("binds the chat on /start with the code, and says what will happen", async () => {
    const store = new MemoryWatchStore();
    const on = await (await watchApi(store)(switchOn())).json();
    const channel = new FakeChannel();
    expect((await hookWith(store, channel)(telegram(`/start ${codeFrom(on.link)}`))).status).toBe(200);
    expect((await store.list())[0].chatId).toBe("4242");
    expect(channel.sent).toEqual([
      {
        chatId: "4242",
        text: "Linked. Lusong will message you here between 11:00 and 13:00 PHT: once when the window opens, and again whenever the answer changes. To stop, switch the watcher off on Lusong's page; that deletes your trip from Lusong's server.",
      },
    ]);
  });

  it("a used or unknown code links nothing and says to get a new link", async () => {
    const store = new MemoryWatchStore();
    const on = await (await watchApi(store)(switchOn())).json();
    const channel = new FakeChannel();
    const hook = hookWith(store, channel);
    await hook(telegram(`/start ${codeFrom(on.link)}`));
    expect((await hook(telegram(`/start ${codeFrom(on.link)}`, { id: 777, type: "private" }))).status).toBe(200);
    expect((await store.list())[0].chatId).toBe("4242");
    expect(channel.sent[1]).toEqual({
      chatId: "777",
      text: "That link has expired or was already used. Open Lusong and press “Get a new Telegram link”.",
    });
  });

  it("links no group chat, and answers other messages with nothing", async () => {
    const store = new MemoryWatchStore();
    const on = await (await watchApi(store)(switchOn())).json();
    const channel = new FakeChannel();
    const hook = hookWith(store, channel);
    expect((await hook(telegram(`/start ${codeFrom(on.link)}`, { id: -100, type: "group" }))).status).toBe(200);
    expect((await hook(telegram("hello"))).status).toBe(200);
    expect((await hook(post("http://localhost/api/watch/telegram", { update_id: 2 }, { "x-telegram-bot-api-secret-token": HOOK_SECRET }))).status).toBe(200);
    expect((await store.list())[0].chatId).toBeNull();
    expect(channel.sent).toEqual([]);
  });

  it("a store that fails is a 500, so Telegram sends the update again", async () => {
    const store = new MemoryWatchStore();
    store.redeem = async () => {
      throw new Error("store down");
    };
    expect((await hookWith(store, new FakeChannel())(telegram("/start abcdefghijklmnopqrstuvwxyz012345"))).status).toBe(500);
  });
});

/** PAGASA's saved feed and Valhalla's saved Banilad to IT Park route, answered here: nothing leaves the test. */
function savedNetwork() {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const pagasa: Record<string, string> = { [FEED_URL]: FEED, ...SAVED };
    if (u in pagasa) return new Response(pagasa[u]);
    if (u === `${VALHALLA_URL}/route`) return new Response(readFileSync("test/fixtures/valhalla/banilad-itpark-plain.json", "utf8"));
    throw new TypeError("fetch failed");
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("POST /api/watch/tick", () => {
  const tickWith = (
    secret: string | undefined,
    tick = vi.fn<(pageUrl: string) => Promise<TickSummary>>(async () => ({ ok: true, due: 0, checked: 0, sent: 0, failed: 0, deferred: 0 })),
  ) => ({
    handler: makeTickHandler({ secret: () => secret, tick }),
    tick,
  });
  const tickCall = (auth?: string) => post("https://lusong.example/api/watch/tick", "", auth ? { authorization: auth } : {});

  it("refuses every call while its secret is unset", async () => {
    const { handler, tick } = tickWith(undefined);
    expect((await handler(tickCall("Bearer "))).status).toBe(503);
    expect((await handler(tickCall("Bearer undefined"))).status).toBe(503);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a call without the secret", async () => {
    const { handler, tick } = tickWith(TICK_SECRET);
    expect((await handler(tickCall())).status).toBe(401);
    expect((await handler(tickCall(`Bearer ${TICK_SECRET}x`))).status).toBe(401);
    expect((await handler(tickCall(TICK_SECRET))).status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
  });

  it("runs a tick with the secret, linking messages to the page it was called on", async () => {
    const { handler, tick } = tickWith(TICK_SECRET);
    const res = await handler(tickCall(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(200);
    expect(tick).toHaveBeenCalledWith("https://lusong.example/");
  });

  it("keeps the tick's budget under the route's 60 s limit", () => {
    // The route module imports through the "@/" alias, which vitest doesn't resolve, so its limit is read from source.
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/watch/tick/route.ts", "utf8"))?.[1]);
    expect(maxDuration).toBe(60);
    expect(TICK_LIMITS.budgetMs).toBeLessThanOrEqual(maxDuration * 1_000 - 10_000);
  });

  /** Acceptance criterion 4. */
  it("a scheduled run counts against the daily cap, not the per-address limit: a used-up address doesn't stop it", async () => {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 1 });
    const admit = vi.spyOn(budget, "admit");
    const store = new MemoryWatchStore();
    const channel = new FakeChannel();
    // Switching on is the address's one admission for the day.
    await linked(store, channel);
    expect((await watchApi(store, budget)(switchOn())).status).toBe(200);
    expect((await watchApi(store, budget)(switchOn())).status).toBe(429);
    const net = savedNetwork();
    const gate = makeValhallaGate(new MemorySlotStore());
    const commute = makeCommuteCheck({ fetch: net.fetch, now: () => NOON, gate: () => gate, budget: () => budget, reports: () => new MemoryReportStore() });
    const { handler } = tickWith(TICK_SECRET, vi.fn((pageUrl: string) => runTick({ store, channel, now: () => NOON, pageUrl, check: commute.checkTrip })));
    admit.mockClear();

    const res = await handler(tickCall(`Bearer ${TICK_SECRET}`));
    expect(await res.json()).toMatchObject({ ok: true, checked: 1, sent: 1, failed: 0 });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0][0]).toBeNull();
    expect(channel.sent.at(-1)).toEqual({
      chatId: "4242",
      text: "Lusong is watching your trip until 13:00 PHT.\nAt 12:00 PHT: Go\nOpen Lusong and check your trip to see why: https://lusong.example/",
    });
    expect(net.calls.filter((u) => u.startsWith(VALHALLA_URL))).toHaveLength(1);
  });

  it("a tick refused by the daily cap sends nothing", async () => {
    const budget = openBudget();
    expect((await budget.admit("192.0.2.9", NOON, 10_000_000)).ok).toBe(true);
    const store = new MemoryWatchStore();
    const channel = new FakeChannel();
    await linked(store, channel);
    const net = savedNetwork();
    const gate = makeValhallaGate(new MemorySlotStore());
    const commute = makeCommuteCheck({ fetch: net.fetch, now: () => NOON, gate: () => gate, budget: () => budget, reports: () => new MemoryReportStore() });
    const sentBefore = channel.sent.length;
    expect(await runTick({ store, channel, now: () => NOON, pageUrl: "https://lusong.example/", check: commute.checkTrip })).toMatchObject({ checked: 1, sent: 0, failed: 1 });
    expect(channel.sent).toHaveLength(sentBefore);
    expect(net.calls).toHaveLength(0);
  });
});
