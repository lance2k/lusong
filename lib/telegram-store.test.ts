import { describe, expect, it } from "vitest";
import { telegramStores } from "../test/telegram-stores";
import { chatKey, type Half, type LocationHalf, type MediaHalf } from "./telegram-store";

const CHAT = "4242";
const T = 1_793_000_000;
const photo = (fileId: string, date = T): MediaHalf => ({ side: "media", kind: "photo", fileId, date });
const location = (lat: number, date = T): LocationHalf => ({ side: "location", lat, lon: 123.9, date });

describe.each(telegramStores)("pairing a chat's photo and location on the %s (S6P-1)", (_name, make) => {
  it("two photos racing for one waiting location pair exactly once", async () => {
    const { store } = make();
    expect(await store.pair(CHAT, location(10.3), 1)).toEqual({ paired: false });
    const results = await Promise.all([store.pair(CHAT, photo("a", T + 5), 2), store.pair(CHAT, photo("b", T + 5), 3)]);
    expect(results.filter((r) => r.paired)).toHaveLength(1);
    const [won] = results.filter((r) => r.paired);
    expect(won).toEqual({ paired: true, media: expect.objectContaining({ side: "media" }), location: location(10.3) });
  });

  it("photo, photo, location pairs the second photo", async () => {
    const { store } = make();
    await store.pair(CHAT, photo("first"), 4);
    await store.pair(CHAT, photo("second", T + 1), 5);
    expect(await store.pair(CHAT, location(10.3, T + 2), 6)).toEqual({ paired: true, media: photo("second", T + 1), location: location(10.3, T + 2) });
    expect(await store.pair(CHAT, location(10.4, T + 3), 7)).toEqual({ paired: false });
  });

  it("location, location, photo pairs the second location", async () => {
    const { store } = make();
    await store.pair(CHAT, location(10.3), 8);
    await store.pair(CHAT, location(10.4, T + 1), 9);
    expect(await store.pair(CHAT, photo("p", T + 2), 10)).toEqual({ paired: true, media: photo("p", T + 2), location: location(10.4, T + 1) });
  });

  it("halves dated 120 s apart pair; 121 s apart they don't, and the later one waits instead", async () => {
    const { store } = make();
    await store.pair(CHAT, photo("p"), 11);
    expect((await store.pair(CHAT, location(10.3, T + 120), 12)).paired).toBe(true);
    await store.pair(CHAT, photo("q"), 13);
    expect(await store.pair(CHAT, location(10.3, T + 121), 14)).toEqual({ paired: false });
    expect(await store.pair(CHAT, photo("r", T + 121), 15)).toEqual({ paired: true, media: photo("r", T + 121), location: location(10.3, T + 121) });
  });

  it("an expired waiting half doesn't pair", async () => {
    const { store, wait } = make({ pendingTtlMs: 300 });
    await store.pair(CHAT, photo("p"), 16);
    await wait(400);
    expect(await store.pair(CHAT, location(10.3, T + 1), 17)).toEqual({ paired: false });
  });

  it("another chat's half never pairs", async () => {
    const { store } = make();
    await store.pair("777", photo("p"), 18);
    expect(await store.pair(CHAT, location(10.3), 19)).toEqual({ paired: false });
  });

  it("keeps the waiting half under the chat's hash with a 2-minute expiry, and only Telegram's file id", async () => {
    const { store, held } = make();
    const half: Half = { side: "media", kind: "voice", fileId: "voice-file", date: T, durationS: 4, fileSize: 9000, language: "tl" };
    await store.pair(CHAT, half, 99);
    const kept = await held();
    expect(Object.keys(kept).sort()).toEqual([`lusong:tg:pending:${chatKey(CHAT)}`, "lusong:tg:update:99"]);
    expect(JSON.stringify(kept)).not.toContain(CHAT);
  });
});

describe.each(telegramStores)("update ids and language choices on the %s", (_name, make) => {
  it("an update is taken once; a finished one stays taken, a released one can be taken again", async () => {
    const { store } = make();
    expect(await store.claimUpdate(1)).toBe(true);
    expect(await store.claimUpdate(1)).toBe(false);
    await store.releaseUpdate(1);
    expect(await store.claimUpdate(1)).toBe(true);
    await store.finishUpdate(1);
    await store.releaseUpdate(1);
    expect(await store.claimUpdate(1)).toBe(false);
  });

  it("an update that paired can't be taken again, even after its hold lapses and before it was finished (S6P-2)", async () => {
    const { store, wait } = make({ processingMs: 300 });
    expect(await store.claimUpdate(1)).toBe(true);
    await store.pair(CHAT, location(10.3), 1);
    await store.finishUpdate(1);
    expect(await store.claimUpdate(2)).toBe(true);
    expect((await store.pair(CHAT, photo("p"), 2)).paired).toBe(true);
    await store.releaseUpdate(2);
    await wait(400);
    expect(await store.claimUpdate(2)).toBe(false);
  });

  it("an update whose half waits is finished in the same step, so it can't be taken again (S6D-3)", async () => {
    const { store, wait } = make({ processingMs: 300 });
    expect(await store.claimUpdate(1)).toBe(true);
    await store.pair(CHAT, photo("p"), 1);
    await store.releaseUpdate(1);
    await wait(400);
    expect(await store.claimUpdate(1)).toBe(false);
  });

  it("an update being worked on is taken again once its hold lapses", async () => {
    const { store, wait } = make({ processingMs: 300 });
    expect(await store.claimUpdate(7)).toBe(true);
    await wait(400);
    expect(await store.claimUpdate(7)).toBe(true);
  });

  it("keeps a chat's language under its hash", async () => {
    const { store, held } = make();
    expect(await store.language(CHAT)).toBeNull();
    await store.setLanguage(CHAT, "tl");
    expect(await store.language(CHAT)).toBe("tl");
    expect(await store.language("777")).toBeNull();
    expect(await held()).toEqual({ [`lusong:tg:lang:${chatKey(CHAT)}`]: "tl" });
  });
});
