import { admit } from "./admission";
import { readAdvisory, type AdvisoryReading } from "./advisory";
import { placeOnRoute, ROUTE_CORRIDOR_M, type AnswerKind, type Point, type Report } from "./answer";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { boxAround, lineForTrip } from "./detour";
import { ageWords, depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { evidenceSentences } from "./evidence-words";
import { investigate, investigationReserveMicros, PICK_UNAVAILABLE, webFindingCounts, type InvestigationResult } from "./investigation";
import type { Meter } from "./meta";
import { fetchRoute, ROUTE_WORST_MS, type Route, type RouteResult, type ValhallaGate } from "./router";
import { beforeDeadline, readBody } from "./deadline";
import { inMetroCebu } from "./metro-cebu";
import { reportStoreFromEnv, toReport, type ReportStore } from "./report-store";
import { DEMO_TRIPS, sampleReports, scenariosFor, type DemoTripId, type SampleReport, type ScenarioId } from "./samples";
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

/** PAGASA, Valhalla and the report store are free, so without Muse Spark a check reserves 1 µ$: enough to pass the daily admission and its per-address limit. */
export const COMMUTE_RESERVE_MICROS = 1;

/**
 * Every part of a check ends this long after its first byte: the body, the admission, the report read, the advisory,
 * every routing attempt and gate wait, the web search and the model calls. app/api/commute/route.ts allows 90 s.
 */
export const COMMUTE_DEADLINE_MS = 80_000;
/** Left after the deadline to settle the budget (Upstash times out at 5 s) and send the answer. */
export const SETTLE_ROOM_MS = 10_000;

/** The one deadline's parts, shortened in tests. */
export interface CommuteTiming {
  deadlineMs: number;
  /** The longest one fetchRoute can take: a way around isn't started with less than this left. */
  routeWorstMs: number;
  /** The settle (and the release of an unused web search) is cut off this long after the deadline. */
  storeCallMs: number;
  /** The web search's model call ends with this much of the deadline left, beyond a way around: for the model's pick. */
  modelRoomMs: number;
}
export const MODEL_ROOM_MS = 15_000;
export const COMMUTE_TIMING: CommuteTiming = { deadlineMs: COMMUTE_DEADLINE_MS, routeWorstMs: ROUTE_WORST_MS, storeCallMs: 5_000, modelRoomMs: MODEL_ROOM_MS };

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
type PlainResult = RouteResult | { ok: false; reason: "off_trip" };

const ROUTE_ERRORS: Record<Exclude<PlainResult, { ok: true }>["reason"], string> = {
  unreachable: "Lusong couldn't reach the routing server, so it can't give an answer. Try again in a minute.",
  busy: "The routing server is busy with other checks, so Lusong can't give an answer. Try again in a few seconds.",
  gate_unavailable: "Lusong can't pace its requests to the routing server right now, so it sent none and can't give an answer.",
  no_route: "The routing server found no motorbike route for this trip, so Lusong can't give an answer.",
  out_of_time: "Lusong ran out of time asking the routing server, so it can't give an answer. Try again in a minute.",
  off_trip: "The routing server's route doesn't reach this trip's start and end, so Lusong can't give an answer.",
};

const AROUND_OUT_OF_TIME = "Lusong ran out of time looking for a way around, so it can't give an answer. Try again in a minute.";

const OUT_OF_TIME = "Lusong ran out of time checking this trip, so it can't give an answer. Try again in a minute.";

/** A check is a few short fields. */
const MAX_BODY_BYTES = 4 * 1024;

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

/**
 * The evidence Muse Spark picked, each piece described in Lusong's words from its own checked fields. Only the reports
 * the response sends can be described: a pick naming any other report is not shown at all.
 */
function pickForPage(
  result: Extract<InvestigationResult, { ok: true }>,
  facts: { now: Date; advisory: AdvisoryReading; rainingHere: boolean; sentReportIds: ReadonlySet<string> },
) {
  const label = "Muse Spark picked this evidence";
  const hidden = { shown: false, label, sentences: [] as string[], note: !result.pick.shown && result.pick.unavailable ? PICK_UNAVAILABLE : null };
  if (!result.pick.shown) return hidden;
  const { sentReportIds, ...rest } = facts;
  const reports = result.reports.filter((r) => sentReportIds.has(r.id));
  const sentences = evidenceSentences(result.pick.evidence, { ...rest, reports, web: result.web.findings, routes: result.answer.routes });
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

interface RealRequest {
  from: Point;
  to: Point;
  rainingHere: boolean;
}

function pointFrom(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return inMetroCebu({ lat, lon }) ? { lat, lon } : null;
}

function parseReal(body: unknown): RealRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== "real") return null;
  const from = pointFrom(b.from);
  const to = pointFrom(b.to);
  if (!from || !to) return null;
  if (b.rainingHere !== undefined && typeof b.rainingHere !== "boolean") return null;
  return { from, to, rainingHere: b.rainingHere === true };
}

/** A report as the answer sees it, with what the page shows about where it came from. */
type CheckedReport = SampleReport | (Report & { sample: false; origin: null; credit: null; sourceUrl: null });

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
 * POST /api/commute. A demo check uses its trip's sample reports and never reads the report store; a real check uses
 * the stored real reports and never a sample. A real trip is used for this answer only: nothing about it is cached
 * or stored. Both run Muse Spark's investigation the same way.
 */
export function makeCommuteHandler(deps: {
  fetch?: typeof fetch;
  now?: () => Date;
  gate: () => ValhallaGate;
  budget?: () => Budget;
  reports?: () => ReportStore | null;
  muse?: MuseDeps;
  timing?: CommuteTiming;
}) {
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.reports ?? reportStoreFromEnv;
  const muse = () => deps.muse ?? museFromEnv();
  const timing = deps.timing ?? COMMUTE_TIMING;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());
  const routes = new Map<DemoTripId, { route: Route; at: number }>();
  const detours = new Map<string, { result: RouteResult; at: number }>();
  let advisoryCache: { reading: AdvisoryReading; at: number } | null = null;

  async function routeFor(trip: DemoTripId, t: number, deadline: number): Promise<PlainResult> {
    const cached = routes.get(trip);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return { ok: true, route: cached.route };
    const result = await fetchRoute(DEMO_TRIPS[trip], { fetch: doFetch, gate: deps.gate(), deadline });
    if (result.ok && !lineForTrip(result.route.line, DEMO_TRIPS[trip])) return { ok: false, reason: "off_trip" };
    if (result.ok) routes.set(trip, { route: result.route, at: t });
    return result;
  }

  /** One more request, with a box excluded around each spot; "no route" is an answer, so it is kept too. */
  async function detourFor(trip: DemoTripId, spots: readonly Point[], t: number, deadline: number): Promise<RouteResult> {
    const key = `${trip}|${spots.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).sort().join(";")}`;
    const cached = detours.get(key);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return cached.result;
    const result = await fetchRoute(
      { ...DEMO_TRIPS[trip], excludePolygons: spots.map((p) => boxAround(p)) },
      { fetch: doFetch, gate: deps.gate(), deadline },
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
    // Epoch ms, from the first byte. Every step below ends by it; only the settle runs past it, cut off at settleBy.
    const deadline = Date.now() + timing.deadlineMs;
    const settleBy = deadline + timing.storeCallMs;

    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline });
    if (body === "too_large") return fail(413, "That check is too large.");
    if (body === "too_slow") return fail(408, "Lusong didn't receive the whole check in time.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return fail(400, "Send the check as JSON.");
    }
    const demo = parseDemo(parsed);
    const realTrip = demo ? null : parseReal(parsed);
    if (!demo && !realTrip) return fail(400, "Send a demo trip, or a real trip whose start and end are both in Metro Cebu.");

    const at = now();
    const museDeps = muse();
    const plan: WebPlan = museDeps.enabled ? await planWebSearch(museDeps.searchStore(), at, museDeps.searchBudget(), deadline) : { kind: "off", why: "Muse Spark is off" };
    if (Date.now() >= deadline) {
      // Planning took the whole deadline, so nothing is reserved; a search it planned is given back.
      void releaseWebSearch(plan).catch(() => {});
      return fail(503, OUT_OF_TIME);
    }
    const reserveMicros = COMMUTE_RESERVE_MICROS + (museDeps.enabled ? investigationReserveMicros(plan) : 0);
    const admitting = admit(budget(), { clientIp: clientIp(request), reserveMicros, now: at });
    const admission = await beforeDeadline(admitting, deadline);
    if (admission === "late") {
      // Nothing was asked of anyone, so a reservation that lands late is refunded, and the web search given back.
      void admitting.then(
        async (a) => {
          if (a.ok) await a.run.settle(true);
        },
        () => {},
      );
      void releaseWebSearch(plan).catch(() => {});
      return fail(503, OUT_OF_TIME);
    }
    if (!admission.ok) {
      await beforeDeadline(releaseWebSearch(plan), settleBy);
      return admission.response();
    }
    const run: CheckRun = {
      plan,
      store: museDeps.enabled ? museDeps.searchStore() : null,
      modelOff: museDeps.enabled ? undefined : "Muse Spark is off",
      meter: admission.run.meter,
      deadline,
      searched: false,
    };
    let answered = false;
    try {
      const response = demo ? await answerDemo(demo, at, run) : await answerReal(realTrip!, at, run);
      answered = response.ok;
      return response;
    } finally {
      // A settle cut off here keeps the reservation charged: the safe side. A search the check never ran is given back.
      await beforeDeadline(Promise.all([admission.run.settle(answered), run.searched ? null : releaseWebSearch(plan)]), settleBy);
    }
  };

  function answerDemo(demo: DemoRequest, at: Date, run: CheckRun): Promise<Response> {
    return answerTrip({
      demo: true,
      trip: { ...DEMO_TRIPS[demo.trip], id: demo.trip },
      rainingHere: demo.rainingHere,
      at,
      run,
      reports: async () => sampleReports(demo.trip, demo.scenario, at),
      plain: () => routeFor(demo.trip, at.getTime(), run.deadline),
      around: (spots) => detourFor(demo.trip, spots, at.getTime(), run.deadline),
    });
  }

  /** Not cached, unlike a demo trip's routes: a real trip's ends are the rider's, and the server keeps nothing of them. */
  function answerReal(trip: RealRequest, at: Date, run: CheckRun): Promise<Response> {
    const ends = { from: trip.from, to: trip.to };
    return answerTrip({
      demo: false,
      trip: { ...ends, id: null, label: "Your trip" },
      rainingHere: trip.rainingHere,
      at,
      run,
      reports: async () => {
        const store = reportStore();
        if (!store) throw new Error("no report store configured");
        return (await store.recent(at)).map((r) => ({ ...toReport(r), sample: false, origin: null, credit: null, sourceUrl: null }) as const);
      },
      plain: async () => {
        const result = await fetchRoute(ends, { fetch: doFetch, gate: deps.gate(), deadline: run.deadline });
        return result.ok && !lineForTrip(result.route.line, ends) ? { ok: false, reason: "off_trip" } : result;
      },
      around: (spots) =>
        fetchRoute({ ...ends, excludePolygons: spots.map((p) => boxAround(p)) }, { fetch: doFetch, gate: deps.gate(), deadline: run.deadline }),
    });
  }

  async function answerTrip(check: {
    demo: boolean;
    trip: { id: DemoTripId | null; label: string; from: Point; to: Point };
    rainingHere: boolean;
    at: Date;
    run: CheckRun;
    reports: () => Promise<CheckedReport[]>;
    plain: () => Promise<PlainResult>;
    around: (spots: readonly Point[]) => Promise<RouteResult>;
  }): Promise<Response> {
    const { at, trip, run } = check;
    // Reports first: if they can't be read there is no answer, so neither the routing server nor Muse Spark is asked.
    let reports: CheckedReport[] | "late";
    try {
      reports = await beforeDeadline(check.reports(), run.deadline);
    } catch (err) {
      console.error("report store unreadable:", err instanceof Error ? err.message : err);
      return fail(503, "Lusong couldn't read the reports from the street, so it can't give an answer. Try again in a minute.");
    }
    if (reports === "late") return fail(503, OUT_OF_TIME);
    const gathered: CheckedReport[] = reports;

    // The search ends early enough to leave a way around and the model's pick their time.
    const searchDeadline = run.deadline - timing.routeWorstMs - timing.modelRoomMs;
    run.searched = true;
    const [advisory, routed, web] = await Promise.all([
      beforeDeadline(advisoryAt(at), run.deadline),
      check.plain(),
      runWebSearch(run.plan, { store: run.store, now: at, deadline: searchDeadline, meter: run.meter }),
    ]);
    if (advisory === "late") return fail(503, OUT_OF_TIME);
    if (!routed.ok) return Response.json({ error: ROUTE_ERRORS[routed.reason], routing: routed.reason }, { status: 503 });

    const route = routed.route;
    const plainLine = lineForTrip(route.line, trip)!;
    const routesByLine = new Map<Point[], Route>();
    // Set inside routeAround, so declared with `as`: TypeScript would otherwise narrow it to null here for good.
    let routingFailure = null as Exclude<PlainResult, { ok: true }>["reason"] | null;

    const result = await investigate({
      plainLine,
      advisory,
      rainingHere: check.rainingHere,
      now: at,
      deadline: run.deadline,
      meter: run.meter,
      web,
      modelOff: run.modelOff,
      sources: {
        // Every report this check gathered, for every route: the rules keep the ones within each route's corridor.
        reportsAlong: async () => ({ ok: true, reports: gathered }),
        async routeAround(spots) {
          if (run.deadline - Date.now() < timing.routeWorstMs) {
            routingFailure = "out_of_time";
            return { ok: false, reason: "failed" };
          }
          const around = await check.around(spots);
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
      const error = reason === "out_of_time" ? AROUND_OUT_OF_TIME : ROUTE_ERRORS[reason];
      return Response.json({ error, routing: reason }, { status: 503 });
    }

    const answer = result.answer;
    const shown = (answer.answer === "go_another_way" ? result.detours.find((d) => d.id === answer.route) : result.detours[0]) ?? null;
    const detour = shown ? routesByLine.get(shown.line)! : null;
    const detourLine = shown?.line ?? null;
    const judged = new Map(answer.reports.map((r) => [r.id, r]));
    const used = gathered.filter((r) => answer.decidedBy.includes(r.id));
    const sent = gathered
      .map((r) => {
        const j = judged.get(r.id)!;
        const verdict = r.reading.source === "photo" ? r.reading.verdict : null;
        return {
          id: r.id,
          sample: r.sample,
          place: r.place,
          at: r.at,
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
      })
      // A real report off both routes played no part, and its exact spot is someone else's: it isn't sent.
      .filter((r) => check.demo || r.onRoute || r.onDetour);
    const sentReportIds = new Set(sent.map((r) => r.id));

    return Response.json({
      demo: check.demo,
      trip: { id: trip.id, label: trip.label },
      rainingHere: check.rainingHere,
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
      reports: sent,
      muse: { pick: pickForPage(result, { now: at, advisory, rainingHere: check.rainingHere, sentReportIds }), web: webForPage(result.web, at) },
      mmdaCredit: MMDA_CREDIT,
    });
  }
}

/** One admitted check's Muse Spark run and its deadline (epoch ms), threaded through every step. */
interface CheckRun {
  plan: WebPlan;
  store: KvStore | null;
  modelOff?: string;
  meter: Meter;
  deadline: number;
  /** Set once runWebSearch has the plan; until then the handler gives the plan back itself. */
  searched: boolean;
}
