import { admit } from "./admission";
import { readAdvisory, type AdvisoryReading } from "./advisory";
import { decideAnswer, placeOnRoute, ROUTE_CORRIDOR_M, type AnswerKind, type Report } from "./answer";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { boxAround, detourAvoids, lineForTrip } from "./detour";
import { ageWords, depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { fetchRoute, type Route, type RouteResult, type ValhallaGate } from "./router";
import { DEMO_TRIPS, sampleReports, scenariosFor, type DemoTripId, type ScenarioId } from "./samples";

/** The demo check makes no Meta call, so it reserves 1 µ$: enough to pass through the daily admission and its per-address limit. */
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
}) {
  const budget = deps.budget ?? budgetFromEnv;
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

  /** One more request, with a box excluded around each blocked spot; "no route" is an answer, so it is kept too. */
  async function detourFor(trip: DemoTripId, blockers: readonly Report[], t: number): Promise<RouteResult> {
    const key = `${trip}|${blockers.map((b) => b.id).sort().join(",")}`;
    const cached = detours.get(key);
    if (cached && t - cached.at < ROUTE_CACHE_MS) return cached.result;
    const result = await fetchRoute(
      { ...DEMO_TRIPS[trip], excludePolygons: blockers.map((b) => boxAround(b.at)) },
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

    const at = now();
    const admission = await admit(budget(), { clientIp: clientIp(request), reserveMicros: COMMUTE_RESERVE_MICROS, now: at });
    if (!admission.ok) return admission.response();
    let answered = false;
    try {
      const response = await answerDemo(demo, at);
      answered = response.ok;
      return response;
    } finally {
      await admission.run.settle(answered);
    }
  };

  async function answerDemo(demo: DemoRequest, at: Date): Promise<Response> {
    const [advisory, routed] = await Promise.all([advisoryAt(at), routeFor(demo.trip, at.getTime())]);
    if (!routed.ok) return Response.json({ error: ROUTE_ERRORS[routed.reason], routing: routed.reason }, { status: 503 });

    const route = routed.route;
    const trip = DEMO_TRIPS[demo.trip];
    const plainLine = lineForTrip(route.line, trip)!;
    const reports = sampleReports(demo.trip, demo.scenario, at);
    const judge = (detourLine: Route["line"] | null) =>
      decideAnswer({
        plain: { id: "plain", line: plainLine },
        detours: detourLine ? [{ id: "detour", line: detourLine }] : [],
        reports,
        advisory: advisory.state,
        rainingHere: demo.rainingHere,
        now: at,
      });
    let answer = judge(null);
    let detour: Route | null = null;
    let detourLine: Route["line"] | null = null;
    const plainJudged = answer.routes[0];
    if (plainJudged.state === "blocked") {
      const blockers = reports.filter((r) => plainJudged.blockedBy.includes(r.id));
      const around = await detourFor(demo.trip, blockers, at.getTime());
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
      demo: true,
      trip: { id: demo.trip, label: DEMO_TRIPS[demo.trip].label },
      rainingHere: demo.rainingHere,
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
      mmdaCredit: MMDA_CREDIT,
    });
  }
}
