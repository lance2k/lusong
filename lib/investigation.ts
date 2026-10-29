import type { AdvisoryReading } from "./advisory";
import { decideAnswer, type Answer, type AnswerKind, type Point, type Report, type RouteCandidate } from "./answer";
import { detourAvoids } from "./detour";
import type { Meter } from "./meta";
import { respond, type FunctionCall, type FunctionTool, type SparkReply } from "./spark-responses";

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

export interface WebFinding {
  id: string;
  place: string;
  /** Null when the model gave no location, or one outside Metro Cebu: shown, never placed on a route. */
  at: Point | null;
  url: string;
  /** YYYY-MM-DD as the source dates it, or null when undated. */
  sourceDate: string | null;
  summary: string;
}

export type WebEvidence =
  | { state: "searched"; searchedAt: string; findings: WebFinding[] }
  | { state: "failed" | "not_run"; why: string; searchedAt: string | null; findings: WebFinding[] };

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
];

const INSTRUCTIONS = [
  "You help Lusong explain a commute check to a motorbike rider in Metro Cebu.",
  "Lusong's rules have already picked the answer and you cannot change it.",
  "Call read_advisory and reports_near_route to see the evidence Lusong gathered.",
  "Then write the explanation: two to four plain English sentences saying why the answer is what it is.",
  "Do not call any way safe or clear, do not suggest a different answer, and write no markdown or links.",
].join(" ");

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
  const runTool = async (call: FunctionCall): Promise<object> => {
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
      default:
        toolCalls.push({ name: call.name, outcome: "unknown tool" });
        return { error: `no tool "${call.name}"` };
    }
  };

  const written = await explain(input, evidence, runTool);
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

function contextOf(evidence: Evidence) {
  const answer = evidence.answer();
  return {
    answer: ANSWER_WORDS[answer.answer],
    reason: answer.reason,
    routes: answer.routes.map((r) => ({ id: r.routeId, state: r.state })),
  };
}

type Written = { text: string } | { unavailable: string };

/** The model's final text, or why there is none. */
async function explain(input: InvestigationInput, evidence: Evidence, runTool: (call: FunctionCall) => Promise<object>): Promise<Written> {
  let turnInput: Parameters<typeof respond>[0]["input"] = `${INSTRUCTIONS}\n\nThis check: ${JSON.stringify(contextOf(evidence))}`;
  let previousResponseId: string | undefined;
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
    if (reply.id === null) return { unavailable: "reply cut off" };
    const outputs = [];
    for (const call of reply.functionCalls) {
      outputs.push({ type: "function_call_output" as const, call_id: call.callId, output: JSON.stringify(await runTool(call)) });
    }
    turnInput = outputs;
    previousResponseId = reply.id;
  }
  return { unavailable: "no explanation" };
}
