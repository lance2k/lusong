import { describe, expect, it } from "vitest";
import { watchStores } from "../test/watch-stores";
import { WATCH_TTL_MS, type NewWatcher } from "./watch-store";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };

function watcher(overrides: Partial<NewWatcher> = {}): NewWatcher {
  return { id: "a".repeat(64), gen: "g1", trip: { from: BANILAD, to: IT_PARK }, window: { startMin: 360, endMin: 480 }, ...overrides };
}

const T = Date.parse("2026-10-29T22:00:00Z");

describe.each(watchStores)("the watch %s", (_name, make) => {
  it("keeps a new watcher unlinked until its one-time code is redeemed, once", async () => {
    const { store } = make();
    expect(await store.create(watcher(), "code1")).toBe("created");
    expect(await store.get("a".repeat(64))).toMatchObject({ chatId: null, lastKind: null, lastDay: null, checkedAt: 0, gen: "g1" });
    const linked = await store.redeem("code1", "4242");
    expect(linked).toMatchObject({ id: "a".repeat(64), chatId: "4242", window: { startMin: 360, endMin: 480 }, trip: { from: BANILAD, to: IT_PARK } });
    expect(await store.redeem("code1", "9999")).toBeNull();
    expect((await store.get("a".repeat(64)))?.chatId).toBe("4242");
  });

  it("lets a one-time code expire", async () => {
    const { store, wait } = make({ codeTtlMs: 300 });
    await store.create(watcher(), "code1");
    await wait(600);
    expect(await store.redeem("code1", "4242")).toBeNull();
    expect((await store.get("a".repeat(64)))?.chatId).toBeNull();
  });

  it("a new code replaces the outstanding one", async () => {
    const { store } = make();
    await store.create(watcher(), "code1");
    expect(await store.newCode("a".repeat(64), "code2")).toBe(true);
    expect(await store.redeem("code1", "4242")).toBeNull();
    expect((await store.redeem("code2", "4242"))?.chatId).toBe("4242");
    expect(await store.newCode("b".repeat(64), "code3")).toBe(false);
  });

  it("gives every key a time to live, the watcher's 30 days and the code's 15 minutes", async () => {
    const { store, held } = make();
    await store.create(watcher(), "code1");
    const ttls = await held();
    expect(Object.keys(ttls).sort()).toEqual(["lusong:watch-code:code1", "lusong:watch:index", `lusong:watch:w:${"a".repeat(64)}`]);
    expect(ttls[`lusong:watch:w:${"a".repeat(64)}`]).toBeGreaterThan(WATCH_TTL_MS - 60_000);
    expect(ttls[`lusong:watch:w:${"a".repeat(64)}`]).toBeLessThanOrEqual(WATCH_TTL_MS);
    expect(ttls["lusong:watch:index"]).toBeGreaterThan(WATCH_TTL_MS - 60_000);
    expect(ttls["lusong:watch-code:code1"]).toBeGreaterThan(14 * 60_000);
    expect(ttls["lusong:watch-code:code1"]).toBeLessThanOrEqual(15 * 60_000);
    await store.redeem("code1", "4242");
    await store.claimRun("a".repeat(64), "g1", T, 9 * 60_000);
    await store.commit("a".repeat(64), "g1", { kind: "go", day: "2026-10-30" });
    for (const ttl of Object.values(await held())) expect(ttl).toBeGreaterThan(0);
  });

  it("removing a watcher deletes its trip, chat, history and code", async () => {
    const { store, held } = make();
    await store.create(watcher(), "code1");
    await store.create(watcher({ id: "b".repeat(64) }), "code2");
    await store.redeem("code2", "4242");
    await store.commit("b".repeat(64), "g1", { kind: "wait", day: "2026-10-30" });
    await store.remove("a".repeat(64));
    await store.remove("b".repeat(64));
    expect(await held()).toEqual({});
    expect(await store.get("b".repeat(64))).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("lists live watchers and drops expired ones from the index", async () => {
    const { store, wait } = make({ ttlMs: 400 });
    await store.create(watcher(), "code1");
    expect((await store.list()).map((w) => w.id)).toEqual(["a".repeat(64)]);
    await wait(800);
    expect(await store.list()).toEqual([]);
  });

  it("refreshing a watcher restarts its time to live", async () => {
    const { store, wait } = make({ ttlMs: 600 });
    await store.create(watcher(), "code1");
    await wait(400);
    expect(await store.refresh("a".repeat(64))).toBe(true);
    await wait(400);
    expect(await store.get("a".repeat(64))).not.toBeNull();
    expect(await store.refresh("b".repeat(64))).toBe(false);
  });

  it("refuses a watcher past the cap on live watchers", async () => {
    const { store } = make({ maxWatchers: 2 });
    expect(await store.create(watcher({ id: "a".repeat(64) }), "c1")).toBe("created");
    expect(await store.create(watcher({ id: "b".repeat(64) }), "c2")).toBe("created");
    expect(await store.create(watcher({ id: "c".repeat(64) }), "c3")).toBe("full");
    await store.remove("a".repeat(64));
    expect(await store.create(watcher({ id: "c".repeat(64) }), "c3")).toBe("created");
  });

  it("claims a run once per gap, and only for the current generation", async () => {
    const { store } = make();
    await store.create(watcher(), "code1");
    expect(await store.claimRun("a".repeat(64), "other", T, 9 * 60_000)).toBe(false);
    expect(await store.claimRun("a".repeat(64), "g1", T, 9 * 60_000)).toBe(true);
    expect(await store.claimRun("a".repeat(64), "g1", T + 8 * 60_000, 9 * 60_000)).toBe(false);
    expect(await store.claimRun("a".repeat(64), "g1", T + 9 * 60_000, 9 * 60_000)).toBe(true);
    expect((await store.get("a".repeat(64)))?.checkedAt).toBe(T + 9 * 60_000);
    expect(await store.claimRun("b".repeat(64), "g1", T, 9 * 60_000)).toBe(false);
  });

  it("marks the answer being sent, for the current generation only; reading the watcher shows it until a commit or a drop", async () => {
    const { store } = make();
    const id = "a".repeat(64);
    await store.create(watcher(), "code1");
    expect(await store.markSending(id, "g2", { kind: "go", day: "2026-10-30" })).toBe(false);
    expect((await store.get(id))?.sending).toBeNull();
    expect(await store.markSending(id, "g1", { kind: "go", day: "2026-10-30" })).toBe(true);
    expect((await store.list())[0]).toMatchObject({ sending: { kind: "go", day: "2026-10-30" }, lastKind: null });
    expect(await store.commit(id, "g1", { kind: "go", day: "2026-10-30" })).toBe(true);
    expect(await store.get(id)).toMatchObject({ sending: null, lastKind: "go", lastDay: "2026-10-30" });
    expect(await store.markSending(id, "g1", { kind: "wait", day: "2026-10-30" })).toBe(true);
    await store.dropSending(id, "g1");
    expect(await store.get(id)).toMatchObject({ sending: null, lastKind: "go" });
    await store.remove(id);
    expect(await store.markSending(id, "g1", { kind: "go", day: "2026-10-30" })).toBe(false);
    expect(await store.get(id)).toBeNull();
  });

  it("an answer still marked as sending counts as the last sent once a newer one is marked: dropping the newer one keeps it", async () => {
    const { store } = make();
    const id = "a".repeat(64);
    await store.create(watcher(), "code1");
    await store.commit(id, "g1", { kind: "go", day: "2026-10-30" });
    // Wait was handed to Telegram and never recorded as sent: its delivery is uncertain.
    await store.markSending(id, "g1", { kind: "wait", day: "2026-10-30" });
    expect(await store.markSending(id, "g1", { kind: "go", day: "2026-10-30" })).toBe(true);
    expect(await store.get(id)).toMatchObject({ sending: { kind: "go", day: "2026-10-30" }, lastKind: "wait", lastDay: "2026-10-30" });
    await store.dropSending(id, "g1");
    expect(await store.get(id)).toMatchObject({ sending: null, lastKind: "wait", lastDay: "2026-10-30" });
  });

  it("lends a watcher's send lease to one holder at a time, frees it only for that holder's token, and lets it expire", async () => {
    const { store, held, wait } = make();
    const id = "a".repeat(64);
    await store.create(watcher(), "code1");
    const first = await store.takeSendLease(id, 400);
    expect(first).toEqual(expect.any(String));
    expect(await store.takeSendLease(id, 400)).toBeNull();
    const ttl = (await held())[`lusong:watch:lease:${id}`];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    await store.releaseSendLease(id, "someone-else");
    expect(await store.takeSendLease(id, 400)).toBeNull();
    await store.releaseSendLease(id, first!);
    const second = await store.takeSendLease(id, 400);
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await wait(800);
    expect(await store.takeSendLease(id, 400)).toEqual(expect.any(String));
    await store.remove(id);
    expect(await held()).toEqual({});
  });

  it("commits the last answer only for the current generation", async () => {
    const { store } = make();
    await store.create(watcher(), "code1");
    expect(await store.isCurrent("a".repeat(64), "g1")).toBe(true);
    expect(await store.isCurrent("a".repeat(64), "g2")).toBe(false);
    expect(await store.commit("a".repeat(64), "g2", { kind: "go", day: "2026-10-30" })).toBe(false);
    expect(await store.commit("a".repeat(64), "g1", { kind: "go_another_way", day: "2026-10-30" })).toBe(true);
    expect(await store.get("a".repeat(64))).toMatchObject({ lastKind: "go_another_way", lastDay: "2026-10-30" });
    await store.remove("a".repeat(64));
    expect(await store.commit("a".repeat(64), "g1", { kind: "go", day: "2026-10-30" })).toBe(false);
    expect(await store.isCurrent("a".repeat(64), "g1")).toBe(false);
  });
});
