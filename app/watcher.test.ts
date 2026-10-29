import { describe, expect, it } from "vitest";
import type { TripStorage } from "./trip";
import { createWatcherStore, watchOnRequest, watchesTrip, type SavedWatcher } from "./watcher";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };
const MABOLO = { lat: 10.3143, lon: 123.9147 };

function fakeStorage(): TripStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, String(v)), removeItem: (k) => void items.delete(k) };
}

const saved: SavedWatcher = {
  token: "t".repeat(43),
  window: { start: "06:00", end: "08:00" },
  trip: { home: BANILAD, work: IT_PARK },
  link: "https://t.me/lusong_bot?start=abc",
  linkExpiresAt: "2026-10-30T00:15:00.000Z",
};

describe("the watcher on the phone", () => {
  it("switching on sends the saved trip's home and work and the window, nothing else", () => {
    expect(watchOnRequest({ home: BANILAD, work: IT_PARK }, { start: "06:00", end: "08:00" })).toEqual({
      action: "on",
      from: BANILAD,
      to: IT_PARK,
      window: { start: "06:00", end: "08:00" },
    });
  });

  it("keeps the token across a reload and forgets it on switch-off", () => {
    const phone = fakeStorage();
    expect(createWatcherStore(phone, null).get()).toBeNull();
    expect(createWatcherStore(phone, null).save(saved)).toBe(true);
    const reloaded = createWatcherStore(phone, null);
    expect(reloaded.get()).toEqual(saved);
    reloaded.clear();
    expect(reloaded.get()).toBeNull();
    expect(phone.items.size).toBe(0);
  });

  it("reads anything malformed as no watcher", () => {
    const phone = fakeStorage();
    for (const raw of ["{", "null", JSON.stringify({ ...saved, token: 5 }), JSON.stringify({ ...saved, window: null })]) {
      phone.items.set("lusong.watcher", raw);
      expect(createWatcherStore(phone, null).get()).toBeNull();
    }
  });

  it("holds the watcher while the page is open when the phone won't store it", () => {
    const blocked: TripStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    const store = createWatcherStore(blocked, null);
    expect(store.save(saved)).toBe(false);
    expect(store.get()).toEqual(saved);
  });

  it("tells whether it is watching the trip now saved", () => {
    expect(watchesTrip(saved, { home: BANILAD, work: IT_PARK })).toBe(true);
    expect(watchesTrip(saved, { home: MABOLO, work: IT_PARK })).toBe(false);
    expect(watchesTrip(saved, null)).toBe(false);
  });
});
