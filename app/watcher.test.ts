import { describe, expect, it } from "vitest";
import type { TripStorage } from "./trip";
import { createWatcherStore, switchOnWatcher, watchOnRequest, watchesTrip, type SavedWatcher, type WatchCall } from "./watcher";

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

/** /api/watch answered here: switching on hands back a token and a link; each switch-off answers the next status given. */
function fakeWatchApi(offStatuses: number[]) {
  const bodies: Record<string, unknown>[] = [];
  const call: WatchCall = async (body) => {
    bodies.push(body as Record<string, unknown>);
    if ((body as { action: string }).action === "on") {
      return { status: 200, body: { watcher: saved.token, window: saved.window, link: saved.link, linkExpiresAt: saved.linkExpiresAt } };
    }
    const status = offStatuses.shift() ?? 200;
    return { status, body: status === 200 ? { state: "off" } : { error: "store down" } };
  };
  return { call, bodies };
}

const refusingStorage: TripStorage = {
  getItem: () => null,
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  removeItem: () => {},
};

describe("switching the watcher on from the panel", () => {
  const request = { trip: saved.trip, window: saved.window, retryMs: 0 };

  it("keeps the token and the Telegram link on the phone", async () => {
    const api = fakeWatchApi([]);
    const store = createWatcherStore(fakeStorage(), null);
    expect(await switchOnWatcher({ ...request, call: api.call, store })).toEqual({ ok: true });
    expect(store.get()).toEqual(saved);
    expect(api.bodies.map((b) => b.action)).toEqual(["on"]);
  });

  it("when the phone won't keep the token, switches the watcher off at once, shows no Telegram link and says why", async () => {
    const api = fakeWatchApi([503, 200]);
    const store = createWatcherStore(refusingStorage, null);
    const result = await switchOnWatcher({ ...request, call: api.call, store });
    expect(result).toEqual({
      ok: false,
      message:
        "This browser wouldn't keep the watcher's key, and without it the watcher couldn't be switched off later, so Lusong switched it off again. Allow this site to store data (private browsing blocks it) and try again.",
    });
    // The panel shows the link only for the watcher in this store.
    expect(store.get()).toBeNull();
    expect(api.bodies).toEqual([watchOnRequest(saved.trip, saved.window), { action: "off", watcher: saved.token }, { action: "off", watcher: saved.token }]);
  });

  it("when the server's copy can't be deleted either, tries a few times and says it deletes itself in 30 days", async () => {
    const api = fakeWatchApi([503, 503, 503, 503, 503]);
    const store = createWatcherStore(refusingStorage, null);
    const result = await switchOnWatcher({ ...request, call: api.call, store });
    expect(result).toEqual({
      ok: false,
      message:
        "This browser wouldn't keep the watcher's key, and Lusong couldn't switch the watcher off again. With no Telegram chat linked it sends nothing, and Lusong deletes it in 30 days. Allow this site to store data (private browsing blocks it) and try again.",
    });
    expect(store.get()).toBeNull();
    expect(api.bodies.filter((b) => b.action === "off")).toHaveLength(3);
  });
});
