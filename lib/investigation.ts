import type { AdvisoryReading } from "./advisory";
import { decideAnswer, type Answer, type AnswerKind, type Point, type Report, type RouteCandidate } from "./answer";
import { ATTEMPTS_PER_CALL, MUSE_INPUT_MICROS_PER_TOKEN, MUSE_OUTPUT_MICROS_PER_TOKEN } from "./budget";
import { detourAvoids } from "./detour";
import type { Meter } from "./meta";
import { respond, type FunctionCall, type FunctionTool, type SparkReply } from "./spark-responses";
import { inMetroCebu, SEARCH_RESERVE_MICROS, type WebEvidence, type WebFinding, type WebPlan } from "./web-search";

export type { WebEvidence, WebFinding } from "./web-search";

/**
 * Muse Spark's investigation of one commute check (lance2k/lusong#7, plan review 🔴P5/P6/P8).
 *
 * The check's evidence is gathered here deterministically, whatever the model does: the reports along every route that
 * is judged, through `sources`, and the advisory the caller read. The model's tool calls only add to it: a way around
 * spots it names, judged by the same rules on deterministically gathered reports. The answer rules pick the answer; the
 * model picks the evidence that explains it, which Lusong describes in its own words below the rules' reason.
 */

export type ReportsResult = { ok: true; reports: Report[] } | { ok: false };
export type AroundResult = { ok: true; line: Point[] } | { ok: false; reason: "no_route" | "failed" };

export interface InvestigationSources {
  /** Every report along a route line. A store that can't be read is `{ ok: false }`, never an empty list. */
  reportsAlong(line: readonly Point[]): Promise<ReportsResult>;
  /** The trip routed around a box at each spot, joined to the trip's ends; a route that misses them is no_route. */
  routeAround(spots: readonly Point[]): Promise<AroundResult>;
}

/**
 * The evidence Muse Spark picked to explain the rules' answer, most important first: ids only. Lusong writes every
 * sentence shown from that evidence's own fields (lib/evidence-words.ts), so no word the model writes reaches the page.
 * `unavailable` is true when the model failed or ran out of time, so the page says so; a pick that fails its checks is
 * just not shown.
 */
export type EvidencePick = { shown: true; evidence: string[] } | { shown: false; why: string; unavailable: boolean };

export const PICK_UNAVAILABLE = "Muse Spark couldn't pick the evidence for this check.";
export const EVIDENCE_MAX_PICKS = 4;

const ANSWER_KINDS: AnswerKind[] = ["go", "go_another_way", "wait", "no_one_knows"];

/**
 * The ids aren't an enum in the schema: they grow as tools run, and an enum would make the prompt's size, and so the
 * reservation, depend on the evidence. vetPick checks them against what was gathered instead.
 */
const PICK_FORMAT = {
  type: "json_schema" as const,
  name: "lusong_evidence_pick",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "evidence"],
    properties: {
      answer: { type: "string", enum: ANSWER_KINDS },
      evidence: { type: "array", maxItems: EVIDENCE_MAX_PICKS, items: { type: "string" } },
    },
  },
};

function parsePick(text: string): { answer: unknown; evidence: unknown[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.evidence)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The model's pick, kept only when its answer field is the rules' answer and every id is gathered evidence. */
export function vetPick(text: string, answer: AnswerKind, gathered: ReadonlySet<string>): EvidencePick {
  const hidden = (why: string): EvidencePick => ({ shown: false, why, unavailable: false });
  const parsed = parsePick(text);
  if (!parsed) return hidden("unreadable");
  if (parsed.answer !== answer) return hidden("another answer");
  if (parsed.evidence.some((id) => typeof id !== "string" || !gathered.has(id))) return hidden("picks evidence Lusong didn't gather");
  const evidence = [...new Set(parsed.evidence as string[])];
  if (evidence.length === 0) return hidden("picks no evidence");
  if (evidence.length > EVIDENCE_MAX_PICKS) return hidden("picks too much");
  return { shown: true, evidence };
}

/**
 * The reports Muse Spark may pick, and so the ones a check must be able to show: those the rules count within the
 * corridor of any judged route, the plain one or any way around, whether or not that way is the one shown.
 */
export function pickableReportIds(answer: Answer): Set<string> {
  return new Set(answer.routes.flatMap((r) => r.reportIds));
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
      /** Every report the rules were given: web findings only when located and dated today. */
      reports: Report[];
      detours: Detour[];
      web: WebEvidence;
      pick: EvidencePick;
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
  /** Why no model is asked at all (e.g. no API key): the rules answer alone and the pick is unavailable. */
  modelOff?: string;
}

/** Model calls in one investigation, the first included. */
export const LOOP_TURN_CAP = 3;
/** The probe's 3,000 was enough for a tool call and for a one-sentence answer (2 draws). */
export const LOOP_MAX_OUTPUT_TOKENS = 3_000;
/** A call gets at most this long, and never past the deadline. The probe's slowest function turn took 9.8 s (1 draw). */
export const LOOP_ATTEMPT_MS = 15_000;

/** A reply calling more tools than this, or an investigation past the total, ends without a pick. */
export const TOOL_CALLS_PER_TURN = 3;
export const TOOL_CALLS_TOTAL = 5;
/** Each tool's output, as sent back, in UTF-8 bytes; lists are cut from the end to fit. */
export const TOOL_RESULT_MAX_BYTES = 2_000;
/** The check's summary in the first turn, in UTF-8 bytes. */
export const CONTEXT_MAX_BYTES = 3_000;
/** The instructions, tool definitions and pick schema together, in UTF-8 bytes; a test holds them to it. */
export const PROMPT_MAX_BYTES = 4_000;
/**
 * Input the API adds to every call beyond what Lusong sends: the probe's 90-character prompt with one small tool read
 * 560 input tokens (1 draw), about 480 of them framing.
 */
export const FRAMING_TOKENS_PER_CALL = 1_000;
/** Each function_call_output's framing beyond its text. Not measured; the probe's one output added about 10 tokens. */
export const ITEM_FRAMING_TOKENS = 50;
const LAST_TURN_NOTE = "No more tool calls: pick the evidence now.";

/** A way around is asked for only with this much time left: a cached Valhalla slot and one attempt, with room to explain. */
export const ROUTE_AROUND_MIN_MS = 12_000;

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
  "Then answer with JSON: answer is the answer_id you were given, and evidence lists the one to four ids that best explain",
  "it to the rider, most important first (report and web finding ids, advisory, rain_tap, route ids).",
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

  get rainingHere(): boolean {
    return this.input.rainingHere;
  }

  lineOf(routeId: string): Point[] | null {
    if (routeId === "plain") return this.input.plainLine;
    return this.detours.find((d) => d.id === routeId)?.line ?? null;
  }
}

function phtDay(t: Date): string {
  return new Date(t.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 🔴P8: a web finding enters the rules only when it is located and dated today in PHT. Any other finding is shown and
 * never counted, not even as neutral, so it can't turn a Go into No one knows.
 */
export function webFindingCounts(f: WebFinding, now: Date): f is WebFinding & { at: Point } {
  return f.at !== null && f.sourceDate === phtDay(now);
}

function webReportsOf(web: WebEvidence, now: Date): Report[] {
  if (web.searchedAt === null) return [];
  const receivedAt = new Date(web.searchedAt);
  return web.findings
    .filter((f): f is WebFinding & { at: Point } => webFindingCounts(f, now))
    .map((f) => ({ id: f.id, at: f.at, wayId: null, receivedAt, place: f.place, reading: { source: "web", says: "closed", sourceDate: f.sourceDate } }));
}

export async function investigate(input: InvestigationInput): Promise<InvestigationResult> {
  const evidence = new Evidence(input, webReportsOf(input.web, input.now));
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
        return { id: "advisory", ...advisoryView(input.advisory) };
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
              id: r.id,
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
  // A report off every judged route played no part, and a real one's spot is someone else's: it can't be picked.
  const gathered = new Set([
    ...pickableReportIds(answer),
    ...input.web.findings.map((f) => f.id),
    "advisory",
    // The rider always answers the rain tap, so "not tapped" is evidence too.
    "rain_tap",
    ...answer.routes.map((r) => r.routeId),
  ]);
  const pick: EvidencePick =
    "text" in written ? vetPick(written.text, answer.answer, gathered) : { shown: false, why: written.unavailable, unavailable: true };
  return {
    ok: true,
    answer,
    reports: [...evidence.reports.values()],
    detours: evidence.detours,
    web: input.web,
    pick,
    toolCalls,
  };
}

/**
 * The most one investigation can cost with every attempt retried, in µ$. Token counts are bounded by bytes, since a
 * token covers at least one byte of UTF-8 (true of byte-level BPE; Muse Spark's tokenizer is not documented).
 * Turn k reads the first turn's input plus every earlier turn's output and tool results: P + (k − 1) × G.
 */
export function investigationReserveMicros(plan: { kind: WebPlan["kind"] }): number {
  const firstTurn = FRAMING_TOKENS_PER_CALL + PROMPT_MAX_BYTES + CONTEXT_MAX_BYTES;
  const growth = LOOP_MAX_OUTPUT_TOKENS + TOOL_CALLS_PER_TURN * (TOOL_RESULT_MAX_BYTES + ITEM_FRAMING_TOKENS);
  const turns = LOOP_TURN_CAP;
  const loopInput = turns * firstTurn + (growth * turns * (turns - 1)) / 2;
  const loopOutput = turns * LOOP_MAX_OUTPUT_TOKENS;
  const loop = ATTEMPTS_PER_CALL * (loopInput * MUSE_INPUT_MICROS_PER_TOKEN + loopOutput * MUSE_OUTPUT_MICROS_PER_TOKEN);
  return Math.ceil(loop) + (plan.kind === "search" ? SEARCH_RESERVE_MICROS : 0);
}

function contextOf(evidence: Evidence, web: WebEvidence) {
  const answer = evidence.answer();
  return {
    answer: ANSWER_WORDS[answer.answer],
    answer_id: answer.answer,
    reason: answer.reason,
    rain_tap: evidence.rainingHere,
    routes: answer.routes.map((r) => ({ id: r.routeId, state: r.state })),
    web: {
      state: web.state,
      closures: web.findings.map((f) => ({ id: f.id, place: f.place, source_date: f.sourceDate, placed_on_map: f.at !== null })),
    },
  };
}

type Written = { text: string } | { unavailable: string };

/** The model's final text, or why there is none. */
async function explain(input: InvestigationInput, evidence: Evidence, runTool: (call: FunctionCall) => Promise<Record<string, unknown>>): Promise<Written> {
  if (input.modelOff) return { unavailable: input.modelOff };
  let turnInput: Parameters<typeof respond>[0]["input"] = `${INSTRUCTIONS}${CONTEXT_LEAD}${cappedJson(contextOf(evidence, input.web), CONTEXT_MAX_BYTES)}`;
  let previousResponseId: string | undefined;
  let callsSoFar = 0;
  for (let turn = 1; ; turn++) {
    let reply: SparkReply;
    try {
      reply = await respond({
        input: turnInput,
        previousResponseId,
        tools: TOOLS,
        textFormat: PICK_FORMAT,
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
}
