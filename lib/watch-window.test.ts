import { describe, expect, it } from "vitest";
import { clockLine, inWindow, parseWindow, phtDay } from "./watch-window";

const SIX_TO_EIGHT = { startMin: 360, endMin: 480 };

describe("a watcher's time window, in PHT", () => {
  it.each([
    ["05:59 PHT", "2026-10-30T05:59:00+08:00", false],
    ["06:00 PHT", "2026-10-30T06:00:00+08:00", true],
    ["07:59 PHT", "2026-10-30T07:59:00+08:00", true],
    ["08:00 PHT", "2026-10-30T08:00:00+08:00", false],
    ["06:30 UTC, 14:30 PHT", "2026-10-30T06:30:00Z", false],
    ["22:30 UTC the day before, 06:30 PHT", "2026-10-29T22:30:00Z", true],
  ])("at %s is %s", (_label, iso, inside) => {
    expect(inWindow(SIX_TO_EIGHT, new Date(iso))).toBe(inside);
  });

  it("names the PHT day, which starts at 16:00 UTC", () => {
    expect(phtDay(new Date("2026-10-29T15:59:00Z"))).toBe("2026-10-29");
    expect(phtDay(new Date("2026-10-29T16:00:00Z"))).toBe("2026-10-30");
  });

  it("writes a time as PHT", () => {
    expect(clockLine(new Date("2026-10-29T22:40:00Z"))).toBe("06:40 PHT");
  });

  it.each([
    [{ start: "06:00", end: "08:00" }, SIX_TO_EIGHT],
    [{ start: "00:00", end: "04:00" }, { startMin: 0, endMin: 240 }],
    [{ start: "20:00", end: "24:00" }, null],
    [{ start: "08:00", end: "06:00" }, null],
    [{ start: "06:00", end: "06:00" }, null],
    [{ start: "05:00", end: "09:10" }, null],
    [{ start: "6:00", end: "08:00" }, null],
    [{ start: "06:00", end: "25:00" }, null],
    [{ start: "06:60", end: "08:00" }, null],
    ["06:00-08:00", null],
    [null, null],
  ])("reads %j as %j", (input, expected) => {
    expect(parseWindow(input)).toEqual(expected);
  });
});
