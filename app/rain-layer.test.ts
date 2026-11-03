import { describe, expect, it } from "vitest";
import { RAIN_CREDIT, type RainReply } from "../lib/rain";
import { RAIN_BANDS, buildRainLayer, rainBand } from "./rain-layer";

const okReply = (mms: number[], modelTime: string | null = "2026-11-03T15:00:00.000Z"): RainReply => ({
  status: "ok",
  points: mms.map((mm, i) => ({ lat: 14.5 + Math.floor(i / 3) * 0.1, lon: 120.9 + (i % 3) * 0.1, mm })),
  modelTime,
  credit: RAIN_CREDIT,
});

describe("rain bands", () => {
  it("cuts at 0, 2.5 and 7.6 mm", () => {
    expect(rainBand(0)).toBe("none");
    expect(rainBand(0.01)).toBe("light");
    expect(rainBand(2.49)).toBe("light");
    expect(rainBand(2.5)).toBe("moderate");
    expect(rainBand(7.5)).toBe("moderate");
    expect(rainBand(7.59)).toBe("moderate");
    expect(rainBand(7.6)).toBe("heavy");
    expect(rainBand(40)).toBe("heavy");
  });

  it("gives every band a word label and its own style", () => {
    for (const b of Object.values(RAIN_BANDS)) expect(b.label).toMatch(/[a-z]/i);
    const fills = ["light", "moderate", "heavy"].map((k) => RAIN_BANDS[k as "light"].fill);
    expect(new Set(fills).size).toBe(3);
  });
});

describe("the layer builder", () => {
  it("draws a circle for each wet point and none for a dry one", () => {
    const layer = buildRainLayer(okReply([0, 0.4, 3, 8, 0, 0, 0, 0, 12.34]));
    expect(layer.dryPoints).toBe(5);
    expect(layer.circles.map((c) => c.band)).toEqual(["light", "moderate", "heavy", "heavy"]);
    expect(layer.circles.map((c) => c.label)).toEqual([
      "Light rain, 0.4 mm",
      "Moderate rain, 3.0 mm",
      "Heavy rain, 8.0 mm",
      "Heavy rain, 12.3 mm",
    ]);
    expect(layer.circles[0]).toMatchObject({ lat: 14.5, lon: 121, mm: 0.4 });
  });

  it("sizes circles from the grid spacing: 0.1 degrees is about 5.6 km, a thinned 0.75 about 42 km", () => {
    const fine = buildRainLayer(okReply([1, 1, 1, 1]));
    expect(fine.circles[0].radiusM).toBe(5566);
    const wide: RainReply = {
      ...okReply([]),
      points: [
        { lat: 12, lon: 120, mm: 1 },
        { lat: 12.75, lon: 120, mm: 1 },
        { lat: 12, lon: 120.75, mm: 1 },
      ],
    };
    expect(buildRainLayer(wide).circles[0].radiusM).toBe(Math.round(0.375 * 111_320));
  });

  it("writes the legend row with the model time in PHT", () => {
    const layer = buildRainLayer(okReply([1]));
    expect(layer.legend.text).toBe("Rain now: model estimate, 3 Nov, 11:00 p.m. PHT. Open-Meteo (CC BY 4.0)");
    expect(layer.legend.notice).toBeNull();
    expect(layer.legend.bands.map((b) => `${b.label} (${b.range})`)).toEqual([
      "Light rain (under 2.5 mm)",
      "Moderate rain (2.5 to 7.5 mm)",
      "Heavy rain (7.6 mm or more)",
    ]);
  });

  it("leaves the time out when the reply has none", () => {
    expect(buildRainLayer(okReply([0], null)).legend.text).toBe("Rain now: model estimate. Open-Meteo (CC BY 4.0)");
  });

  it("draws nothing and says why when the layer is paused, refused or down", () => {
    const base: Omit<RainReply, "status"> = { points: [], modelTime: null, credit: RAIN_CREDIT };
    expect(buildRainLayer({ ...base, status: "paused" })).toMatchObject({ circles: [], legend: { notice: "Rain layer paused" } });
    expect(buildRainLayer({ ...base, status: "refused" }).legend.notice).toBe("Zoom in on the Philippines to see rain");
    expect(buildRainLayer({ ...base, status: "down" }).legend.notice).toBe("Rain layer unavailable");
  });
});
