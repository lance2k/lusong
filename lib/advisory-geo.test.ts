import { describe, expect, it } from "vitest";
import { allProvinces, boundOfGeocode, boundOfName, inPhilippines, judgeArea, NEAR_PROVINCE_M, provinceOf, provincesAlong, type CapArea } from "./advisory-geo";

const CEBU_CITY = { lat: 10.2935, lon: 123.902 };
const IT_PARK = { lat: 10.3304, lon: 123.9058 };
const MANILA_CITY_HALL = { lat: 14.5895, lon: 120.9816 };
const BACOLOD = { lat: 10.6765, lon: 122.9509 };
const NABUNTURAN = { lat: 7.6078, lon: 125.9664 };
const DAVAO_CITY = { lat: 7.0731, lon: 125.6128 };

describe("province polygons", () => {
  it("holds 82 provinces, 4 NCR districts and the 2 other units faeldon lists, each with a 10-digit code", () => {
    const all = allProvinces();
    expect(all).toHaveLength(88);
    expect(all.every((p) => /^\d{10}$/.test(p.code) && /^\d{2}00000000$/.test(p.region))).toBe(true);
    expect(all.filter((p) => p.region === "1300000000").map((p) => p.code).sort()).toEqual(["1303900000", "1307400000", "1307500000", "1307600000"]);
  });

  it("Manila, Cebu City and Bacolod points are in the Philippines", () => {
    expect(inPhilippines(MANILA_CITY_HALL)).toBe(true);
    expect(inPhilippines(CEBU_CITY)).toBe(true);
    expect(inPhilippines(BACOLOD)).toBe(true);
    expect(provinceOf(CEBU_CITY)).toEqual({ code: "0702200000", name: "Cebu" });
    expect(provinceOf(BACOLOD)).toEqual({ code: "1804500000", name: "Negros Occidental" });
    expect(provinceOf(MANILA_CITY_HALL)?.code).toBe("1303900000");
  });

  it("Sabah points inside the trip box (Kota Kinabalu, Sandakan) are not", () => {
    expect(inPhilippines({ lat: 5.98, lon: 116.07 })).toBe(false);
    expect(inPhilippines({ lat: 5.84, lon: 118.11 })).toBe(false);
    expect(provinceOf({ lat: 5.84, lon: 118.11 })).toBeNull();
  });

  it("a Cebu coastal point 0.7 km off the low-resolution edge is in Cebu; 5 km out at sea is in no province", () => {
    // Off Talisay, measured 702 m from the nearest Cebu edge and inside no polygon.
    const offshore = { lat: 10.2407, lon: 123.857 };
    expect(inPhilippines(offshore)).toBe(true);
    expect(provinceOf(offshore)?.name).toBe("Cebu");
    expect(NEAR_PROVINCE_M).toBe(2_000);
    // In the Bohol Strait, between Cebu and Bohol.
    expect(inPhilippines({ lat: 10.05, lon: 123.9 })).toBe(false);
  });

  it("provincesAlong names each province once, in the order the line reaches it", () => {
    expect(provincesAlong([CEBU_CITY, IT_PARK])).toEqual([{ code: "0702200000", name: "Cebu" }]);
    const davao = provincesAlong([DAVAO_CITY, NABUNTURAN]);
    expect(davao[0].name).toBe("Davao del Sur");
    expect(davao[davao.length - 1].name).toBe("Davao de Oro");
    expect(provincesAlong([])).toEqual([]);
  });
});

describe("PAGASA's SAME geocodes and area names", () => {
  it("a province code maps by inserting a 0 after the region: Cebu, Bohol, Davao de Oro", () => {
    expect(boundOfGeocode("072200000")).toEqual({ kind: "provinces", codes: ["0702200000"] });
    expect(boundOfGeocode("071200000")).toEqual({ kind: "provinces", codes: ["0701200000"] });
    expect(boundOfGeocode("118200000")).toEqual({ kind: "provinces", codes: ["1108200000"] });
  });

  it("legacy codes for provinces that moved: Negros (06/07 → 18), ARMM (15 → 19), Sulu (→ 9), Maguindanao (split)", () => {
    expect(boundOfGeocode("064500000")).toEqual({ kind: "provinces", codes: ["1804500000"] });
    expect(boundOfGeocode("074600000")).toEqual({ kind: "provinces", codes: ["1804600000"] });
    expect(boundOfGeocode("076100000")).toEqual({ kind: "provinces", codes: ["1806100000"] });
    expect(boundOfGeocode("153600000")).toEqual({ kind: "provinces", codes: ["1903600000"] });
    expect(boundOfGeocode("153800000")).toEqual({ kind: "provinces", codes: ["1908700000", "1908800000"] });
    expect(boundOfGeocode("156600000")).toEqual({ kind: "provinces", codes: ["0906600000"] });
  });

  it("a city code is bounded by its province (Bacolod by Negros Occidental), NCR codes by their district", () => {
    expect(boundOfGeocode("064501000")).toEqual({ kind: "provinces", codes: ["1804500000"] });
    expect(boundOfGeocode("072217000")).toEqual({ kind: "provinces", codes: ["0702200000"] });
    expect(boundOfGeocode("137404000")).toEqual({ kind: "provinces", codes: ["1307400000"] });
  });

  it("a region code is bounded by all its provinces, the legacy region 07 including Negros Oriental and Siquijor", () => {
    expect(boundOfGeocode("070000000")).toEqual({ kind: "provinces", codes: ["0701200000", "0702200000", "1804600000", "1806100000"] });
    expect((boundOfGeocode("130000000") as { codes: string[] }).codes).toHaveLength(4);
  });

  it("an unknown province code falls back to its region; an unknown region and a malformed code are unbounded", () => {
    expect((boundOfGeocode("079900000") as { codes: string[] }).codes).toContain("0702200000");
    expect(boundOfGeocode("990000000")).toBeNull();
    expect(boundOfGeocode("0722")).toBeNull();
  });

  it("names fold case and accents; regions by name or number; the country by name or nine zeros", () => {
    expect(boundOfName("Davao De Oro")).toEqual({ kind: "provinces", codes: ["1108200000"] });
    expect(boundOfName("CEBU")).toEqual({ kind: "provinces", codes: ["0702200000"] });
    expect(boundOfName("Compostela Valley")).toEqual({ kind: "provinces", codes: ["1108200000"] });
    expect((boundOfName("Region 7 (Central Visayas)") as { codes: string[] }).codes).toContain("0702200000");
    expect((boundOfName("Metro Manila") as { codes: string[] }).codes).toHaveLength(4);
    expect(boundOfName("Philippines")).toEqual({ kind: "nationwide" });
    expect(boundOfName("Whole Country")).toEqual({ kind: "nationwide" });
    expect(boundOfGeocode("000000000")).toEqual({ kind: "nationwide" });
    expect(boundOfName("Unknown")).toBeNull();
  });
});

describe("judging an area against a route", () => {
  const cebuRoute = [CEBU_CITY, IT_PARK];
  const davaoDeOroRoute = [{ lat: 7.55, lon: 125.95 }, NABUNTURAN];

  it("an area named for Davao de Oro with no polygon doesn't touch a Cebu route and does touch a route in Davao de Oro", () => {
    const area: CapArea = { desc: "Davao De Oro", polygons: [], geocodes: ["118200000"] };
    expect(judgeArea(area, cebuRoute)).toBe("outside");
    expect(judgeArea(area, davaoDeOroRoute)).toBe("covers");
  });

  it("an area nothing can place is unbounded, never covering", () => {
    expect(judgeArea({ desc: "Somewhere", polygons: [], geocodes: [] }, cebuRoute)).toBe("unbounded");
    expect(judgeArea({ desc: "Somewhere", polygons: [], geocodes: ["99"] }, davaoDeOroRoute)).toBe("unbounded");
  });

  it("a readable polygon covers a route through it; with nothing else to place it, one beside it is outside", () => {
    const square = [123.88, 10.28, 123.92, 10.28, 123.92, 10.31, 123.88, 10.31, 123.88, 10.28];
    expect(judgeArea({ desc: "Cebu", polygons: [square], geocodes: ["072200000"] }, cebuRoute)).toBe("covers");
    // Starts and ends outside the square, crossing it: no vertex inside.
    expect(judgeArea({ desc: "x", polygons: [square], geocodes: [] }, [{ lat: 10.295, lon: 123.85 }, { lat: 10.295, lon: 123.95 }])).toBe("covers");
    expect(judgeArea({ desc: "x", polygons: [square], geocodes: [] }, [{ lat: 10.4, lon: 123.85 }, { lat: 10.4, lon: 123.95 }])).toBe("outside");
  });

  it("lean safe: a route outside the polygon but inside the province its geocode names is covered", () => {
    const square = [123.88, 10.28, 123.92, 10.28, 123.92, 10.31, 123.88, 10.31, 123.88, 10.28];
    const north = [{ lat: 10.4, lon: 123.85 }, { lat: 10.4, lon: 123.95 }];
    expect(judgeArea({ desc: "x", polygons: [square], geocodes: ["072200000"] }, north)).toBe("covers");
    expect(judgeArea({ desc: "x", polygons: [square], geocodes: ["071200000"] }, north)).toBe("outside");
  });

  it("a route on a coast the low-resolution polygon cuts off is covered by its province's area, as provinceOf places it (S1G-4)", () => {
    const offshore = { lat: 10.2407, lon: 123.857 };
    const coastal = [offshore, { lat: 10.2412, lon: 123.8575 }];
    expect(provinceOf(offshore)?.name).toBe("Cebu");
    expect(judgeArea({ desc: "Cebu", polygons: [], geocodes: ["072200000"] }, coastal)).toBe("covers");
    expect(judgeArea({ desc: "Bohol", polygons: [], geocodes: ["071200000"] }, coastal)).toBe("outside");
  });

  it("a nationwide area covers a Cebu and a Davao route alike", () => {
    const whole: CapArea = { desc: "Philippines", polygons: [], geocodes: [] };
    expect(judgeArea(whole, cebuRoute)).toBe("covers");
    expect(judgeArea(whole, davaoDeOroRoute)).toBe("covers");
  });
});
