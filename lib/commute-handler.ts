import { admit } from "./admission";
import { readAdvisory, type AdvisoryReading } from "./advisory";
import { placeOnRoute, ROUTE_CORRIDOR_M, type AnswerKind, type Point } from "./answer";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { boxAround, lineForTrip } from "./detour";
import { ageWords, depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { evidenceSentences } from "./evidence-words";
import { investigate, investigationReserveMicros, PICK_UNAVAILABLE, webFindingCounts, type InvestigationResult } from "./investigation";
import type { Meter } from "./meta";
import { fetchRoute, ROUTE_WORST_MS, type Route, type RouteResult, type ValhallaGate } from "./router";
import { DEMO_TRIPS, sampleReports, scenariosFor, type DemoTripId, type ScenarioId } from "./samples";
import {
  planWebSearch,
  releaseWebSearch,
  runWebSearch,
  searchBudgetFromEnv,
  searchStoreFromEnv,
  type ClosureKind,
  type KvStore,
  type WebEvidence,
  type WebFinding,
  type WebPlan,
} from "./web-search";

/** PAGASA and Valhalla are free, so without Muse Spark a check reserves 1 µ$: enough to pass the daily admission and its per-address limit. */
export const COMMUTE_RESERVE_MICROS = 1;

/** Every part of a check, model calls included, ends this long after it starts; app/api/commute/route.ts allows 90 s. */
export const COMMUTE_DEADLINE_MS = 80_000;
/** Left after the deadline to settle the budget (Upstash times out at 5 s) and send the answer. */
export const SETTLE_ROOM_MS = 10_000;
/** The web search must end with this much of the deadline left, beyond a way around: for the model's pick. */
export const MODEL_ROOM_MS = 15_000;

export interface MuseDeps {
  /** False runs the rules alone: no web search, no pick, nothing reserved for Muse Spark. */
  enabled: boolean;
  searchStore: () => KvStore | null;
  searchBudget: () => Budget;
}

export const MUSE_OFF: MuseDeps = { enabled: false, searchStore: () => null, searchBudget: () => searchBudgetFromEnv({}) };

function museFromEnv(): MuseDeps {
  return { enabled: Boolean(process.env.MODEL_API_KEY), searchStore: () => searchStoreFromEnv(), searchBudget: () => searchBudgetFromEnv() };
}

/** A demo trip's plain route, or its detour around a set of spots, is reused this long: the roads don't change, and Valhalla is a shared free server. */
export const ROUTE_CACHE_MS = 10 * 60_000;
/** A readable PAGASA reading is reused this long, so a busy demo doesn't fetch the feed on every check. */
export const ADVISORY_CACHE_MS = 5 * 60_000;
/** An unreadable reading is reused this long, so demo clicks while PAGASA is down don't each fetch it again. */
export const UNREADABLE_RETRY_MS = 60_000;

const TITLES: Record<AnswerKind, string> = {
  go: "Go",
  go_another_way: "Go another way",
  wait: "Wait. Check again in 30 minutes.",
  no_one_knows: "No one knows",
};

/** A route that doesn't reach the trip's own ends is never judged: part of a trip can't answer for all of it. */
type PlainResult = RouteResult | { ok: false; reason: "off_trip" | "out_of_time" };

const ROUTE_ERRORS: Record<Exclude<PlainResult, { ok: true }>["reason"], string> = {
  unreachable: "Lusong couldn't reach the routing server, so it can't give an answer. Try again in a minute.",
  busy: "The routing server is busy with other checks, so Lusong can't give an answer. Try again in a few seconds.",
  gate_unavailable: "Lusong can't pace its requests to the routing server right now, so it sent none and can't give an answer.",
  no_route: "The routing server found no motorbike route for this trip, so Lusong can't give an answer.",
  off_trip: "The routing server's route doesn't reach this trip's start and end, so Lusong can't give an answer.",
  out_of_time: "Lusong ran out of time looking for a way around, so it can't give an answer. Try again in a minute.",
};

const WEB_WHY: Record<string, string> = {
  "search failed": "the search failed",
  "search cut off": "the search ran out of room before it answered",
  "unreadable reply": "the search's reply couldn't be read",
  "no shared store": "there is no shared store to keep it in",
  "store unreachable": "the shared store couldn't be reached",
};

const CLOSURE_WORDS: Record<ClosureKind, string> = { closed: "Closed", flooded: "Flooded", not_passable: "Not passable", other_blocking: "Blocked" };

/** A web finding is shown as Lusong's description of its checked fields; the source's own words are never kept. */
function webForPage(web: WebEvidence, now: Date) {
  const line =
    web.state === "searched" ? `Searched the web at ${phtTime(web.searchedAt)}` : `Web search skipped: ${WEB_WHY[web.why] ?? web.why}.`;
  const note = (f: WebFinding) => {
    if (webFindingCounts(f, now)) return "Dated today and placed on the map: it can block a way, never clear one.";
    const missing = [f.sourceDate === null ? "no date" : null, f.at === null ? "no place on the map" : null].filter(Boolean);
    if (missing.length > 0) return `Shown, not counted: it has ${missing.join(" and ")}.`;
    return `Shown, not counted: it is dated ${f.sourceDate}, not today.`;
  };
  return {
    line,
    findings: web.findings.map((f) => {
      const site = new URL(f.url).hostname;
      const page = f.sourceDate ? `a page on ${site} dated ${f.sourceDate}` : `an undated page on ${site}`;
      return { place: f.place, url: f.url, site, sourceDate: f.sourceDate, description: `${CLOSURE_WORDS[f.kind]}, says ${page}.`, counted: webFindingCounts(f, now), note: note(f) };
    }),
  };
}

/** The evidence Muse Spark picked, each piece described in Lusong's words from its own checked fields. */
function pickForPage(result: Extract<InvestigationResult, { ok: true }>, facts: { now: Date; advisory: AdvisoryReading; rainingHere: boolean }) {
  const label = "Muse Spark picked this evidence";
  const hidden = { shown: false, label, sentences: [] as string[], note: !result.pick.shown && result.pick.unavailable ? PICK_UNAVAILABLE : null };
  if (!result.pick.shown) return hidden;
  const sentences = evidenceSentences(result.pick.evidence, { ...facts, reports: result.reports, web: result.web.findings, routes: result.answer.routes });
  return sentences ? { shown: true, label, sentences, note: null } : hidden;
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

interface DemoRequest {
  trip: DemoTripId;
  scenario: ScenarioId;
  rainingHere: boolean;
}

function parseDemo(body: unknown): DemoRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== "demo") return null;
  if (typeof b.trip !== "string" || !Object.hasOwn(DEMO_TRIPS, b.trip)) return null;
  if (!scenariosFor(b.trip as DemoTripId).some((s) => s.id === b.scenario)) return null;
  if (b.rainingHere !== undefined && typeof b.rainingHere !== "boolean") return null;
  return { trip: b.trip as DemoTripId, scenario: b.scenario as ScenarioId, rainingHere: b.rainingHere === true };
}

function advisoryForPage(reading: AdvisoryReading) {
  switch (reading.state) {
    case "active": {
      const a = reading.advisory;
      return {
        state: "active" as const,
        headline: a.event ?? a.headline,
        rainForecast: a.rainForecast,
        rivers: a.riversForCebu,
        sent: phtTime(a.sent),
        expires: phtTime(a.expires),
        link: a.link,
        note: null,
      };
    }
    case "none":
      return { state: "none" as const, note: "No General Flood Advisory for Cebu in PAGASA's feed right now." };
    case "unreadable":
      return {
        state: "unreadable" as const,
        note: "Lusong couldn't read PAGASA's flood advisory feed, so it counts an advisory as active.",
      };
  }
}

function thinNote(kind: AnswerKind, reportCount: number, voiceOnly: boolean): string {
  if (kind === "go" && reportCount === 0) return "Nobody has reported your way. This answer rests on no advisory and no rain tap.";
  if (kind === "go_another_way" && reportCount === 0) {
    return "Nobody has reported the other way. This answer rests on no advisory and no rain tap.";
  }
  if (voiceOnly) return "This answer rests on voice reports only.";
  return "This answer rests on one report.";
}

/**
 * POST /api/commute: the demo commute check. Real trips and real reports arrive in later tickets; until then only
 * demo requests are taken, so sample reports can never reach a real check.
 */
export function makeCommuteHandler(deps: {
  fetch?: typeof fetch;
  now?: () => Date;
  gate: () => ValhallaGate;
  budget?: () => Budget;
  muse?: MuseDeps;
  /** The deadline and the longest a Valhalla request can take, shortened in tests. */
  timing?: { deadlineMs: number; routeWorstMs: number };
}) {
  const budget = deps.budget ?? budgetFromEnv;
  const muse = () => deps.muse ?? museFromEnv();
  const timing = deps.timing ?? { deadlineMs: COMMUTE_DEADLINE_MS, routeWorstMs: ROUTE_WORST_MS };
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());
  const routes = new Map<DemoTripId, { route: Route; at: number }>();
  const detours = new Map<string, { result: RouteResult; at: number }>();
  let advisoryCache: { reading: AdvisoryReading; at: number } | null = null;

  async function routeFor(trip: DemoTripId, t: number): Promise<PlainResult> {
    const cached = routes.get(trip);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return { ok: true, route: cached.route };
    const result = await fetchRoute(DEMO_TRIPS[trip], { fetch: doFetch, gate: deps.gate() });
    if (result.ok && !lineForTrip(result.route.line, DEMO_TRIPS[trip])) return { ok: false, reason: "off_trip" };
    if (result.ok) routes.set(trip, { route: result.route, at: t });
    return result;
  }

  /** One more request, with a box excluded around each spot; "no route" is an answer, so it is kept too. */
  async function detourFor(trip: DemoTripId, spots: readonly Point[], t: number): Promise<RouteResult> {
    const key = `${trip}|${spots.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).sort().join(";")}`;
    const cached = detours.get(key);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return cached.result;
    const result = await fetchRoute(
      { ...DEMO_TRIPS[trip], excludePolygons: spots.map((p) => boxAround(p)) },
      { fetch: doFetch, gate: deps.gate() },
    );
    if (result.ok || result.reason === "no_route") detours.set(key, { result, at: t });
    return result;
  }

  async function advisoryAt(at: Date): Promise<AdvisoryReading> {
    if (advisoryCache) {
      const keep = advisoryCache.reading.state === "unreadable" ? UNREADABLE_RETRY_MS : ADVISORY_CACHE_MS;
      if (at.getTime() - advisoryCache.at < keep) return advisoryCache.reading;
    }
    const reading = await readAdvisory({ fetch: doFetch, now: at });
    advisoryCache = { reading, at: at.getTime() };
    return reading;
  }

  return async function POST(request: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return fail(400, "Send the check as JSON.");
    }
    const demo = parseDemo(parsed);
    if (!demo) return fail(400, "Only the demo trips can be checked so far.");

    const started = Date.now();
    const deadline = started + timing.deadlineMs;
    const at = now();
    const museDeps = muse();
    const plan: WebPlan = museDeps.enabled ? await planWebSearch(museDeps.searchStore(), at, museDeps.searchBudget()) : { kind: "off", why: "Muse Spark is off" };
    const reserveMicros = COMMUTE_RESERVE_MICROS + (museDeps.enabled ? investigationReserveMicros(plan) : 0);
    const admission = await admit(budget(), { clientIp: clientIp(request), reserveMicros, now: at });
    if (!admission.ok) {
      await releaseWebSearch(plan);
      return admission.response();
    }
    let answered = false;
    try {
      const response = await answerDemo(demo, at, { plan, store: museDeps.enabled ? museDeps.searchStore() : null, modelOff: museDeps.enabled ? undefined : "Muse Spark is off", meter: admission.run.meter, deadline });
      answered = response.ok;
      return response;
    } finally {
      await admission.run.settle(answered);
    }
  };

  async function answerDemo(
    demo: DemoRequest,
    at: Date,
    run: { plan: WebPlan; store: KvStore | null; modelOff?: string; meter: Meter; deadline: number },
  ): Promise<Response> {
    const trip = DEMO_TRIPS[demo.trip];
    // The search ends early enough to leave a way around and the model's pick their time.
    const searchDeadline = run.deadline - timing.routeWorstMs - MODEL_ROOM_MS;
    const [advisory, routed, web] = await Promise.all([
      advisoryAt(at),
      routeFor(demo.trip, at.getTime()),
      runWebSearch(run.plan, { store: run.store, now: at, deadline: searchDeadline, meter: run.meter }),
    ]);
    if (!routed.ok) return Response.json({ error: ROUTE_ERRORS[routed.reason], routing: routed.reason }, { status: 503 });

    const route = routed.route;
    const plainLine = lineForTrip(route.line, trip)!;
    const reports = sampleReports(demo.trip, demo.scenario, at);
    const routesByLine = new Map<Point[], Route>();
    let routingFailure: Exclude<PlainResult, { ok: true }>["reason"] | null = null;

    const result = await investigate({
      plainLine,
      advisory,
      rainingHere: demo.rainingHere,
      now: at,
      deadline: run.deadline,
      meter: run.meter,
      web,
      modelOff: run.modelOff,
      sources: {
        // A demo trip's reports are its samples; the rules keep the ones within the corridor of each route.
        reportsAlong: async () => ({ ok: true, reports }),
        async routeAround(spots) {
          if (run.deadline - Date.now() < timing.routeWorstMs) {
            routingFailure = "out_of_time";
            return { ok: false, reason: "failed" };
          }
          const around = await detourFor(demo.trip, spots, at.getTime());
          if (!around.ok) {
            if (around.reason === "no_route") return { ok: false, reason: "no_route" };
            routingFailure = around.reason;
            return { ok: false, reason: "failed" };
          }
          // A reply that misses the trip's ends is no way around it, whatever Valhalla meant.
          const line = lineForTrip(around.route.line, trip);
          if (!line) return { ok: false, reason: "no_route" };
          routesByLine.set(line, around.route);
          return { ok: true, line };
        },
      },
    });
    if (!result.ok) {
      const reason = result.failed === "routing" ? (routingFailure ?? "unreachable") : "unreachable";
      return Response.json({ error: ROUTE_ERRORS[reason], routing: reason }, { status: 503 });
    }

    const answer = result.answer;
    const shown = (answer.answer === "go_another_way" ? result.detours.find((d) => d.id === answer.route) : result.detours[0]) ?? null;
    const detour = shown ? routesByLine.get(shown.line)! : null;
    const detourLine = shown?.line ?? null;
    const judged = new Map(answer.reports.map((r) => [r.id, r]));
    const used = reports.filter((r) => answer.decidedBy.includes(r.id));

    return Response.json({
      demo: true,
      trip: { id: demo.trip, label: trip.label },
      rainingHere: demo.rainingHere,
      answer: {
        kind: answer.answer,
        title: TITLES[answer.answer],
        reason: answer.reason,
        thin: answer.thinEvidence ? thinNote(answer.answer, used.length, used.length > 0 && used.every((r) => r.reading.source === "voice")) : null,
      },
      route: { lengthKm: route.lengthKm, timeMin: Math.round(route.timeMin), streets: route.streets, line: route.line },
      detour: detour && {
        state: answer.routes.find((r) => r.routeId === shown!.id)!.state,
        proposedBy: shown!.proposedBy,
        lengthKm: detour.lengthKm,
        timeMin: Math.round(detour.timeMin),
        // From the shown figures, so the page's numbers add up.
        extraKm: Math.round((detour.lengthKm - route.lengthKm) * 10) / 10,
        extraMin: Math.round(detour.timeMin) - Math.round(route.timeMin),
        streets: detour.streets,
        line: detour.line,
      },
      advisory: advisoryForPage(advisory),
      reports: reports.map((r) => {
        const j = judged.get(r.id)!;
        const verdict = r.reading.source === "photo" ? r.reading.verdict : null;
        return {
          id: r.id,
          sample: r.sample,
          place: r.place,
          age: ageWords(at.getTime() - r.receivedAt.getTime()),
          depth: verdict ? depthWords(verdict) : null,
          passability: verdict ? passabilityLine(verdict) : null,
          origin: r.origin,
          credit: r.credit,
          sourceUrl: r.sourceUrl,
          counts: j.counts,
          onRoute: placeOnRoute(r.at, plainLine).offM <= ROUTE_CORRIDOR_M,
          onDetour: detourLine !== null && placeOnRoute(r.at, detourLine).offM <= ROUTE_CORRIDOR_M,
          role: j.role,
        };
      }),
      muse: { pick: pickForPage(result, { now: at, advisory, rainingHere: demo.rainingHere }), web: webForPage(result.web, at) },
      mmdaCredit: MMDA_CREDIT,
    });
  }
}
