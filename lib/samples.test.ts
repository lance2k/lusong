import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeOnRoute, ROUTE_CORRIDOR_M, roleOf } from "./answer";
import { decodePolyline6, wayIdFromLocate } from "./router";
import { DEMO_TRIPS, SCENARIOS, sampleReports, SAMPLE_SPECS } from "./samples";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const LABELS = [...json("test/fixtures/depth-set/labels.json"), ...json("test/fixtures/acceptance/labels.json")] as {
  file: string;
  source: string;
  licence: string;
  author: string;
}[];
const LOCATE = json("test/fixtures/valhalla/locate-sample-pins.json") as { input_lat: number; input_lon: number }[];
const ROUTE_LINES = {
  "banilad-itpark": decodePolyline6(json("test/fixtures/valhalla/banilad-itpark-plain.json").trip.legs[0].shape),
  "mabolo-cbp": decodePolyline6(json("test/fixtures/valhalla/mabolo-cbp-plain.json").trip.legs[0].shape),
};
const NOW = new Date("2026-10-30T07:00:00+08:00");

describe("sample reports for the demo", () => {
  it.each(SAMPLE_SPECS.map((s) => [s.id, s] as const))("%s carries a verdict actually recorded for its photo", (_id, spec) => {
    const run = json(`test/${spec.recorded.run}/results.json`) as { records: { file: string; draw: number; result: { verdict: unknown } }[] };
    const record = run.records.find((r) => r.file === spec.recorded.file && r.draw === spec.recorded.draw);
    expect(record, `${spec.recorded.file} draw ${spec.recorded.draw} in ${spec.recorded.run}`).toBeDefined();
    expect(spec.verdict).toEqual(record!.result.verdict);
  });

  it.each(SAMPLE_SPECS.map((s) => [s.id, s] as const))("%s names its photo's real origin and credit from the label", (_id, spec) => {
    const label = LABELS.find((l) => l.file === spec.recorded.file)!;
    expect(spec.sourceUrl).toBe(label.source);
    expect(spec.credit).toContain(label.licence);
    expect(spec.credit).toContain(label.author.split(" (")[0]);
    expect(spec.origin.length).toBeGreaterThan(10);
  });

  it.each(SAMPLE_SPECS.map((s) => [s.id, s] as const))("%s is pinned on its trip's route, with the way id /locate gave", (_id, spec) => {
    expect(placeOnRoute(spec.at, ROUTE_LINES[spec.trip]).offM).toBeLessThanOrEqual(ROUTE_CORRIDOR_M);
    const located = LOCATE.find((l) => l.input_lat === spec.at.lat && l.input_lon === spec.at.lon);
    expect(located, "pin was located").toBeDefined();
    expect(spec.wayId).toBe(wayIdFromLocate(located as Parameters<typeof wayIdFromLocate>[0]));
  });

  it("every sample report is marked as a sample, and its time is set from the clock", () => {
    for (const trip of Object.keys(DEMO_TRIPS) as (keyof typeof DEMO_TRIPS)[]) {
      for (const scenario of SCENARIOS) {
        for (const r of sampleReports(trip, scenario.id, NOW)) {
          const spec = SAMPLE_SPECS.find((s) => s.id === r.id)!;
          expect(r.sample).toBe(true);
          expect(r.origin).toBe(spec.origin);
          expect(NOW.getTime() - r.receivedAt.getTime()).toBe(spec.ageMin * 60_000);
        }
      }
    }
  });

  it("no recorded photo reads no_flood, so no sample can clear a spot", () => {
    expect(SAMPLE_SPECS.every((s) => roleOf({ ...s, receivedAt: NOW, reading: { source: "photo", verdict: s.verdict, capturedAt: NOW } }, NOW) !== "clear")).toBe(
      true,
    );
  });

  it("the 'no reports' scenario has no samples, the others have at least one each", () => {
    for (const trip of Object.keys(DEMO_TRIPS) as (keyof typeof DEMO_TRIPS)[]) {
      expect(sampleReports(trip, "none", NOW)).toEqual([]);
      expect(sampleReports(trip, "flooded", NOW).length).toBeGreaterThan(0);
      expect(sampleReports(trip, "unclear", NOW).length).toBeGreaterThan(0);
    }
  });
});
