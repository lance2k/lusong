import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisoryReading } from "./advisory";
import { placeOnRoute, ROUTE_CORRIDOR_M, type Point, type Report } from "./answer";
import { lineForTrip } from "./detour";
import {
  EXPLANATION_MAX_CHARS,
  EXPLANATION_UNAVAILABLE,
  FIRST_TURN_MAX_BYTES,
  investigate,
  LOOP_MAX_OUTPUT_TOKENS,
  LOOP_TURN_CAP,
  TOOL_CALLS_PER_TURN,
  TOOL_CALLS_TOTAL,
  TOOL_RESULT_MAX_BYTES, vetExplanation, type AroundResult, type InvestigationSources, type WebEvidence } from "./investigation";
import { Meter } from "./meta";
import { decodePolyline6 } from "./router";
import { DEMO_TRIPS } from "./samples";
import type { WebFinding } from "./web-search";
import { callsReply, fakeMeta, hangs, textReply } from "../test/muse-derived";

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
const ACTIVE_ADVISORY: AdvisoryReading = {
  state: "active",
  advisory: {
    id: "gfa-test",
    headline: "General Flood Advisory",
    event: "General Flood Advisory for Central Visayas",
    rainForecast: "Light to moderate with at times heavy rains",
    riversForCebu: "Mananga, Butuanon",
    sent: "2026-10-30T01:00:00+08:00",
    expires: "2026-10-30T13:00:00+08:00",
    link: "https://publicalert.pagasa.dost.gov.ph/output/gfa/test.cap",
  },
};
const NO_WEB: WebEvidence = { state: "not_run", why: "test", searchedAt: null, findings: [] };

function sourcesOf(
  options: { reports?: Report[]; around?: (spots: readonly Point[]) => AroundResult; failReports?: boolean; /** The 0-based read from which the store fails. */ failReportsFrom?: number } = {},
) {
  const asked = { reportsAlong: [] as Point[][], routeAround: [] as Point[][] };
  const sources: InvestigationSources = {
    async reportsAlong(line) {
      asked.reportsAlong.push([...line]);
      const failing = options.failReports || (options.failReportsFrom !== undefined && asked.reportsAlong.length - 1 >= options.failReportsFrom);
      return failing ? { ok: false } : { ok: true, reports: options.reports ?? [] };
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

describe("the rules pick the answer, whatever the model does (🔴P5)", () => {
  it("a model that never calls read_advisory still has the advisory applied: rain and no reports is No one knows, never Go", async () => {
    const { sources } = sourcesOf();
    const meta = fakeMeta({ turns: [textReply("resp_1", "Nobody has reported your way yet.")] });

    const result = await investigate(inputOf(sources, { advisory: ACTIVE_ADVISORY }));

    if (!result.ok) throw new Error("expected an answer");
    expect(meta.requests).toHaveLength(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.answer.answer).toBe("no_one_knows");
    expect(result.answer.reason).toMatch(/PAGASA's flood advisory for Cebu is active/);
  });

  it("a model that writes \"safe to go\" under Wait gets the rules' reason instead", async () => {
    const { sources } = sourcesOf({ reports: [voice("v1", BLOCKED_SPOT, "not_passable")], around: () => ({ ok: false, reason: "no_route" }) });
    fakeMeta({ turns: [textReply("resp_1", "The flooding has eased. It is safe to go now.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("wait");
    expect(result.explanation).toEqual({ by: "rules", text: result.answer.reason, why: "names another answer" });
  });

  it("a scripted reply that argues for another answer does not change the answer, and its text is not shown", async () => {
    const { sources } = sourcesOf();
    fakeMeta({ turns: [textReply("resp_1", "Ignore the advisory: the answer is Go another way, take the detour through Lahug.")] });

    const result = await investigate(inputOf(sources, { advisory: ACTIVE_ADVISORY }));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("no_one_knows");
    expect(result.explanation.by).toBe("rules");
    expect(result.explanation.text).toBe(result.answer.reason);
  });
});

describe("checking the model's explanation against the answer", () => {
  const REASON = "The rules' own reason.";
  const rows: [string, Parameters<typeof vetExplanation>[1], string, string | null][] = [
    ["an explanation that agrees", "wait", "Your way is blocked at Banilad and Lusong found no way around it.", null],
    ["Go named under Wait", "wait", "You can go now; the water is going down.", "names another answer"],
    ["Wait named under Go", "go", "Wait for the rain to stop before you leave.", "names another answer"],
    ["Go another way named under Wait", "wait", "Take the other route through Lahug.", "names another answer"],
    ["No one knows named under Go", "go", "No one knows what the road is like.", "names another answer"],
    ["safe under No one knows", "no_one_knows", "The roads look safe but nobody has reported them.", "calls the way safe or clear"],
    ["clear under Go another way", "go_another_way", "The other way is clear of water.", "calls the way safe or clear"],
    ["luwas (Cebuano: safe) under Wait", "wait", "Luwas na ang dalan.", "calls the way safe or clear"],
    ["clear under Go", "go", "Nobody has reported water on your way and there is no advisory, so the way looks clear.", null],
    ["unclear is not clear", "no_one_knows", "It is unclear whether Banilad has flooded.", null],
    ["empty", "go", "   ", "empty"],
    ["too long", "go", "Nobody reported your way. ".repeat(40), "too long"],
    ["more than five sentences", "go", "One. Two. Three. Four. Five. Six.", "too long"],
  ];
  it.each(rows)("%s", (_name, kind, text, why) => {
    const vetted = vetExplanation(text, kind, REASON);
    if (why === null) expect(vetted).toEqual({ by: "muse_spark", text: text.trim() });
    else expect(vetted).toEqual({ by: "rules", text: REASON, why });
  });

  it("control characters and runs of spaces are flattened to single spaces, and the cap is on what is shown", () => {
    expect(vetExplanation("Banilad\u0000 is\n\n  blocked.\u001b[31m", "wait", REASON)).toEqual({ by: "muse_spark", text: "Banilad is blocked. [31m" });
    expect(vetExplanation("a".repeat(EXPLANATION_MAX_CHARS), "go", REASON).by).toBe("muse_spark");
    expect(vetExplanation("a".repeat(EXPLANATION_MAX_CHARS + 1), "go", REASON).by).toBe("rules");
  });
});

describe("when Muse Spark fails, the check still answers by the rules", () => {
  const blocked = () => sourcesOf({ reports: [voice("v1", BLOCKED_SPOT, "not_passable")] });
  const unavailable = (why: string) => ({ by: "unavailable", text: EXPLANATION_UNAVAILABLE, why });

  it("a model that errors twice gives the rules' answer, its evidence, and says the explanation is unavailable", async () => {
    const { sources } = blocked();
    const meta = fakeMeta({ turns: [new Response("{}", { status: 500 }), new Response("{}", { status: 503 })] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(meta.requests).toHaveLength(2);
    expect(result.answer.answer).toBe("go_another_way");
    expect(result.reports.map((r) => r.id)).toEqual(["v1"]);
    expect(result.detours.map((d) => d.id)).toEqual(["detour"]);
    expect(result.explanation).toEqual(unavailable("model failed"));
  });

  it("a model that doesn't answer by the deadline gives the rules' answer and an unavailable explanation", async () => {
    const { sources } = blocked();
    fakeMeta({ turns: [hangs] });

    const started = Date.now();
    const result = await investigate(inputOf(sources, { deadline: started + 300 }));

    expect(Date.now() - started).toBeLessThan(2_000);
    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("go_another_way");
    expect(result.explanation).toEqual(unavailable("timed out"));
  });

  it("a deadline already past makes no model call at all", async () => {
    const { sources } = blocked();
    const meta = fakeMeta({ turns: [] });

    const result = await investigate(inputOf(sources, { deadline: Date.now() - 1 }));

    expect(meta.requests).toHaveLength(0);
    if (!result.ok) throw new Error("expected an answer");
    expect(result.explanation).toEqual(unavailable("timed out"));
  });

  it("a reply cut off at max_output_tokens is no explanation, even with text in it", async () => {
    const { sources } = blocked();
    fakeMeta({ turns: [textReply("resp_1", "Your usual way is", undefined, "incomplete")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.explanation).toEqual(unavailable("reply cut off"));
  });

  it("a malformed reply is no explanation", async () => {
    const { sources } = blocked();
    fakeMeta({ turns: [{ unexpected: true }] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.explanation).toEqual(unavailable("reply cut off"));
  });
});

describe("a source that fails is a failed check, never an empty success (🔴P5)", () => {
  it("a report store that can't be read gives no answer, and Muse Spark is never asked", async () => {
    const { sources } = sourcesOf({ failReports: true });
    const meta = fakeMeta({ turns: [] });

    expect(await investigate(inputOf(sources))).toEqual({ ok: false, failed: "reports" });
    expect(meta.requests).toHaveLength(0);
  });

  it("reports along the way around that can't be read give no answer", async () => {
    const { sources } = sourcesOf({ reports: [voice("v1", BLOCKED_SPOT, "not_passable")], failReportsFrom: 1 });
    fakeMeta({ turns: [] });

    expect(await investigate(inputOf(sources))).toEqual({ ok: false, failed: "reports" });
  });

  it("a router that can't be reached for the way around gives no answer", async () => {
    const { sources } = sourcesOf({ reports: [voice("v1", BLOCKED_SPOT, "not_passable")], around: () => ({ ok: false, reason: "failed" }) });
    fakeMeta({ turns: [] });

    expect(await investigate(inputOf(sources))).toEqual({ ok: false, failed: "routing" });
  });
});

describe("route_around: a way around the model proposes is judged by the same rules", () => {
  /** A spot on the saved detour, far from the plain route. */
  const ON_DETOUR = DETOUR[Math.floor(DETOUR.length / 2)];
  const MODEL_SPOT = { lat: 10.3362, lon: 123.9105 };
  const blocker = voice("v1", BLOCKED_SPOT, "not_passable");
  /** The rules' own way around finds nothing; a request that also avoids the model's spot gets the saved detour. */
  const onlyWithModelSpot = (spots: readonly Point[]): AroundResult => (spots.length === 1 ? { ok: false, reason: "no_route" } : { ok: true, line: DETOUR });
  const proposeAround = (spots: unknown) => callsReply("resp_1", [{ name: "route_around", args: { spots } }]);

  it("judged passable on reports gathered along it, it is the way the answer takes", async () => {
    const { sources, asked } = sourcesOf({ reports: [blocker], around: onlyWithModelSpot });
    const meta = fakeMeta({ turns: [proposeAround([MODEL_SPOT]), textReply("resp_2", "Banilad is reported not passable, so Lusong found a way around it.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(asked.routeAround).toEqual([[BLOCKED_SPOT], [MODEL_SPOT, BLOCKED_SPOT]]);
    expect(asked.reportsAlong).toEqual([PLAIN, DETOUR]);
    expect(result.detours).toEqual([{ id: "muse-1", line: DETOUR, proposedBy: "muse_spark" }]);
    expect(result.answer.answer).toBe("go_another_way");
    expect(result.answer.route).toBe("muse-1");
    const told = JSON.parse((meta.requests[1].input as { output: string }[])[0].output);
    expect(told).toMatchObject({ route: "muse-1", state: "passable", answer_now: "Go another way" });
    expect(result.explanation.by).toBe("muse_spark");
  });

  it("blocked by a report along it, it changes nothing", async () => {
    const { sources } = sourcesOf({ reports: [blocker, voice("v2", ON_DETOUR, "knee_deep_or_deeper", "Lahug")], around: onlyWithModelSpot });
    fakeMeta({ turns: [proposeAround([MODEL_SPOT]), textReply("resp_2", "Both ways are reported flooded.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("wait");
    expect(result.answer.routes.find((r) => r.routeId === "muse-1")?.state).toBe("blocked");
  });

  it("a way that still meets a blocked spot is no way around it", async () => {
    const { sources } = sourcesOf({ reports: [blocker], around: (spots) => (spots.length === 1 ? { ok: false, reason: "no_route" } : { ok: true, line: PLAIN }) });
    const meta = fakeMeta({ turns: [proposeAround([MODEL_SPOT]), textReply("resp_2", "No way around Banilad was found.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.detours).toEqual([]);
    expect(result.answer.answer).toBe("wait");
    expect(JSON.parse((meta.requests[1].input as { output: string }[])[0].output)).toMatchObject({ result: "meets a blocked spot" });
  });

  it("when the usual way isn't blocked, the router is not asked", async () => {
    const { sources, asked } = sourcesOf();
    const meta = fakeMeta({ turns: [proposeAround([MODEL_SPOT]), textReply("resp_2", "Nobody has reported your way.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(asked.routeAround).toEqual([]);
    expect(JSON.parse((meta.requests[1].input as { output: string }[])[0].output)).toMatchObject({ result: "not needed" });
  });

  it.each([
    ["no spots", []],
    ["four spots", [MODEL_SPOT, MODEL_SPOT, MODEL_SPOT, MODEL_SPOT]],
    ["a spot in Manila", [{ lat: 14.5995, lon: 120.9842 }]],
    ["a spot that isn't numbers", [{ lat: "10.33", lon: "123.91" }]],
    ["spots that aren't a list", "Banilad"],
  ])("%s is refused without asking the router", async (_name, spots) => {
    const { sources, asked } = sourcesOf({ reports: [blocker], around: onlyWithModelSpot });
    const meta = fakeMeta({ turns: [proposeAround(spots), textReply("resp_2", "No way around Banilad was found.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(asked.routeAround).toHaveLength(1);
    expect(JSON.parse((meta.requests[1].input as { output: string }[])[0].output)).toHaveProperty("error");
  });

  it("only one way around is tried per check", async () => {
    const { sources, asked } = sourcesOf({ reports: [blocker], around: onlyWithModelSpot });
    const meta = fakeMeta({
      turns: [
        callsReply("resp_1", [
          { name: "route_around", args: { spots: [MODEL_SPOT] } },
          { name: "route_around", args: { spots: [ON_DETOUR] } },
        ]),
        textReply("resp_2", "Banilad is reported not passable, so Lusong found a way around it."),
      ],
    });

    await investigate(inputOf(sources));

    expect(asked.routeAround).toHaveLength(2);
    expect(JSON.parse((meta.requests[1].input as { output: string }[])[1].output)).toHaveProperty("error");
  });

  it("a router failure on the model's way around only drops that way", async () => {
    const { sources } = sourcesOf({ reports: [blocker], around: (spots) => (spots.length === 1 ? { ok: false, reason: "no_route" } : { ok: false, reason: "failed" }) });
    fakeMeta({ turns: [proposeAround([MODEL_SPOT]), textReply("resp_2", "No way around Banilad was found.")] });

    const result = await investigate(inputOf(sources));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("wait");
    expect(result.detours).toEqual([]);
  });

  it("reports along the model's way around that can't be read give no answer", async () => {
    const { sources } = sourcesOf({ reports: [blocker], around: onlyWithModelSpot, failReportsFrom: 1 });
    fakeMeta({ turns: [proposeAround([MODEL_SPOT])] });

    expect(await investigate(inputOf(sources))).toEqual({ ok: false, failed: "reports" });
  });
});

describe("the investigation's cost is bounded", () => {
  const read = { name: "read_advisory", args: {} };
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");

  it("stops at the turn cap when the model keeps calling tools, and tells it on the last turn to write", async () => {
    const { sources } = sourcesOf();
    const turns = Array.from({ length: LOOP_TURN_CAP + 2 }, (_, i) => callsReply(`resp_${i + 1}`, [read]));
    const meta = fakeMeta({ turns });

    const result = await investigate(inputOf(sources));

    expect(meta.requests).toHaveLength(LOOP_TURN_CAP);
    const last = meta.requests[LOOP_TURN_CAP - 1].input as { output: string }[];
    expect(JSON.parse(last[0].output)).toMatchObject({ last_turn: "No more tool calls: write the explanation now." });
    if (!result.ok) throw new Error("expected an answer");
    expect(result.explanation).toMatchObject({ by: "unavailable", why: "still calling tools at the turn cap" });
  });

  it("a reply with more tool calls than a turn allows ends the investigation without running any of them", async () => {
    const { sources } = sourcesOf();
    const meta = fakeMeta({ turns: [callsReply("resp_1", Array.from({ length: TOOL_CALLS_PER_TURN + 1 }, () => read))] });

    const result = await investigate(inputOf(sources));

    expect(meta.requests).toHaveLength(1);
    if (!result.ok) throw new Error("expected an answer");
    expect(result.toolCalls).toEqual([]);
    expect(result.explanation).toMatchObject({ by: "unavailable", why: "too many tool calls" });
  });

  it("tool calls past the investigation's total end it too", async () => {
    const { sources } = sourcesOf();
    const full = Array.from({ length: TOOL_CALLS_PER_TURN }, () => read);
    const meta = fakeMeta({ turns: [callsReply("resp_1", full), callsReply("resp_2", full)] });

    const result = await investigate(inputOf(sources));

    expect(TOOL_CALLS_PER_TURN * 2).toBeGreaterThan(TOOL_CALLS_TOTAL);
    expect(meta.requests).toHaveLength(2);
    if (!result.ok) throw new Error("expected an answer");
    expect(result.toolCalls).toHaveLength(TOOL_CALLS_PER_TURN);
    expect(result.explanation).toMatchObject({ by: "unavailable", why: "too many tool calls" });
  });

  it("every call caps its output tokens, and the first turn's input stays within its byte bound", async () => {
    const { sources } = sourcesOf({ reports: [voice("v1", BLOCKED_SPOT, "not_passable", "Banilad ".repeat(500))] });
    const meta = fakeMeta({ turns: [callsReply("resp_1", [read]), textReply("resp_2", "Banilad is reported not passable.")] });

    await investigate(inputOf(sources));

    expect(meta.requests.map((r) => r.max_output_tokens)).toEqual([LOOP_MAX_OUTPUT_TOKENS, LOOP_MAX_OUTPUT_TOKENS]);
    expect(bytes(meta.requests[0].input as string)).toBeLessThanOrEqual(FIRST_TURN_MAX_BYTES);
  });

  it("a long tool result is cut to its byte cap and says how many reports it left out", async () => {
    const along = Array.from({ length: 300 }, (_, i) => voice(`v${i}`, PLAIN[Math.floor((i * PLAIN.length) / 300)], "passable", `Spot ${i} ñ`));
    const { sources } = sourcesOf({ reports: along });
    const meta = fakeMeta({ turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", "Nobody can tell.")] });

    await investigate(inputOf(sources));

    const output = (meta.requests[1].input as { output: string }[])[0].output;
    expect(bytes(output)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const shown = JSON.parse(output);
    expect(shown.reports.length).toBeGreaterThan(0);
    expect(shown.reports.length + shown.omitted_reports).toBe(300);
  });
});

describe("web findings: they can block a way, never clear one (criterion 3, 🔴P8)", () => {
  const TODAY = "2026-10-30"; // NOW in PHT
  const finding = (overrides: Partial<WebFinding> = {}): WebFinding => ({
    id: "web-0",
    place: "Banilad",
    at: BLOCKED_SPOT,
    url: "https://example.ph/banilad-closed",
    sourceDate: TODAY,
    summary: "Road closed by flooding.",
    ...overrides,
  });
  const searched = (...findings: WebFinding[]) => ({ state: "searched" as const, searchedAt: minutesAgo(5).toISOString(), findings });
  const quiet = () => fakeMeta({ turns: [textReply("resp_1", "Here is what Lusong found.")] });
  const plainState = (result: Awaited<ReturnType<typeof investigate>>) => {
    if (!result.ok) throw new Error("expected an answer");
    return result.answer.routes[0];
  };

  it("a closure on your way dated today blocks it, and shows with its link", async () => {
    const { sources } = sourcesOf();
    const meta = fakeMeta({ turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", "A news page reports Banilad closed today.")] });

    const result = await investigate(inputOf(sources, { web: searched(finding()) }));

    expect(plainState(result)).toMatchObject({ state: "blocked", blockedBy: ["web-0"] });
    if (!result.ok) throw new Error("expected an answer");
    expect(result.answer.answer).toBe("go_another_way");
    const told = JSON.parse((meta.requests[1].input as { output: string }[])[0].output);
    expect(told.reports).toEqual([expect.objectContaining({ kind: "web", role: "block", url: "https://example.ph/banilad-closed" })]);
  });

  it("an undated closure on your way does not block it: it is neutral, so the way is unknown, never Go", async () => {
    const { sources, asked } = sourcesOf();
    quiet();

    const result = await investigate(inputOf(sources, { web: searched(finding({ sourceDate: null })) }));

    expect(plainState(result)).toMatchObject({ state: "unknown", blockedBy: [] });
    expect(asked.routeAround).toEqual([]);
  });

  it("a closure dated yesterday does not block either", async () => {
    const { sources } = sourcesOf();
    quiet();

    const result = await investigate(inputOf(sources, { web: searched(finding({ sourceDate: "2026-10-29" })) }));

    expect(plainState(result)).toMatchObject({ state: "unknown", blockedBy: [] });
  });

  it("a closure with no location is shown and never given to the rules", async () => {
    const { sources } = sourcesOf();
    quiet();

    const result = await investigate(inputOf(sources, { web: searched(finding({ at: null })) }));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.web.findings).toHaveLength(1);
    expect(result.reports).toEqual([]);
    expect(result.answer.answer).toBe("go");
  });

  it("a web finding never makes a way passable, whatever its date or place", async () => {
    const variants = [finding(), finding({ sourceDate: null }), finding({ sourceDate: "2026-10-29" }), finding({ at: null }), finding({ at: DETOUR[5] })];
    const scenarios = [
      { name: "blocked by a voice report", reports: [voice("v1", BLOCKED_SPOT, "not_passable")], advisory: NO_ADVISORY, around: () => ({ ok: false, reason: "no_route" }) as AroundResult },
      { name: "unknown under rain", reports: [], advisory: ACTIVE_ADVISORY },
      { name: "unknown with a neutral report", reports: [voice("v1", BLOCKED_SPOT, "passable")], advisory: NO_ADVISORY },
    ];
    const run = async (scenario: (typeof scenarios)[number], web: WebFinding | null) => {
      const { sources } = sourcesOf({ reports: scenario.reports, around: scenario.around });
      quiet();
      const result = await investigate(inputOf(sources, { advisory: scenario.advisory, web: web ? searched(web) : NO_WEB }));
      if (!result.ok) throw new Error("expected an answer");
      return result.answer;
    };
    let checked = 0;
    for (const scenario of scenarios) {
      const without = await run(scenario, null);
      expect(without.routes[0].state, scenario.name).not.toBe("passable");
      for (const web of variants) {
        const withIt = await run(scenario, web);
        // A route judged both ways is passable with the finding only if it was without it.
        for (const route of withIt.routes) {
          const before = without.routes.find((r) => r.routeId === route.routeId);
          if (before && before.state !== "passable") expect(route.state, `${scenario.name}, ${route.routeId}, ${JSON.stringify(web)}`).not.toBe("passable");
        }
        expect(withIt.answer).not.toBe("go");
        checked++;
      }
    }
    expect(checked).toBe(15);
  });

  it("the model is told what the web search found, places with no location included", async () => {
    const { sources } = sourcesOf();
    const meta = quiet();

    await investigate(inputOf(sources, { web: searched(finding({ at: null, place: "Osmeña Blvd" })) }));

    const summary = JSON.parse((meta.requests[0].input as string).split("This check: ")[1]);
    expect(summary.web).toEqual({ state: "searched", closures: [{ place: "Osmeña Blvd", source_date: TODAY, placed_on_map: false }] });
  });

  it("a failed search is said so in the result and the rules answer from the rest", async () => {
    const { sources } = sourcesOf();
    quiet();

    const result = await investigate(inputOf(sources, { web: { state: "failed", why: "search failed", searchedAt: NOW.toISOString(), findings: [] } }));

    if (!result.ok) throw new Error("expected an answer");
    expect(result.web).toMatchObject({ state: "failed" });
    expect(result.answer.answer).toBe("go");
  });
});
