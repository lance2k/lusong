import type { AdvisoryReading } from "./advisory";
import { decideAnswer, type Answer, type AnswerKind, type Point, type Report, type RouteCandidate } from "./answer";
import { ATTEMPTS_PER_CALL, MUSE_INPUT_MICROS_PER_TOKEN, MUSE_OUTPUT_MICROS_PER_TOKEN, WEB_SEARCH_QUERY_MICROS } from "./budget";
import { detourAvoids } from "./detour";
import type { Meter } from "./meta";
import { respond, type FunctionCall, type FunctionTool, type SparkReply } from "./spark-responses";
import { inMetroCebu, SEARCH_MAX_OUTPUT_TOKENS, type WebEvidence, type WebFinding, type WebPlan } from "./web-search";

export type { WebEvidence, WebFinding } from "./web-search";

/**
 * Muse Spark's investigation of one commute check (lance2k/lusong#7, plan review 🔴P5/P6/P8).
 *
 * The check's evidence is gathered here deterministically, whatever the model does: the reports along every route that
 * is judged, through `sources`, and the advisory the caller read. The model's tool calls only add to it: a way around
 * spots it names, judged by the same rules on deterministically gathered reports. The answer rules pick the answer; the
 * model writes the explanation, which is replaced by the rules' own reason when it disagrees.
 */

export type ReportsResult = { ok: true; reports: Report[] } | { ok: false };
export type AroundResult = { ok: true; line: Point[] } | { ok: false; reason: "no_route" | "failed" };

export interface InvestigationSources {
  /** Every report along a route line. A store that can't be read is `{ ok: false }`, never an empty list. */
  reportsAlong(line: readonly Point[]): Promise<ReportsResult>;
  /** The trip routed around a box at each spot, joined to the trip's ends; a route that misses them is no_route. */
  routeAround(spots: readonly Point[]): Promise<AroundResult>;
}

export type Explanation =
  | { by: "muse_spark"; text: string }
  | { by: "rules"; text: string; why: string }
  | { by: "unavailable"; text: string; why: string };

export const EXPLANATION_UNAVAILABLE = "Muse Spark's explanation is unavailable.";

/** "A few plain sentences": longer than this is not shown. */
export const EXPLANATION_MAX_CHARS = 600;
export const EXPLANATION_MAX_SENTENCES = 5;

/**
 * Phrases that tell the rider to do what an answer says. Matching is deliberately broad: a false match only swaps the
 * model's words for the rules' own reason.
 */
const NAMES_ANSWER: Record<AnswerKind, RegExp> = {
  go: /\b(you can go|go now|good to go|ok(ay)? to go|fine to go|safe to go|go ahead|leave now|you can leave)\b/i,
  go_another_way: /\b(go another way|(take|use) (the|another|a) ((other|different) )?(way|route|road|detour))\b/i,
  wait: /\b(wait|hold off|don'?t (go|leave|ride)|stay (home|put|inside))\b/i,
  no_one_knows: /\b(no one knows|nobody knows)\b/i,
};
/** Calling a way safe or clear is left to a Go. English, Tagalog ligtas and Cebuano luwas. */
const SAFE_OR_CLEAR = /\b(safe|safely|clear|cleared|ligtas|luwas)\b/i;

/** The model's explanation as shown, or the rules' own reason when it is empty, too long or disagrees with the answer. */
export function vetExplanation(text: string, answer: AnswerKind, rulesReason: string): Explanation {
  const shown = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const rules = (why: string): Explanation => ({ by: "rules", text: rulesReason, why });
  if (shown === "") return rules("empty");
  const sentences = shown.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim() !== "").length;
  if (shown.length > EXPLANATION_MAX_CHARS || sentences > EXPLANATION_MAX_SENTENCES) return rules("too long");
  const others = (Object.keys(NAMES_ANSWER) as AnswerKind[]).filter((kind) => kind !== answer);
  if (others.some((kind) => NAMES_ANSWER[kind].test(shown))) return rules("names another answer");
  if (answer !== "go" && SAFE_OR_CLEAR.test(shown)) return rules("calls the way safe or clear");
  return { by: "muse_spark", text: shown };
}

export interface Detour {
  id: string;
  line: Point[];
  proposedBy: "rules" | "muse_spark";
}

export type InvestigationResult =
  | {
      ok: true;
      answer: Answer;
      /** Every report the rules were given, web findings with a location included. */
      reports: Report[];
      detours: Detour[];
      web: WebEvidence;
      explanation: Explanation;
      toolCalls: { name: string; outcome: string }[];
    }
  | { ok: false; failed: "reports" | "routing" };

export interface InvestigationInput {
  /** The plain route, already joined to the trip's ends. */
  plainLine: Point[];
  advisory: AdvisoryReading;
  rainingHere: boolean;
  now: Date;
  /** Epoch ms by which every model call must have finished. */
  deadline: number;
  meter: Meter;
  web: WebEvidence;
  sources: InvestigationSources;
}

/** Model calls in one investigation, the first included. */
export const LOOP_TURN_CAP = 3;
/** The probe's 3,000 was enough for a tool call and for a one-sentence answer (2 draws). */
export const LOOP_MAX_OUTPUT_TOKENS = 3_000;
/** A call gets at most this long, and never past the deadline. The probe's slowest function turn took 9.8 s (1 draw). */
export const LOOP_ATTEMPT_MS = 15_000;

/** A reply calling more tools than this, or an investigation past the total, ends without an explanation. */
export const TOOL_CALLS_PER_TURN = 3;
export const TOOL_CALLS_TOTAL = 5;
/** Each tool's output, as sent back, in UTF-8 bytes; lists are cut from the end to fit. */
export const TOOL_RESULT_MAX_BYTES = 2_000;
/** The check's summary in the first turn, in UTF-8 bytes. */
export const CONTEXT_MAX_BYTES = 3_000;
/** The instructions and tool definitions together, in UTF-8 bytes; a test holds them to it. */
export const PROMPT_MAX_BYTES = 4_000;
/**
 * Input the API adds to every call beyond what Lusong sends: the probe's 90-character prompt with one small tool read
 * 560 input tokens (1 draw), about 480 of them framing.
 */
export const FRAMING_TOKENS_PER_CALL = 1_000;
/** Each function_call_output's framing beyond its text. Not measured; the probe's one output added about 10 tokens. */
export const ITEM_FRAMING_TOKENS = 50;
/** 2.2 × the probe search's 90,257 input tokens, which ran 11 actions at a 3,000-token output cap (1 draw). */
export const SEARCH_INPUT_TOKEN_BOUND = 200_000;
/**
 * The API showed no max_tool_calls in its reply, so the number of search actions isn't capped: twice the probe's 11 are
 * reserved, every action counted as a query, and any beyond are charged when the reply's usage is settled.
 */
export const SEARCH_QUERIES_RESERVED = 22;

const LAST_TURN_NOTE = "No more tool calls: write the explanation now.";

/**
 * Model calls (the web search included) must finish this long after the check starts. Valhalla requests are bounded
 * on their own: two 10 s attempts and a 4 s slot wait.
 */
export const INVESTIGATION_BUDGET_MS = 45_000;
/** A way around is asked for only with this much time left: a cached Valhalla slot and one attempt, with room to explain. */
export const ROUTE_AROUND_MIN_MS = 12_000;

export function investigationDeadline(checkStartedAt: number): number {
  return checkStartedAt + INVESTIGATION_BUDGET_MS;
}

/** At most this many ways around the model may ask for in one check: each is a request to the shared Valhalla server. */
export const ROUTE_AROUND_CAP = 1;
export const ROUTE_AROUND_MAX_SPOTS = 3;

class SourceFailed extends Error {
  constructor(readonly source: "reports" | "routing") {
    super(`${source} failed`);
  }
}

const ANSWER_WORDS: Record<AnswerKind, string> = {
  go: "Go",
  go_another_way: "Go another way",
  wait: "Wait",
  no_one_knows: "No one knows",
};

const TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "read_advisory",
    description: "PAGASA's General Flood Advisory for Cebu, as Lusong read it for this check.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "reports_near_route",
    description: "The reports Lusong gathered along one route of this check, with what each can do under Lusong's rules.",
    parameters: {
      type: "object",
      properties: { route: { type: "string", description: "plain, or the id of a way around" } },
      required: ["route"],
    },
  },
  {
    type: "function",
    name: "route_around",
    description:
      "Ask Lusong to try one more way around up to three spots in Metro Cebu that you think are flooded or closed. " +
      "Lusong also avoids every spot already blocked, gathers the reports along the new way and judges it by its own rules.",
    parameters: {
      type: "object",
      properties: {
        spots: {
          type: "array",
          items: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
        },
      },
      required: ["spots"],
    },
  },
];

const INSTRUCTIONS = [
  "You help Lusong explain a commute check to a motorbike rider in Metro Cebu.",
  "Lusong's rules have already picked the answer and you cannot change it.",
  "Call read_advisory and reports_near_route to see the evidence Lusong gathered.",
  "If the usual way is blocked and you know of another flooded or closed spot, you may call route_around once.",
  "Then write the explanation: two to four plain English sentences saying why the answer is what it is.",
  "Do not call any way safe or clear, do not suggest a different answer, and write no markdown or links.",
].join(" ");

const CONTEXT_LEAD = "\n\nThis check: ";
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
export const FIRST_TURN_MAX_BYTES = utf8Bytes(INSTRUCTIONS) + utf8Bytes(CONTEXT_LEAD) + CONTEXT_MAX_BYTES;

/**
 * The object as JSON within `maxBytes`: the longest list loses items from its end (counted in `omitted_<key>`), then the
 * longest string is cut. Something that still can't fit is an error, never an over-long result.
 */
function cappedJson(value: Record<string, unknown>, maxBytes: number): string {
  const copy: Record<string, unknown> = { ...value };
  let text = JSON.stringify(copy);
  while (utf8Bytes(text) > maxBytes) {
    const lists = Object.keys(copy).filter((k) => Array.isArray(copy[k]) && (copy[k] as unknown[]).length > 0);
    const strings = Object.keys(copy).filter((k) => typeof copy[k] === "string" && (copy[k] as string).length > 3);
    if (lists.length > 0) {
      const key = lists.reduce((a, b) => ((copy[a] as unknown[]).length >= (copy[b] as unknown[]).length ? a : b));
      copy[key] = (copy[key] as unknown[]).slice(0, -1);
      copy[`omitted_${key}`] = ((copy[`omitted_${key}`] as number | undefined) ?? 0) + 1;
    } else if (strings.length > 0) {
      const key = strings.reduce((a, b) => ((copy[a] as string).length >= (copy[b] as string).length ? a : b));
      const longest = copy[key] as string;
      // Removing n characters removes at least n bytes, so this always shrinks the text below its overflow.
      copy[key] = `${longest.slice(0, Math.max(0, longest.length - (utf8Bytes(text) - maxBytes) - 3))}...`;
    } else {
      return JSON.stringify({ error: "result too large" });
    }
    text = JSON.stringify(copy);
  }
  return text;
}

function phtClock(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") + " PHT";
}

function advisoryView(advisory: AdvisoryReading) {
  switch (advisory.state) {
    case "active": {
      const a = advisory.advisory;
      return {
        state: "active",
        headline: a.event ?? a.headline,
        rain_forecast: a.rainForecast,
        rivers: a.riversForCebu,
        sent: phtClock(a.sent),
        expires: phtClock(a.expires),
      };
    }
    case "none":
      return { state: "none" };
    case "unreadable":
      return { state: "unreadable", rule: "Lusong couldn't read PAGASA's feed, so it counts an advisory as active." };
  }
}

function says(report: Report): string {
  const r = report.reading;
  if (r.source === "photo") return r.verdict.kind === "measured" ? `${r.verdict.kind}: ${r.verdict.passability}` : r.verdict.kind;
  if (r.source === "voice") return r.says;
  return `closed (source date ${r.sourceDate ?? "none"})`;
}

class Evidence {
  readonly reports = new Map<string, Report>();
  readonly detours: Detour[] = [];

  constructor(
    private readonly input: InvestigationInput,
    private readonly webReports: Report[],
  ) {}

  add(reports: readonly Report[]) {
    for (const r of [...reports, ...this.webReports]) if (!this.reports.has(r.id)) this.reports.set(r.id, r);
  }

  answer(): Answer {
    const candidates: RouteCandidate[] = this.detours.map((d) => ({ id: d.id, line: d.line }));
    return decideAnswer({
      plain: { id: "plain", line: this.input.plainLine },
      detours: candidates,
      reports: [...this.reports.values()],
      advisory: this.input.advisory.state,
      rainingHere: this.input.rainingHere,
      now: this.input.now,
    });
  }

  lineOf(routeId: string): Point[] | null {
    if (routeId === "plain") return this.input.plainLine;
    return this.detours.find((d) => d.id === routeId)?.line ?? null;
  }
}

function webReportsOf(web: WebEvidence): Report[] {
  if (web.searchedAt === null) return [];
  const receivedAt = new Date(web.searchedAt);
  return web.findings
    .filter((f): f is WebFinding & { at: Point } => f.at !== null)
    .map((f) => ({ id: f.id, at: f.at, wayId: null, receivedAt, place: f.place, reading: { source: "web", says: "closed", sourceDate: f.sourceDate } }));
}

export async function investigate(input: InvestigationInput): Promise<InvestigationResult> {
  const evidence = new Evidence(input, webReportsOf(input.web));
  const plainReports = await input.sources.reportsAlong(input.plainLine);
  if (!plainReports.ok) return { ok: false, failed: "reports" };
  evidence.add(plainReports.reports);

  const plainBlockers = () => {
    const plain = evidence.answer().routes[0];
    return plain.blockedBy.map((id) => evidence.reports.get(id)!);
  };
  const blockers = plainBlockers();
  if (blockers.length > 0) {
    const around = await input.sources.routeAround(blockers.map((b) => b.at));
    if (!around.ok && around.reason === "failed") return { ok: false, failed: "routing" };
    // A way that still meets a blocked spot is no way around it, whatever the router meant.
    if (around.ok && detourAvoids(around.line, blockers.map((b) => b.at))) {
      const along = await input.sources.reportsAlong(around.line);
      if (!along.ok) return { ok: false, failed: "reports" };
      evidence.add(along.reports);
      evidence.detours.push({ id: "detour", line: around.line, proposedBy: "rules" });
    }
  }

  const toolCalls: { name: string; outcome: string }[] = [];
  let routeArounds = 0;
  const runTool = async (call: FunctionCall): Promise<Record<string, unknown>> => {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || "{}");
      args = typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      toolCalls.push({ name: call.name, outcome: "unreadable arguments" });
      return { error: "arguments were not JSON" };
    }
    switch (call.name) {
      case "read_advisory":
        toolCalls.push({ name: call.name, outcome: "read" });
        return advisoryView(input.advisory);
      case "reports_near_route": {
        const routeId = typeof args.route === "string" ? args.route : "";
        const answer = evidence.answer();
        const judged = answer.routes.find((r) => r.routeId === routeId);
        if (!judged || !evidence.lineOf(routeId)) {
          toolCalls.push({ name: call.name, outcome: "unknown route" });
          return { error: `no route "${routeId}"; the routes are ${answer.routes.map((r) => r.routeId).join(", ")}` };
        }
        toolCalls.push({ name: call.name, outcome: "read" });
        const roles = new Map(answer.reports.map((r) => [r.id, r]));
        return {
          route: routeId,
          state: judged.state,
          reports: judged.reportIds.map((id) => {
            const r = evidence.reports.get(id)!;
            return {
              place: r.place,
              kind: r.reading.source,
              says: says(r),
              role: roles.get(id)!.role,
              counts: roles.get(id)!.counts,
              minutes_old: Math.round((input.now.getTime() - r.receivedAt.getTime()) / 60_000),
              ...(r.reading.source === "web" ? { url: input.web.findings.find((f) => f.id === r.id)?.url ?? null } : {}),
            };
          }),
        };
      }
      case "route_around": {
        const spots = Array.isArray(args.spots) ? (args.spots as { lat: unknown; lon: unknown }[]) : null;
        const refuse = (outcome: string, error: string) => {
          toolCalls.push({ name: call.name, outcome });
          return { error };
        };
        if (routeArounds >= ROUTE_AROUND_CAP) return refuse("over the cap", "Lusong tries only one way around per check.");
        if (!spots || spots.length === 0 || spots.length > ROUTE_AROUND_MAX_SPOTS) {
          return refuse("unreadable spots", `give one to ${ROUTE_AROUND_MAX_SPOTS} spots as {lat, lon}`);
        }
        if (!spots.every((p) => typeof p === "object" && p !== null && inMetroCebu(p))) {
          return refuse("spot outside Metro Cebu", "every spot must be a {lat, lon} in Metro Cebu");
        }
        if (input.deadline - Date.now() < ROUTE_AROUND_MIN_MS) {
          toolCalls.push({ name: call.name, outcome: "no time left" });
          return { result: "no time left" };
        }
        routeArounds++;
        const blocking = plainBlockers();
        if (blocking.length === 0) {
          toolCalls.push({ name: call.name, outcome: "not needed" });
          return { result: "not needed", why: "your usual way isn't blocked, so the answer doesn't depend on a way around" };
        }
        const avoid = [...(spots as Point[]).map((p) => ({ lat: p.lat, lon: p.lon })), ...blocking.map((b) => b.at)];
        const around = await input.sources.routeAround(avoid);
        if (!around.ok) {
          toolCalls.push({ name: call.name, outcome: around.reason });
          return { result: around.reason === "no_route" ? "no way found" : "the router couldn't be reached" };
        }
        if (!detourAvoids(around.line, blocking.map((b) => b.at))) {
          toolCalls.push({ name: call.name, outcome: "meets a blocked spot" });
          return { result: "meets a blocked spot" };
        }
        const along = await input.sources.reportsAlong(around.line);
        if (!along.ok) throw new SourceFailed("reports");
        evidence.add(along.reports);
        const id = `muse-${routeArounds}`;
        evidence.detours.push({ id, line: around.line, proposedBy: "muse_spark" });
        const answer = evidence.answer();
        const judged = answer.routes.find((r) => r.routeId === id)!;
        toolCalls.push({ name: call.name, outcome: judged.state });
        return { route: id, state: judged.state, answer_now: ANSWER_WORDS[answer.answer], reason: answer.reason };
      }
      default:
        toolCalls.push({ name: call.name, outcome: "unknown tool" });
        return { error: `no tool "${call.name}"` };
    }
  };

  let written: Written;
  try {
    written = await explain(input, evidence, runTool);
  } catch (err) {
    if (err instanceof SourceFailed) return { ok: false, failed: err.source };
    throw err;
  }
  const answer = evidence.answer();
  const explanation: Explanation =
    "text" in written
      ? vetExplanation(written.text, answer.answer, answer.reason)
      : { by: "unavailable", text: EXPLANATION_UNAVAILABLE, why: written.unavailable };
  return {
    ok: true,
    answer,
    reports: [...evidence.reports.values()],
    detours: evidence.detours,
    web: input.web,
    explanation,
    toolCalls,
  };
}

/**
 * The most one investigation can cost with every attempt retried, in µ$. Token counts are bounded by bytes, since a
 * token covers at least one byte of UTF-8 (true of byte-level BPE; Muse Spark's tokenizer is not documented).
 * Turn k reads the first turn's input plus every earlier turn's output and tool results: P + (k − 1) × G.
 */
export function investigationReserveMicros(plan: WebPlan): number {
  const firstTurn = FRAMING_TOKENS_PER_CALL + PROMPT_MAX_BYTES + CONTEXT_MAX_BYTES;
  const growth = LOOP_MAX_OUTPUT_TOKENS + TOOL_CALLS_PER_TURN * (TOOL_RESULT_MAX_BYTES + ITEM_FRAMING_TOKENS);
  const turns = LOOP_TURN_CAP;
  const loopInput = turns * firstTurn + (growth * turns * (turns - 1)) / 2;
  const loopOutput = turns * LOOP_MAX_OUTPUT_TOKENS;
  const loop = ATTEMPTS_PER_CALL * (loopInput * MUSE_INPUT_MICROS_PER_TOKEN + loopOutput * MUSE_OUTPUT_MICROS_PER_TOKEN);
  const search =
    plan.kind === "search"
      ? ATTEMPTS_PER_CALL *
        (SEARCH_INPUT_TOKEN_BOUND * MUSE_INPUT_MICROS_PER_TOKEN +
          SEARCH_MAX_OUTPUT_TOKENS * MUSE_OUTPUT_MICROS_PER_TOKEN +
          SEARCH_QUERIES_RESERVED * WEB_SEARCH_QUERY_MICROS)
      : 0;
  return Math.ceil(loop) + Math.ceil(search);
}

function contextOf(evidence: Evidence, web: WebEvidence) {
  const answer = evidence.answer();
  return {
    answer: ANSWER_WORDS[answer.answer],
    reason: answer.reason,
    routes: answer.routes.map((r) => ({ id: r.routeId, state: r.state })),
    web: {
      state: web.state,
      closures: web.findings.map((f) => ({ place: f.place, source_date: f.sourceDate, placed_on_map: f.at !== null })),
    },
  };
}

type Written = { text: string } | { unavailable: string };

/** The model's final text, or why there is none. */
async function explain(input: InvestigationInput, evidence: Evidence, runTool: (call: FunctionCall) => Promise<Record<string, unknown>>): Promise<Written> {
  let turnInput: Parameters<typeof respond>[0]["input"] = `${INSTRUCTIONS}${CONTEXT_LEAD}${cappedJson(contextOf(evidence, input.web), CONTEXT_MAX_BYTES)}`;
  let previousResponseId: string | undefined;
  let callsSoFar = 0;
  for (let turn = 1; turn <= LOOP_TURN_CAP; turn++) {
    if (Date.now() >= input.deadline) return { unavailable: "timed out" };
    let reply: SparkReply;
    try {
      reply = await respond({
        input: turnInput,
        previousResponseId,
        tools: TOOLS,
        maxOutputTokens: LOOP_MAX_OUTPUT_TOKENS,
        attemptTimeoutMs: LOOP_ATTEMPT_MS,
        deadline: input.deadline,
        meter: input.meter,
      });
    } catch {
      return { unavailable: Date.now() >= input.deadline ? "timed out" : "model failed" };
    }
    if (reply.status !== "completed") return { unavailable: "reply cut off" };
    if (reply.functionCalls.length === 0) return { text: reply.answerText };
    if (turn === LOOP_TURN_CAP) return { unavailable: "still calling tools at the turn cap" };
    callsSoFar += reply.functionCalls.length;
    if (reply.functionCalls.length > TOOL_CALLS_PER_TURN || callsSoFar > TOOL_CALLS_TOTAL) return { unavailable: "too many tool calls" };
    if (reply.id === null) return { unavailable: "reply cut off" };
    const lastTurnNext = turn + 1 === LOOP_TURN_CAP;
    const outputs = [];
    for (const call of reply.functionCalls) {
      const result = { ...(await runTool(call)), ...(lastTurnNext ? { last_turn: LAST_TURN_NOTE } : {}) };
      outputs.push({ type: "function_call_output" as const, call_id: call.callId, output: cappedJson(result, TOOL_RESULT_MAX_BYTES) });
    }
    turnInput = outputs;
    previousResponseId = reply.id;
  }
  return { unavailable: "no explanation" };
}
