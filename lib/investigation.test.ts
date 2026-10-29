import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisoryReading } from "./advisory";
import { placeOnRoute, ROUTE_CORRIDOR_M, type Point, type Report } from "./answer";
import { lineForTrip } from "./detour";
import { investigate, type AroundResult, type InvestigationSources, type WebEvidence } from "./investigation";
import { Meter } from "./meta";
import { decodePolyline6 } from "./router";
import { DEMO_TRIPS } from "./samples";
import { callsReply, fakeMeta, textReply } from "../test/muse-derived";

const read = (path: string) => readFileSync(path, "utf8");
const shape = (name: string) => decodePolyline6(JSON.parse(read(`test/fixtures/valhalla/${name}.json`)).trip.legs[0].shape);
const TRIP = DEMO_TRIPS["banilad-itpark"];
/** The real Banilad → IT Park route, and Valhalla's real way around the box in its saved request (2026-10-30). */
const PLAIN = lineForTrip(shape("banilad-itpark-plain"), TRIP)!;
const DETOUR = lineForTrip(shape("banilad-itpark-excluded"), TRIP)!;
const BOX = JSON.parse(read("test/fixtures/valhalla/banilad-itpark-excluded.request.json")).exclude_polygons[0] as number[][];
/** The centre of that box: the spot the saved detour avoids. */
const BLOCKED_SPOT: Point = { lat: (BOX[0][1] + BOX[2][1]) / 2, lon: (BOX[0][0] + BOX[2][0]) / 2 };

const NOW = new Date("2026-10-30T02:00:00Z"); // 10:00 PHT
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function voice(id: string, at: Point, says: "passable" | "knee_deep_or_deeper" | "not_passable", place = "Banilad"): Report {
  return { id, at, wayId: null, receivedAt: minutesAgo(10), place, reading: { source: "voice", says } };
}

const NO_ADVISORY: AdvisoryReading = { state: "none" };
const NO_WEB: WebEvidence = { state: "not_run", why: "test", searchedAt: null, findings: [] };

function sourcesOf(options: { reports?: Report[]; around?: (spots: readonly Point[]) => AroundResult; failReports?: boolean } = {}) {
  const asked = { reportsAlong: [] as Point[][], routeAround: [] as Point[][] };
  const sources: InvestigationSources = {
    async reportsAlong(line) {
      asked.reportsAlong.push([...line]);
      return options.failReports ? { ok: false } : { ok: true, reports: options.reports ?? [] };
    },
    async routeAround(spots) {
      asked.routeAround.push([...spots]);
      return options.around ? options.around(spots) : { ok: true, line: DETOUR };
    },
  };
  return { sources, asked };
}

function inputOf(sources: InvestigationSources, overrides: Partial<Parameters<typeof investigate>[0]> = {}) {
  return {
    plainLine: PLAIN,
    advisory: NO_ADVISORY,
    rainingHere: false,
    now: NOW,
    deadline: Date.now() + 40_000,
    meter: new Meter(),
    web: NO_WEB,
    sources,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the real records behind these tests", () => {
  it("the blocked spot lies on the plain route and off the saved detour", () => {
    expect(placeOnRoute(BLOCKED_SPOT, PLAIN).offM).toBeLessThanOrEqual(ROUTE_CORRIDOR_M);
    expect(placeOnRoute(BLOCKED_SPOT, DETOUR).offM).toBeGreaterThan(ROUTE_CORRIDOR_M);
  });
});

describe("Muse Spark's investigation", () => {
  it("runs the model's tool calls, gives it what the check gathered, and shows its explanation under the rules' answer", async () => {
    const blocker = voice("v1", BLOCKED_SPOT, "not_passable");
    const { sources } = sourcesOf({ reports: [blocker] });
    const meta = fakeMeta({
      turns: [
        callsReply("resp_1", [
          { name: "reports_near_route", args: { route: "plain" } },
          { name: "read_advisory", args: {} },
        ]),
        textReply("resp_2", "Someone reported your usual way near Banilad as not passable, so Lusong found a way around it."),
      ],
    });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("go_another_way");
    expect(result.explanation).toEqual({
      by: "muse_spark",
      text: "Someone reported your usual way near Banilad as not passable, so Lusong found a way around it.",
    });
    const second = meta.requests[1];
    expect(second.previous_response_id).toBe("resp_1");
    const outputs = second.input as { type: string; call_id: string; output: string }[];
    expect(outputs.map((o) => [o.type, o.call_id])).toEqual([
      ["function_call_output", "call_resp_1_0"],
      ["function_call_output", "call_resp_1_1"],
    ]);
    const near = JSON.parse(outputs[0].output);
    expect(near.state).toBe("blocked");
    expect(near.reports).toEqual([expect.objectContaining({ place: "Banilad", kind: "voice", role: "block", counts: true })]);
    expect(JSON.parse(outputs[1].output)).toMatchObject({ state: "none" });
    expect(result.toolCalls.map((c) => c.name)).toEqual(["reports_near_route", "read_advisory"]);
  });
});
