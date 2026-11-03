import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChannel } from "../test/fake-channel";
import type { AnswerKind } from "./answer";
import { SEND_TIMEOUT_MS, TelegramChannel } from "./channel";
import { COMMUTE_TIMING, type ScheduledCheck } from "./commute-handler";
import { watchStores } from "../test/watch-stores";
import { MemoryWatchStore, type NewWatcher, type WatchStore } from "./watch-store";
import { runTick, SEND_LEASE_MS, TICK_LIMITS, type TickDeps } from "./watch-tick";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };
const PAGE = "https://lusong.example/";

/** A clock the test moves, read by the tick and the store alike. */
function fakeClock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), ms: () => t, set: (next: string) => (t = Date.parse(next)), advance: (ms: number) => (t += ms) };
}

async function linkedWatcher(store: WatchStore, overrides: Partial<NewWatcher> = {}, chatId = "4242") {
  const w: NewWatcher = { id: "a".repeat(64), gen: "g1", trip: { from: BANILAD, to: IT_PARK }, window: { startMin: 360, endMin: 480 }, ...overrides };
  await store.create(w, `code-${w.id.slice(0, 4)}`);
  await store.redeem(`code-${w.id.slice(0, 4)}`, chatId);
  return w;
}

function setup(start = "2026-10-30T05:50:00+08:00") {
  const clock = fakeClock(start);
  const store = new MemoryWatchStore({ now: clock.ms });
  const channel = new FakeChannel();
  const answers: (AnswerKind | "fails")[] = [];
  const checked: { from: unknown; to: unknown }[] = [];
  const deps: TickDeps = {
    store,
    channel,
    now: clock.now,
    pageUrl: PAGE,
    check: async (trip): Promise<ScheduledCheck> => {
      checked.push(trip);
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer scripted for this check");
      return next === "fails" ? { ok: false, status: 503 } : { ok: true, kind: next };
    },
  };
  return { clock, store, channel, answers, checked, deps, tick: () => runTick(deps) };
}

/** Telegram's Bot API faked at fetch: every request is counted, as if Telegram had it, before the reply is decided. */
function telegramAt(replies: ("ok" | "timeout" | 429)[]) {
  const requests: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).text);
    const reply = replies.shift() ?? "ok";
    if (reply === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (reply === 429) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }), { status: 429 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  return { requests, channel: new TelegramChannel("TEST-TOKEN", fetch) };
}

describe("the watcher's tick (fake clock, fake channel)", () => {
  it("one message when the window opens, one per answer change, none otherwise", async () => {
    const { clock, store, channel, answers, checked, tick } = setup();
    await linkedWatcher(store);

    // [PHT time, what the check answers or "none" when no check should run, messages sent so far]
    const steps: [string, AnswerKind | "fails" | "none", number][] = [
      ["2026-10-30T05:50:00+08:00", "none", 0], // before the window
      ["2026-10-30T06:00:00+08:00", "go", 1], // the window opens
      ["2026-10-30T06:10:00+08:00", "go", 1], // unchanged
      ["2026-10-30T06:20:00+08:00", "wait", 2], // changed
      ["2026-10-30T06:30:00+08:00", "fails", 2], // the check fails: nothing, and Wait is kept
      ["2026-10-30T06:40:00+08:00", "wait", 2], // unchanged from the kept Wait
      ["2026-10-30T06:50:00+08:00", "go_another_way", 3], // changed
      ["2026-10-30T08:00:00+08:00", "none", 3], // the window has closed
      ["2026-10-30T12:00:00+08:00", "none", 3],
      ["2026-10-31T06:00:00+08:00", "go_another_way", 4], // the next day's window opens, even on the same answer
      ["2026-10-31T06:10:00+08:00", "go_another_way", 4],
    ];
    let checks = 0;
    for (const [at, answer, messages] of steps) {
      clock.set(at);
      if (answer !== "none") {
        answers.push(answer);
        checks += 1;
      }
      await tick();
      expect(checked, at).toHaveLength(checks);
      expect(channel.sent, at).toHaveLength(messages);
    }
    expect(answers).toEqual([]);
    expect(checked[0]).toEqual({ from: BANILAD, to: IT_PARK });
    expect(channel.sent.map((m) => m.chatId)).toEqual(["4242", "4242", "4242", "4242"]);
    expect(channel.sent.map((m) => m.text)).toEqual([
      "Lusong is watching your trip until 08:00 PHT.\nAt 06:00 PHT: Go\nOpen Lusong and check your trip to see why: https://lusong.example/",
      "Your answer changed at 06:20 PHT: Wait. Check again in 30 minutes.\nIt was: Go\nOpen Lusong and check your trip to see why: https://lusong.example/",
      "Your answer changed at 06:50 PHT: Go another way\nIt was: Wait. Check again in 30 minutes.\nOpen Lusong and check your trip to see why: https://lusong.example/",
      "Lusong is watching your trip until 08:00 PHT.\nAt 06:00 PHT: Go another way\nOpen Lusong and check your trip to see why: https://lusong.example/",
    ]);
  });

  it("a check that fails at the window's opening sends nothing; the next one that answers opens it", async () => {
    const { clock, store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    answers.push("fails");
    await tick();
    expect(channel.sent).toHaveLength(0);
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("no_one_knows");
    await tick();
    expect(channel.sent.map((m) => m.text.split("\n")[1])).toEqual(["At 06:10 PHT: No one knows"]);
  });

  it("checks a watcher at most once in 10 minutes, however often the scheduler calls", async () => {
    const { clock, store, channel, answers, checked, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    answers.push("go");
    await tick();
    clock.advance(60_000);
    await tick();
    clock.advance(5 * 60_000);
    await tick();
    expect(checked).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
  });

  it("checks no watcher that isn't linked to a chat yet", async () => {
    const { store, channel, checked, tick } = setup("2026-10-30T06:00:00+08:00");
    await store.create({ id: "b".repeat(64), gen: "g1", trip: { from: BANILAD, to: IT_PARK }, window: { startMin: 360, endMin: 480 } }, "c");
    expect(await tick()).toMatchObject({ checked: 0, sent: 0 });
    expect(checked).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });

  it("a watcher switched off while its check runs sends nothing and leaves nothing behind", async () => {
    const { store, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    const w = await linkedWatcher(store);
    deps.check = async () => {
      await store.remove(w.id);
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    expect(channel.sent).toHaveLength(0);
    expect(store.ttls()).toEqual({});
  });

  it("a message Telegram didn't take is sent again at the next check, not lost", async () => {
    const { clock, store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    channel.next = [{ ok: false, rejected: true, permanent: false }];
    answers.push("go");
    expect(await tick()).toMatchObject({ sent: 0, failed: 1 });
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("go");
    expect(await tick()).toMatchObject({ sent: 1 });
    expect(channel.sent[0].text).toContain("At 06:10 PHT: Go");
  });

  it("a message Telegram took counts as sent even when recording it fails: the next check doesn't send it again", async () => {
    const { clock, store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    const commit = store.commit.bind(store);
    let commits = 0;
    store.commit = async (...args) => {
      commits += 1;
      if (commits === 1) throw new Error("store down");
      return commit(...args);
    };
    answers.push("go");
    await tick();
    expect(channel.sent).toHaveLength(1);
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("go");
    await tick();
    expect(channel.sent).toHaveLength(1);
  });

  it("a message Telegram may have taken (no reply before the timeout) counts as sent: it isn't sent again", async () => {
    const { clock, store, answers, deps } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    const telegram = telegramAt(["timeout"]);
    deps.channel = telegram.channel;
    answers.push("go");
    await runTick(deps);
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("go");
    await runTick(deps);
    expect(telegram.requests).toHaveLength(1);
    // A later change is told against the answer that may have gone.
    clock.set("2026-10-30T06:20:00+08:00");
    answers.push("wait");
    await runTick(deps);
    expect(telegram.requests).toHaveLength(2);
    expect(telegram.requests[1]).toContain("It was: Go");
  });

  it("a message Telegram refused (a 429) is sent again at the next check", async () => {
    const { clock, store, answers, deps } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    const telegram = telegramAt([429, "ok"]);
    deps.channel = telegram.channel;
    answers.push("go");
    expect(await runTick(deps)).toMatchObject({ sent: 0, failed: 1 });
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("go");
    expect(await runTick(deps)).toMatchObject({ sent: 1 });
    expect(telegram.requests).toHaveLength(2);
    expect(telegram.requests[1]).toContain("At 06:10 PHT: Go");
  });

  it("a chat that has blocked the bot switches its watcher off", async () => {
    const { store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    const w = await linkedWatcher(store);
    channel.next = [{ ok: false, rejected: true, permanent: true }];
    answers.push("go");
    await tick();
    expect(await store.get(w.id)).toBeNull();
    expect(store.ttls()).toEqual({});
  });

  it("a check that runs past the window's end sends nothing", async () => {
    const { clock, store, channel, deps } = setup("2026-10-30T07:59:55+08:00");
    await linkedWatcher(store);
    deps.check = async () => {
      clock.set("2026-10-30T08:00:01+08:00");
      return { ok: true, kind: "go" };
    };
    expect(await runTick(deps)).toMatchObject({ checked: 1, sent: 0 });
    expect(channel.sent).toEqual([]);
  });

  it("a later watcher whose window has closed by its turn in the tick isn't checked", async () => {
    const { clock, store, channel, deps } = setup("2026-10-30T07:59:50+08:00");
    await linkedWatcher(store, { id: "a".repeat(64) }, "1");
    await linkedWatcher(store, { id: "b".repeat(64) }, "2");
    const checked: number[] = [];
    deps.check = async () => {
      checked.push(clock.ms());
      clock.set("2026-10-30T08:00:00+08:00");
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    expect(checked).toEqual([Date.parse("2026-10-30T07:59:50+08:00")]);
    expect(channel.sent).toEqual([]);
  });

  it("a message tells the time the answer was sent, not the time the tick began", async () => {
    const { clock, store, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    deps.check = async () => {
      clock.set("2026-10-30T06:04:30+08:00");
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    expect(channel.sent.map((m) => m.text.split("\n")[1])).toEqual(["At 06:04 PHT: Go"]);
  });

  it("a watcher whose switch-off is under way sends nothing", async () => {
    const { store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    const w = await linkedWatcher(store);
    // The switch-off holds the watcher's send lease while it deletes it.
    expect(await store.takeSendLease(w.id, 60_000)).not.toBeNull();
    answers.push("go");
    await tick();
    expect(channel.sent).toEqual([]);
  });

  it("a send that couldn't end inside its lease isn't started, and the answer is sent at the next check", async () => {
    const { clock, store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    // The store answers so slowly that less than Telegram's timeout is left of the lease when the send would start.
    const realNow = Date.now.bind(Date);
    let lag = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + lag);
    const markSending = store.markSending.bind(store);
    store.markSending = async (...args) => {
      lag += SEND_LEASE_MS - SEND_TIMEOUT_MS;
      return markSending(...args);
    };
    try {
      answers.push("go");
      expect(await tick()).toMatchObject({ sent: 0, failed: 1 });
      expect(channel.sent).toEqual([]);
      store.markSending = markSending;
      clock.set("2026-10-30T06:10:00+08:00");
      answers.push("go");
      expect(await tick()).toMatchObject({ sent: 1 });
    } finally {
      now.mockRestore();
    }
  });

  it("a store that can't be read sends nothing and says so", async () => {
    const { store, channel, tick } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    store.list = async () => {
      throw new Error("store down");
    };
    expect(await tick()).toMatchObject({ ok: false, sent: 0 });
    expect(channel.sent).toHaveLength(0);
  });

  it("a check that throws is a failed check: nothing sent, and the other watchers still run", async () => {
    const { store, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store, { id: "a".repeat(64) }, "1");
    await linkedWatcher(store, { id: "b".repeat(64) }, "2");
    let calls = 0;
    deps.check = async () => {
      calls += 1;
      if (calls === 1) throw new Error("router unreachable");
      return { ok: true, kind: "go" };
    };
    expect(await runTick(deps)).toMatchObject({ checked: 2, sent: 1, failed: 1 });
    expect(channel.sent).toHaveLength(1);
  });

  it("checks at most the per-tick cap, the longest-unchecked first, and the rest at the next tick", async () => {
    const { clock, store, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    for (const c of "abcde") await linkedWatcher(store, { id: c.repeat(64) }, c);
    deps.limits = { maxPerTick: 3 };
    deps.check = async () => ({ ok: true, kind: "go" });
    expect(await runTick(deps)).toMatchObject({ due: 5, checked: 3, deferred: 2 });
    clock.advance(60_000);
    expect(await runTick(deps)).toMatchObject({ due: 2, checked: 2, deferred: 0 });
    expect(new Set(channel.sent.map((m) => m.chatId))).toEqual(new Set("abcde"));
  });

  it("starts no check without the time one needs left in the tick's budget", async () => {
    const { store, deps } = setup("2026-10-30T06:00:00+08:00");
    for (const c of "abc") await linkedWatcher(store, { id: c.repeat(64) }, c);
    let elapsed = 0;
    deps.elapsedMs = () => elapsed;
    deps.limits = { budgetMs: 45_000, minCheckMs: 15_000 };
    deps.check = async () => {
      elapsed += 20_000;
      return { ok: true, kind: "go" };
    };
    expect(await runTick(deps)).toMatchObject({ due: 3, checked: 2, deferred: 1 });
  });

  it("gives each trip its own deadline from when its check starts: the whole check when the tick has that long, else the checks' end (#26)", async () => {
    const { store, deps } = setup("2026-10-30T06:00:00+08:00");
    for (const c of "ab") await linkedWatcher(store, { id: c.repeat(64) }, c);
    let elapsed = 0;
    deps.elapsedMs = () => elapsed;
    deps.limits = { budgetMs: 300_000, afterCheckMs: 10_000, checkMs: 85_000 };
    const offsets: number[] = [];
    const started = Date.now();
    deps.check = async (_trip, opts) => {
      offsets.push(opts.deadline - started);
      elapsed += 30_000;
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    // Not one deadline shared by the tick: the second trip's is counted from its own start, 30 s later.
    expect(offsets[0]).toBeGreaterThanOrEqual(85_000);
    expect(offsets[0]).toBeLessThan(85_000 + 1_000);
    expect(offsets[1]).toBeGreaterThanOrEqual(115_000);
    expect(offsets[1]).toBeLessThan(115_000 + 1_000);
  });

  it("the first trip of a real tick gets a full check's budget, capped at the checks' end: 45 s in, 10 s before the tick's end for its send (#26)", async () => {
    const { store, deps } = setup("2026-10-30T06:00:00+08:00");
    for (const c of "ab") await linkedWatcher(store, { id: c.repeat(64) }, c);
    const deadlines: number[] = [];
    const before = Date.now();
    deps.check = async (_trip, opts) => {
      deadlines.push(opts.deadline);
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    const checksEnd = TICK_LIMITS.budgetMs - TICK_LIMITS.afterCheckMs;
    expect(checksEnd).toBe(45_000);
    // The whole check would end 85 s after its start; the tick's end comes first.
    expect(TICK_LIMITS.checkMs).toBe(COMMUTE_TIMING.deadlineMs + COMMUTE_TIMING.storeCallMs);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + checksEnd);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + checksEnd);
  });

  it("a trip with too little of the tick left is deferred, and goes first at the next tick, ahead of a watcher unchecked for longer whose window opened since (#26)", async () => {
    const { clock, store, deps } = setup("2026-10-30T06:00:00+08:00");
    // Each trip its own ends, so the check can tell them apart.
    const a = await linkedWatcher(store, { id: "a".repeat(64), trip: { from: BANILAD, to: IT_PARK } }, "a");
    const b = await linkedWatcher(store, { id: "b".repeat(64), trip: { from: IT_PARK, to: BANILAD } }, "b");
    // c's window opens at 06:05. Last checked yesterday, earlier in the day than b was, so it is unchecked for longer.
    const c = await linkedWatcher(store, { id: "c".repeat(64), trip: { from: BANILAD, to: BANILAD }, window: { startMin: 365, endMin: 480 } }, "c");
    expect(await store.claimRun(c.id, c.gen, Date.parse("2026-10-29T06:05:00+08:00"), 0)).toBe(true);
    expect(await store.claimRun(b.id, b.gen, Date.parse("2026-10-29T07:50:00+08:00"), 0)).toBe(true);
    const name = new Map([a, b, c].map((w) => [JSON.stringify(w.trip), w.id[0]]));
    let elapsed = 0;
    deps.elapsedMs = () => elapsed;
    const order: string[] = [];
    deps.check = async (trip) => {
      order.push(name.get(JSON.stringify(trip))!);
      // 35 s a check: after one, 10 s is left before the checks' end, short of the 15 s a check needs.
      elapsed += 35_000;
      return { ok: true, kind: "go" };
    };

    expect(await runTick(deps)).toMatchObject({ due: 2, checked: 1, deferred: 1 });
    expect(order).toEqual(["a"]);

    clock.set("2026-10-30T06:10:00+08:00");
    elapsed = 0;
    expect(await runTick(deps)).toMatchObject({ due: 3, checked: 1, deferred: 2 });
    // By its last check alone, c would go first: yesterday 06:05, before b's 07:50.
    expect(order).toEqual(["a", "b"]);

    clock.set("2026-10-30T06:20:00+08:00");
    elapsed = 0;
    expect(await runTick(deps)).toMatchObject({ due: 3, checked: 1, deferred: 2 });
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("the watcher's tick keeps inside its budget with slow dependencies (fake timers, #26)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every call to the store waits `storeMs`; each check runs to its deadline; Telegram takes its whole timeout. */
  function slowTick(storeMs: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { store, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
    const slow = new Proxy(store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await wait(storeMs);
          return value.apply(target, args);
        };
      },
    });
    const sends: number[] = [];
    deps.store = slow;
    deps.channel = {
      send: async (chatId, text) => {
        sends.push(Date.now());
        await wait(SEND_TIMEOUT_MS);
        return channel.send(chatId, text);
      },
    };
    deps.check = async (_trip, opts) => {
      await wait(opts.deadline - Date.now());
      return { ok: true, kind: "go", line: [BANILAD, IT_PARK] };
    };
    return { store, channel, deps, sends };
  }

  async function timed(deps: TickDeps) {
    const started = Date.now();
    let summary: Awaited<ReturnType<typeof runTick>> | undefined;
    void runTick(deps).then((s) => (summary = s));
    for (let i = 0; i < 1_000 && !summary; i++) await vi.advanceTimersByTimeAsync(100);
    return { summary: summary!, started, tookMs: Date.now() - started };
  }

  it.each([
    { storeMs: 1_000, sent: 1 },
    { storeMs: 4_000, sent: 0 },
    { storeMs: 20_000, sent: 0 },
  ])("a store taking $storeMs ms a call: the tick ends inside its 55 s, and sends $sent", async ({ storeMs, sent }) => {
    const { store, deps, sends, channel } = slowTick(storeMs);
    for (const c of "abc") await linkedWatcher(store, { id: c.repeat(64) }, c);

    const { summary, started, tookMs } = await timed(deps);

    expect(summary).toBeDefined();
    expect(tookMs).toBeLessThanOrEqual(TICK_LIMITS.budgetMs);
    expect(TICK_LIMITS.budgetMs).toBe(55_000);
    expect(channel.sent).toHaveLength(sent);
    expect(summary.sent).toBe(sent);
    // A send is started only when it ends before the tick does.
    for (const at of sends) expect(at + SEND_TIMEOUT_MS).toBeLessThanOrEqual(started + TICK_LIMITS.budgetMs);
  });

  it("with a quick store, a check that runs to its deadline still leaves its send the time it needs", async () => {
    const { store, deps, channel } = slowTick(0);
    for (const c of "abc") await linkedWatcher(store, { id: c.repeat(64) }, c);

    const { summary, tookMs } = await timed(deps);

    expect(summary).toMatchObject({ due: 3, checked: 1, sent: 1, deferred: 2 });
    expect(channel.sent).toHaveLength(1);
    expect(tookMs).toBeLessThanOrEqual(TICK_LIMITS.budgetMs);
  });
});

/** The same sequences on every store, since what counts as sent lives in the store. */
describe.each(watchStores)("the watcher's tick on the %s", (_name, make) => {
  /** Go is sent and recorded at 06:00; Wait is handed to Telegram at 06:20, which doesn't answer before the timeout. */
  async function goSentThenWaitUncertain(then: "ok" | 429) {
    const t = setup("2026-10-30T06:00:00+08:00");
    t.deps.store = make().store;
    const w = await linkedWatcher(t.deps.store);
    const telegram = telegramAt(["ok", "timeout", then]);
    t.deps.channel = telegram.channel;
    t.answers.push("go");
    await runTick(t.deps);
    t.clock.set("2026-10-30T06:20:00+08:00");
    t.answers.push("wait");
    await runTick(t.deps);
    expect(telegram.requests).toHaveLength(2);
    return { ...t, w, telegram };
  }

  it("after an uncertain Wait, a Go Telegram refuses (a 429) leaves Wait as the last sent: a later Wait sends nothing", async () => {
    const { clock, answers, deps, telegram } = await goSentThenWaitUncertain(429);
    clock.set("2026-10-30T06:30:00+08:00");
    answers.push("go");
    expect(await runTick(deps)).toMatchObject({ sent: 0, failed: 1 });
    expect(telegram.requests).toHaveLength(3);
    clock.set("2026-10-30T06:40:00+08:00");
    answers.push("wait");
    expect(await runTick(deps)).toMatchObject({ sent: 0 });
    expect(telegram.requests).toHaveLength(3);
  });

  it("after an uncertain Wait, a Go whose send is called off for want of lease leaves Wait as the last sent: a later Wait sends nothing", async () => {
    const { clock, answers, deps, telegram } = await goSentThenWaitUncertain("ok");
    const store = deps.store;
    const realNow = Date.now.bind(Date);
    let lag = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + lag);
    const markSending = store.markSending.bind(store);
    store.markSending = async (...args) => {
      lag += SEND_LEASE_MS - SEND_TIMEOUT_MS;
      return markSending(...args);
    };
    try {
      clock.set("2026-10-30T06:30:00+08:00");
      answers.push("go");
      expect(await runTick(deps)).toMatchObject({ sent: 0, failed: 1 });
      expect(telegram.requests).toHaveLength(2);
    } finally {
      now.mockRestore();
      store.markSending = markSending;
    }
    clock.set("2026-10-30T06:40:00+08:00");
    answers.push("wait");
    expect(await runTick(deps)).toMatchObject({ sent: 0 });
    expect(telegram.requests).toHaveLength(2);
  });

  /** The fake clock moves by `ms` while the store records the answer about to go; the lease's real time doesn't. */
  function slowMark(store: WatchStore, clock: { advance: (ms: number) => void }, ms: number) {
    const markSending = store.markSending.bind(store);
    store.markSending = async (...args) => {
      const marked = await markSending(...args);
      clock.advance(ms);
      return marked;
    };
  }

  it("an answer whose recording runs past the window's end isn't sent, and the last answer sent is kept", async () => {
    const { clock, answers, channel, deps } = setup("2026-10-30T07:50:00+08:00");
    deps.store = make().store;
    const w = await linkedWatcher(deps.store);
    answers.push("go");
    await runTick(deps);
    clock.set("2026-10-30T07:59:59.900+08:00");
    slowMark(deps.store, clock, 200);
    answers.push("wait");
    expect(await runTick(deps)).toMatchObject({ checked: 1, sent: 0 });
    expect(channel.sent).toHaveLength(1);
    expect(await deps.store.get(w.id)).toMatchObject({ sending: null, lastKind: "go", lastDay: "2026-10-30" });
  });

  it("a message tells the time it was sent, after the answer was recorded", async () => {
    const { clock, answers, channel, deps } = setup("2026-10-30T06:04:59.900+08:00");
    deps.store = make().store;
    await linkedWatcher(deps.store);
    slowMark(deps.store, clock, 200);
    answers.push("go");
    await runTick(deps);
    expect(channel.sent.map((m) => m.text.split("\n")[1])).toEqual(["At 06:05 PHT: Go"]);
  });

  it("an answer recorded for one PHT day is never sent on another", async () => {
    const { clock, answers, channel, deps } = setup("2026-10-30T06:00:00+08:00");
    deps.store = make().store;
    const w = await linkedWatcher(deps.store);
    slowMark(deps.store, clock, 24 * 60 * 60_000);
    answers.push("go");
    expect(await runTick(deps)).toMatchObject({ sent: 0 });
    expect(channel.sent).toEqual([]);
    expect(await deps.store.get(w.id)).toMatchObject({ sending: null, lastKind: null });
  });
});

describe("the tick keeps each checked trip's route line for alert delivery (S4P-6)", () => {
  it("stores the plain route's line, at most 200 points with both ends, and not for a watcher switched off meanwhile", async () => {
    const { store, deps } = setup("2026-10-30T06:00:00+08:00");
    const w = await linkedWatcher(store);
    const line = Array.from({ length: 1_000 }, (_, i) => ({ lat: BANILAD.lat + ((IT_PARK.lat - BANILAD.lat) * i) / 999, lon: BANILAD.lon + (i === 500 ? 0.03 : 0) }));
    deps.check = async () => ({ ok: true, kind: "go", line });
    await runTick(deps);
    const [kept] = await store.routes([w.id]);
    expect(kept!.length).toBeLessThanOrEqual(200);
    expect(kept![0]).toEqual(line[0]);
    expect(kept!.at(-1)).toEqual(line.at(-1));
    expect(kept).toContainEqual(line[500]);

    const other = await linkedWatcher(store, { id: "b".repeat(64) }, "5151");
    deps.check = async () => {
      await store.remove(other.id);
      return { ok: true, kind: "go", line };
    };
    await runTick({ ...deps, now: () => new Date("2026-10-30T06:10:00+08:00") });
    expect(await store.routes([other.id])).toEqual([null]);
  });
});
