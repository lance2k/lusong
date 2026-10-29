import { describe, expect, it } from "vitest";
import { FakeChannel } from "../test/fake-channel";
import type { AnswerKind } from "./answer";
import type { ScheduledCheck } from "./commute-handler";
import { MemoryWatchStore, type NewWatcher, type WatchStore } from "./watch-store";
import { runTick, type TickDeps } from "./watch-tick";

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
    channel.next = [{ ok: false, permanent: false }];
    answers.push("go");
    expect(await tick()).toMatchObject({ sent: 0, failed: 1 });
    clock.set("2026-10-30T06:10:00+08:00");
    answers.push("go");
    expect(await tick()).toMatchObject({ sent: 1 });
    expect(channel.sent[0].text).toContain("At 06:10 PHT: Go");
  });

  it("a chat that has blocked the bot switches its watcher off", async () => {
    const { store, channel, answers, tick } = setup("2026-10-30T06:00:00+08:00");
    const w = await linkedWatcher(store);
    channel.next = [{ ok: false, permanent: true }];
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

  it("gives each check the tick's deadline", async () => {
    const { store, deps } = setup("2026-10-30T06:00:00+08:00");
    await linkedWatcher(store);
    const deadlines: number[] = [];
    const before = Date.now();
    deps.limits = { budgetMs: 45_000 };
    deps.check = async (_trip, opts) => {
      deadlines.push(opts.deadline);
      return { ok: true, kind: "go" };
    };
    await runTick(deps);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 45_000);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 45_000);
  });
});
