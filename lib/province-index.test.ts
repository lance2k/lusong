import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { provinceIndex, inServerTripBound } from "./province-index";
import { decodePolyline6 } from "./router";
import { DEMO_TRIPS } from "./samples";
import { TRIP_AREA_NAME, inTripBound } from "./trip-bound";

function savedLine(fixture: string) {
  const reply = JSON.parse(readFileSync(`test/fixtures/valhalla/${fixture}.json`, "utf8"));
  return reply.trip.legs.flatMap((leg: { shape: string }) => decodePolyline6(leg.shape));
}

describe("the province index every server check reads: faeldon's polygons", () => {
  it("the Metro Manila demo route (Cubao → Makati City Hall) is one search area, though it crosses two NCR districts", () => {
    expect(provinceIndex().provincesAlong(savedLine("cubao-makati-plain"))).toEqual([{ code: "1300000000", name: "Metro Manila" }]);
    expect(provinceIndex().provinceOf(DEMO_TRIPS["cubao-makati"].to)).toEqual({ code: "1300000000", name: "Metro Manila" });
  });

  it("a Cebu City route is in Cebu, by its 10-digit PSGC code", () => {
    expect(provinceIndex().provincesAlong(savedLine("banilad-itpark-plain"))).toEqual([{ code: "0702200000", name: "Cebu" }]);
  });

  it("Isabela City carries its everyday name, not the polygons' \"(Not a Province)\"", () => {
    expect(provinceIndex().provinceOf({ lat: 6.7, lon: 121.97 })).toEqual({ code: "0990100000", name: "Isabela City" });
  });

  it("the trip box takes in Sabah, but the server refuses a trip end there", () => {
    const sabah = { lat: 5.98, lon: 117.07 };
    expect(inTripBound(sabah)).toBe(true);
    expect(inServerTripBound(sabah)).toBe(false);
    expect(inServerTripBound({ lat: 7.07, lon: 125.61 })).toBe(true);
  });

  it("the trip bound is nationwide", () => {
    expect(TRIP_AREA_NAME).toBe("the Philippines");
    for (const p of [{ lat: 18.2, lon: 120.6 }, { lat: 10.3, lon: 123.9 }, { lat: 6.1, lon: 125.2 }, { lat: 20.45, lon: 121.97 }]) {
      expect(inServerTripBound(p)).toBe(true);
    }
  });
});
