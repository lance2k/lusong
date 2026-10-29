import { describe, expect, it } from "vitest";
import { clearTrip, loadTrip, saveTrip, startTrip, tapTrip, type TripStorage } from "./trip";

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
      expect(() => clearTrip(storage)).not.toThrow();
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
