import { describe, expect, it } from "vitest";
import { clearTrip, createTripStore, loadTrip, saveTrip, startTrip, tapTrip, type TripStorage } from "./trip";

const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };

/** The page's localStorage, faked: one per "phone", surviving a reload. */
function fakeStorage(): TripStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
  };
}

describe("tapping your trip", () => {
  it("tapping home, then work, sets the trip", () => {
    const afterHome = tapTrip(startTrip(null), BANILAD);
    expect(afterHome).toEqual({ draft: { step: "work", home: BANILAD }, outside: false });
    const afterWork = tapTrip(afterHome.draft, IT_PARK);
    expect(afterWork).toEqual({ draft: { step: "set", trip: { home: BANILAD, work: IT_PARK } }, outside: false });
  });

  it("a tap outside Metro Cebu changes nothing and says so", () => {
    const manila = { lat: 14.5547, lon: 121.0244 };
    const draft = startTrip(null);
    expect(tapTrip(draft, manila)).toEqual({ draft, outside: true });
    const half = tapTrip(draft, BANILAD).draft;
    expect(tapTrip(half, manila)).toEqual({ draft: half, outside: true });
  });

  it("tapping again once the trip is set starts a new trip at a new home", () => {
    const set = startTrip({ home: BANILAD, work: IT_PARK });
    expect(set).toEqual({ step: "set", trip: { home: BANILAD, work: IT_PARK } });
    const mabolo = { lat: 10.3143, lon: 123.9147 };
    expect(tapTrip(set, mabolo).draft).toEqual({ step: "work", home: mabolo });
  });
});

describe("the trip on the phone", () => {
  it("a saved trip is there after a reload; clearing it removes it", () => {
    const phone = fakeStorage();
    expect(loadTrip(phone)).toBeNull();
    expect(saveTrip(phone, { home: BANILAD, work: IT_PARK })).toBe(true);
    expect(loadTrip(phone)).toEqual({ home: BANILAD, work: IT_PARK });
    clearTrip(phone);
    expect(loadTrip(phone)).toBeNull();
    expect(phone.items.size).toBe(0);
  });

  it("with no storage, or storage that throws, the page carries on without a saved trip", () => {
    const blocked: TripStorage = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    for (const storage of [null, blocked]) {
      expect(loadTrip(storage)).toBeNull();
      expect(saveTrip(storage, { home: BANILAD, work: IT_PARK })).toBe(false);
      expect(clearTrip(storage)).toBe(true);
    }
  });

  it.each([
    ["not JSON", "{"],
    ["a trip missing its work point", JSON.stringify({ home: BANILAD })],
    ["coordinates that aren't numbers", JSON.stringify({ home: { lat: "10.3", lon: 123.9 }, work: IT_PARK })],
    ["a home outside Metro Cebu", JSON.stringify({ home: { lat: 14.676, lon: 121.0437 }, work: IT_PARK })],
  ])("a stored value that is %s is no trip", (_why, raw) => {
    const phone = fakeStorage();
    phone.setItem("lusong.trip", raw);
    expect(loadTrip(phone)).toBeNull();
  });
});

/** A phone whose storage reads and writes but refuses to remove anything. */
function stuckStorage() {
  const phone = fakeStorage();
  phone.removeItem = () => {
    throw new DOMException("denied", "SecurityError");
  };
  return phone;
}

describe("clearing a trip the phone won't let go of", () => {
  it("clearing reports that it failed, and the trip is still there", () => {
    const phone = stuckStorage();
    saveTrip(phone, { home: BANILAD, work: IT_PARK });
    expect(clearTrip(phone)).toBe(false);
    expect(loadTrip(phone)).toEqual({ home: BANILAD, work: IT_PARK });
  });

  it("the page's trip store keeps showing the trip when it can't be removed", () => {
    const phone = stuckStorage();
    const store = createTripStore(phone, null);
    store.save({ home: BANILAD, work: IT_PARK });
    expect(store.clear()).toBe(false);
    expect(store.get()).toEqual({ home: BANILAD, work: IT_PARK });
  });
});

describe("the same trip open in two tabs", () => {
  /** Another tab's change reaches this one only as a storage event, never through this tab's own store. */
  function otherTab(events: EventTarget, change: () => void) {
    change();
    events.dispatchEvent(Object.assign(new Event("storage"), { key: "lusong.trip" }));
  }

  it("clearing in the other tab clears it here, and tells the page so a shown answer goes", () => {
    const phone = fakeStorage();
    const events = new EventTarget();
    saveTrip(phone, { home: BANILAD, work: IT_PARK });
    const store = createTripStore(phone, events);
    let told = 0;
    store.subscribe(() => told++);
    expect(store.get()).toEqual({ home: BANILAD, work: IT_PARK });
    otherTab(events, () => phone.removeItem("lusong.trip"));
    expect(store.get()).toBeNull();
    expect(told).toBe(1);
  });

  it("a new trip tapped in the other tab replaces this one; other keys don't disturb it", () => {
    const phone = fakeStorage();
    const events = new EventTarget();
    const store = createTripStore(phone, events);
    let told = 0;
    store.subscribe(() => told++);
    expect(store.get()).toBeNull();
    events.dispatchEvent(Object.assign(new Event("storage"), { key: "something-else" }));
    expect(told).toBe(0);
    otherTab(events, () => saveTrip(phone, { home: IT_PARK, work: BANILAD }));
    expect(store.get()).toEqual({ home: IT_PARK, work: BANILAD });
    expect(told).toBe(1);
  });
});
