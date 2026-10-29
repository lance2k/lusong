import { admit } from "./admission";
import { readAdvisory, type AdvisoryReading } from "./advisory";
import { decideAnswer, placeOnRoute, ROUTE_CORRIDOR_M, type AnswerKind, type Point, type Report } from "./answer";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { boxAround, detourAvoids, lineForTrip } from "./detour";
import { ageWords, depthWords, MMDA_CREDIT, passabilityLine, phtTime, voiceDepthWords, voicePassabilityLine } from "./commute-words";
import { fetchRoute, type Route, type RouteResult, type ValhallaGate } from "./router";
import { beforeDeadline, readBody } from "./deadline";
import { inMetroCebu } from "./metro-cebu";
import { reportStoreFromEnv, toReport, type ReportStore } from "./report-store";
import { DEMO_TRIPS, sampleReports, scenariosFor, type DemoTripId, type SampleReport, type ScenarioId } from "./samples";

/** A commute check makes no Meta call, so it reserves 1 µ$: enough to pass through the daily admission and its per-address limit. */
export const COMMUTE_RESERVE_MICROS = 1;

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
type CheckedReport =
  | (SampleReport & { photoUrl?: undefined })
  | (Report & { sample: false; origin: null; credit: null; sourceUrl: null; photoUrl: string | null });

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
 * or stored.
 */
/**
 * One deadline for the whole check, under the route's 60 s maxDuration: the admission, the report read, the advisory
 * and every routing attempt and gate wait must end in time for the settle and the response.
 */
export interface CommuteTiming {
  budgetMs: number;
  /** The admission and the settle are each one Upstash call bounded at this by its own timeout. */
  storeCallMs: number;
  responseMs: number;
}
export const COMMUTE_TIMING: CommuteTiming = { budgetMs: 50_000, storeCallMs: 5_000, responseMs: 2_000 };

/** A check is a few short fields. */
const MAX_BODY_BYTES = 4 * 1024;

const OUT_OF_TIME = "Lusong ran out of time checking this trip, so it can't give an answer. Try again in a minute.";

export function makeCommuteHandler(deps: {
  fetch?: typeof fetch;
  now?: () => Date;
  gate: () => ValhallaGate;
  budget?: () => Budget;
  reports?: () => ReportStore | null;
  timing?: CommuteTiming;
}) {
  const timing = deps.timing ?? COMMUTE_TIMING;
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.reports ?? reportStoreFromEnv;
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

  /** One more request, with a box excluded around each blocked spot; "no route" is an answer, so it is kept too. */
  async function detourFor(trip: DemoTripId, blockers: readonly Report[], t: number, deadline: number): Promise<RouteResult> {
    const key = `${trip}|${blockers.map((b) => b.id).sort().join(",")}`;
    const cached = detours.get(key);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return cached.result;
    const result = await fetchRoute(
      { ...DEMO_TRIPS[trip], excludePolygons: blockers.map((b) => boxAround(b.at)) },
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
    // Epoch ms. The admission and the answer must end in time for the settle, and the settle in time for the response.
    const deadline = Date.now() + timing.budgetMs;
    const settleBy = deadline - timing.responseMs;
    const answerBy = settleBy - timing.storeCallMs;

    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: answerBy });
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
    const admitting = admit(budget(), { clientIp: clientIp(request), reserveMicros: COMMUTE_RESERVE_MICROS, now: at });
    const admission = await beforeDeadline(admitting, answerBy);
    if (admission === "late") {
      // Nothing was asked of anyone, so a reservation that lands late is refunded.
      void admitting.then(
        async (a) => {
          if (a.ok) await a.run.settle(true);
        },
        () => {},
      );
      return fail(503, OUT_OF_TIME);
    }
    if (!admission.ok) return admission.response();
    let answered = false;
    try {
      const response = demo ? await answerDemo(demo, at, answerBy) : await answerReal(realTrip!, at, answerBy);
      answered = response.ok;
      return response;
    } finally {
      // A settle cut off here keeps the reservation charged: the safe side.
      await beforeDeadline(admission.run.settle(answered), settleBy);
    }
  };

  function answerDemo(demo: DemoRequest, at: Date, deadline: number): Promise<Response> {
    return answerTrip({
      demo: true,
      trip: { ...DEMO_TRIPS[demo.trip], id: demo.trip },
      rainingHere: demo.rainingHere,
      at,
      reports: async () => sampleReports(demo.trip, demo.scenario, at),
      deadline,
      plain: () => routeFor(demo.trip, at.getTime(), deadline),
      around: (blockers) => detourFor(demo.trip, blockers, at.getTime(), deadline),
    });
  }

  /** Not cached, unlike a demo trip's routes: a real trip's ends are the rider's, and the server keeps nothing of them. */
  function answerReal(trip: RealRequest, at: Date, deadline: number): Promise<Response> {
    const ends = { from: trip.from, to: trip.to };
    return answerTrip({
      demo: false,
      trip: { ...ends, id: null, label: "Your trip" },
      rainingHere: trip.rainingHere,
      at,
      deadline,
      reports: async () => {
        const store = reportStore();
        if (!store) throw new Error("no report store configured");
        return (await store.recent(at)).map(
          (r) =>
            ({
              ...toReport(r),
              sample: false,
              origin: null,
              credit: null,
              sourceUrl: null,
              // Only ever the blurred copy's URL: the original photo is never stored.
              photoUrl: r.kind === "photo" ? (r.photoUrl ?? null) : null,
            }) as const,
        );
      },
      plain: async () => {
        const result = await fetchRoute(ends, { fetch: doFetch, gate: deps.gate(), deadline });
        return result.ok && !lineForTrip(result.route.line, ends) ? { ok: false, reason: "off_trip" } : result;
      },
      around: (blockers) =>
        fetchRoute({ ...ends, excludePolygons: blockers.map((b) => boxAround(b.at)) }, { fetch: doFetch, gate: deps.gate(), deadline }),
    });
  }

  async function answerTrip(check: {
    demo: boolean;
    trip: { id: DemoTripId | null; label: string; from: Point; to: Point };
    rainingHere: boolean;
    at: Date;
    /** Epoch ms by which the answer is ready. */
    deadline: number;
    reports: () => Promise<CheckedReport[]>;
    plain: () => Promise<PlainResult>;
    around: (blockers: readonly Report[]) => Promise<RouteResult>;
  }): Promise<Response> {
    const { at, trip } = check;
    // Reports first: if they can't be read there is no answer, so the routing server isn't asked at all.
    let reports: CheckedReport[] | "late";
    try {
      reports = await beforeDeadline(check.reports(), check.deadline);
    } catch (err) {
      console.error("report store unreadable:", err instanceof Error ? err.message : err);
      return fail(503, "Lusong couldn't read the reports from the street, so it can't give an answer. Try again in a minute.");
    }
    if (reports === "late") return fail(503, OUT_OF_TIME);
    const [advisory, routed] = await Promise.all([beforeDeadline(advisoryAt(at), check.deadline), check.plain()]);
    if (advisory === "late") return fail(503, OUT_OF_TIME);
    if (!routed.ok) return Response.json({ error: ROUTE_ERRORS[routed.reason], routing: routed.reason }, { status: 503 });

    const route = routed.route;
    const plainLine = lineForTrip(route.line, trip)!;
    const judge = (detourLine: Route["line"] | null) =>
      decideAnswer({
        plain: { id: "plain", line: plainLine },
        detours: detourLine ? [{ id: "detour", line: detourLine }] : [],
        reports,
        advisory: advisory.state,
        rainingHere: check.rainingHere,
        now: at,
      });
    let answer = judge(null);
    let detour: Route | null = null;
    let detourLine: Route["line"] | null = null;
    const plainJudged = answer.routes[0];
    if (plainJudged.state === "blocked") {
      const blockers = reports.filter((r) => plainJudged.blockedBy.includes(r.id));
      const around = await check.around(blockers);
      if (!around.ok && around.reason !== "no_route") {
        return Response.json({ error: ROUTE_ERRORS[around.reason], routing: around.reason }, { status: 503 });
      }
      // A reply that misses the trip's ends, or still meets a blocked spot, is no way around it, whatever Valhalla meant.
      const line = around.ok ? lineForTrip(around.route.line, trip) : null;
      if (around.ok && line && detourAvoids(line, blockers.map((b) => b.at))) {
        detour = around.route;
        detourLine = line;
        answer = judge(line);
      }
    }
    const judged = new Map(answer.reports.map((r) => [r.id, r]));
    const used = reports.filter((r) => answer.decidedBy.includes(r.id));

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
        state: answer.routes[1].state,
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
        const voice = r.reading.source === "voice" ? r.reading.says : null;
        return {
          id: r.id,
          sample: r.sample,
          place: r.place,
          at: r.at,
          age: ageWords(at.getTime() - r.receivedAt.getTime()),
          depth: verdict ? depthWords(verdict) : voice === "knee_deep_or_deeper" ? voiceDepthWords("knee_or_deeper") : null,
          passability: verdict ? passabilityLine(verdict) : voice ? voicePassabilityLine(voice) : null,
          origin: r.origin,
          credit: r.credit,
          sourceUrl: r.sourceUrl,
          photoUrl: r.photoUrl ?? null,
          counts: j.counts,
          onRoute: placeOnRoute(r.at, plainLine).offM <= ROUTE_CORRIDOR_M,
          onDetour: detourLine !== null && placeOnRoute(r.at, detourLine).offM <= ROUTE_CORRIDOR_M,
          role: j.role,
        };
      })
        // A real report off both routes played no part, and its exact spot is someone else's: it isn't sent.
        .filter((r) => check.demo || r.onRoute || r.onDetour),
      mmdaCredit: MMDA_CREDIT,
    });
  }
}
