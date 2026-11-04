import { admit } from "./admission";
import { advisoryAreasFor } from "./advisory-areas";
import {
  advisoryStoreFromEnv,
  judgeRoute,
  MemoryAdvisoryStore,
  snapshotForCheck,
  type AdvisoryStore,
  type ProductView,
  type RouteAdvisory,
  type SnapshotReading,
} from "./advisory-snapshot";
import { placeOnRoute, ROUTE_CORRIDOR_M, type AnswerKind, type Point, type Report } from "./answer";
import { budgetFromEnv, type Budget } from "./budget";
import { sweepWarningsAlong } from "./sweep-warnings";
import { alertStoreFromEnv, type AlertStore } from "./alerts";
import { clientIp } from "./check-handler";
import { boxAround, lineForTrip } from "./detour";
import { ageWords, depthWords, MMDA_CREDIT, passabilityLine, phtTime, voiceDepthWords, voicePassabilityLine } from "./commute-words";
import { evidenceSentences } from "./evidence-words";
import {
  investigate,
  investigationReserveMicros,
  PICK_UNAVAILABLE,
  pickableReportIds,
  webFindingCounts,
  type InvestigationResult,
} from "./investigation";
import type { Meter } from "./meta";
import {
  endsTooFarApart,
  fetchRoute,
  MAX_ROUTE_KM,
  MAX_TRIP_STRAIGHT_KM,
  ROUTE_WORST_MS,
  type Route,
  type RouteResult,
  type ValhallaGate,
} from "./router";
import { beforeDeadline, readBody } from "./deadline";
import { inServerTripBound } from "./province-index";
import { TRIP_AREA_NAME } from "./trip-bound";
import { reportStoreFromEnv, toReport, type ReportStore } from "./report-store";
import { DEMO_TRIPS, sampleReports, scenariosFor, type DemoTripId, type SampleReport, type ScenarioId } from "./samples";
import {
  mergeWebEvidence,
  OFF_THE_STRAIGHT_LINE,
  OVER_THE_CAP,
  planWebSearches,
  releaseWebSearches,
  runWebSearches,
  SEARCH_RESERVE_MICROS,
  searchAreasFor,
  searchBudgetFromEnv,
  searchStoreFromEnv,
  webCoverage,
  type ClosureKind,
  type KvStore,
  type SearchArea,
  type WebCoverage,
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
  /** An inline refresh of PAGASA's snapshot ends this long after it starts; ADVISORY_TIME_MS unless a test shortens it. */
  advisoryMs?: number;
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
/**
 * A check that finds PAGASA's snapshot missing or stale refreshes it inline for at most this long; past it the check
 * reads the snapshot as incomplete. The old reader's 15 s, plus room for a cold snapshot's first records.
 */
export const ADVISORY_TIME_MS = 20_000;

/** Lusong's fixed answer words: the page's title and the watcher's message use these only. */
export const TITLES: Record<AnswerKind, string> = {
  go: "Go",
  go_another_way: "Go another way",
  wait: "Wait. Check again in 30 minutes.",
  no_one_knows: "No one knows",
};

/** A route that doesn't reach the trip's own ends is never judged: part of a trip can't answer for all of it. */
type PlainResult = RouteResult | { ok: false; reason: "off_trip" };

const ISLAND_MESSAGE =
  "Lusong found no road between these two places. They may be on different islands; Lusong checks trips on one island's roads.";
const TOO_FAR_MESSAGE = `These two places are more than ${MAX_TRIP_STRAIGHT_KM} km apart. Lusong checks commutes up to ${MAX_ROUTE_KM} km by road.`;

const ROUTE_ERRORS: Record<Exclude<PlainResult, { ok: true }>["reason"], string> = {
  unreachable: "Lusong couldn't reach the routing server, so it can't give an answer. Try again in a minute.",
  busy: "The routing server is busy with other checks, so Lusong can't give an answer. Try again in a few seconds.",
  gate_unavailable: "Lusong can't pace its requests to the routing server right now, so it sent none and can't give an answer.",
  no_route: ISLAND_MESSAGE,
  ferry: ISLAND_MESSAGE,
  too_far: TOO_FAR_MESSAGE,
  too_long: `This trip is longer than ${MAX_ROUTE_KM} km by road. Lusong checks commutes up to ${MAX_ROUTE_KM} km.`,
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
  "another check is searching the web right now": "another check was searching it and hadn't finished",
  "today's web search budget is used up": "today's web search budget is used up",
  "Muse Spark is off": "Muse Spark is off",
  [OVER_THE_CAP]: "Lusong searches at most two provinces a check",
  [OFF_THE_STRAIGHT_LINE]: "the route enters it away from the straight line the search was planned from",
};

const CLOSURE_WORDS: Record<ClosureKind, string> = { closed: "Closed", flooded: "Flooded", not_passable: "Not passable", other_blocking: "Blocked" };

/** Said when the route enters a province no search covered, whatever the reason. */
function coverageNote(coverage: WebCoverage): string | null {
  if (coverage.missed.length === 0) return null;
  const missed = coverage.missed.map((m) => `${m.area.name} (${WEB_WHY[m.why] ?? m.why})`).join("; ");
  const covered = coverage.searched.length > 0 ? `The web search covered only part of this route: ${coverage.searched.map((a) => a.name).join(" and ")}.` : "The web search didn't cover this route.";
  return `${covered} Not searched: ${missed}.`;
}

/** A web finding is shown as Lusong's description of its checked fields; the source's own words are never kept. */
function webForPage(web: WebEvidence, coverage: WebCoverage, now: Date) {
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
    coverage: { searched: coverage.searched.map((a) => a.name), missed: coverage.missed.map((m) => m.area.name), note: coverageNote(coverage) },
    findings: web.findings.map((f) => {
      const site = new URL(f.url).hostname;
      const page = f.sourceDate ? `a page on ${site} dated ${f.sourceDate}` : `an undated page on ${site}`;
      return { place: f.place, url: f.url, site, sourceDate: f.sourceDate, description: `${CLOSURE_WORDS[f.kind]}, says ${page}.`, counted: webFindingCounts(f, now), note: note(f) };
    }),
  };
}

/**
 * The evidence Muse Spark picked, each piece described in Lusong's words from its own checked fields. Only pickable
 * reports, the ones the response always sends, can be described: a pick naming any other report is not shown at all.
 */
function pickForPage(
  result: Extract<InvestigationResult, { ok: true }>,
  facts: { now: Date; advisory: RouteAdvisory; rainingHere: boolean; pickable: ReadonlySet<string> },
) {
  const label = "Muse Spark picked this evidence";
  const hidden = { shown: false, label, sentences: [] as string[], note: !result.pick.shown && result.pick.unavailable ? PICK_UNAVAILABLE : null };
  if (!result.pick.shown) return hidden;
  const { pickable, ...rest } = facts;
  const reports = result.reports.filter((r) => pickable.has(r.id));
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
  return inServerTripBound({ lat, lon }) ? { lat, lon } : null;
}

function parseReal(body: unknown): RealRequest | "too_far" | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.mode !== "real") return null;
  const from = pointFrom(b.from);
  const to = pointFrom(b.to);
  if (!from || !to) return null;
  if (b.rainingHere !== undefined && typeof b.rainingHere !== "boolean") return null;
  if (endsTooFarApart(from, to)) return "too_far";
  return { from, to, rainingHere: b.rainingHere === true };
}

/** A report as the answer sees it, with what the page shows about where it came from. */
type CheckedReport =
  | (SampleReport & { photoUrl?: undefined })
  | (Report & { sample: false; origin: null; credit: null; sourceUrl: null; photoUrl: string | null });

const ADVISORY_NOTES: Record<RouteAdvisory["state"], string | null> = {
  active: null,
  none: "No PAGASA advisory in its feed covers this way right now.",
  unreadable: "Lusong couldn't read all of PAGASA's advisories, so it counts one as active.",
};

function productForPage(p: ProductView) {
  return {
    kind: p.kind,
    counts: p.counts,
    event: p.event,
    area: p.areas.join(", "),
    sent: phtTime(p.sent),
    expires: phtTime(p.expires),
    link: p.link,
    rainForecast: p.rainForecast,
    rivers: p.rivers,
  };
}

/** The advisory card describes the route the answer recommends: the plain way, or the detour for Go another way. */
function advisoryForPage(advisory: RouteAdvisory, routeId: string) {
  return {
    state: advisory.state,
    about: routeId === "plain" ? ("your way" as const) : ("the other way" as const),
    products: advisory.covering.map(productForPage),
    warnings: advisory.warnings.map(productForPage),
    incomplete: advisory.incomplete !== null,
    readAt: advisory.readAt ? phtTime(advisory.readAt) : null,
    note:
      advisory.state === "none" && advisory.readAt
        ? `No PAGASA advisory covered this way when Lusong last read its feed, at ${phtTime(advisory.readAt)}.`
        : ADVISORY_NOTES[advisory.state],
  };
}

function thinNote(kind: AnswerKind, reportCount: number, voiceOnly: boolean): string {
  if (kind === "go" && reportCount === 0) return "Nobody has reported your way. This answer rests on no advisory and no rain tap.";
  if (kind === "go_another_way" && reportCount === 0) {
    return "Nobody has reported the other way. This answer rests on no advisory and no rain tap.";
  }
  if (voiceOnly) return "This answer rests on voice reports only.";
  return "This answer rests on one report.";
}

type CommuteDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  gate: () => ValhallaGate;
  budget?: () => Budget;
  reports?: () => ReportStore | null;
  muse?: MuseDeps;
  timing?: CommuteTiming;
  /** The shared store holding PAGASA's snapshot; without one, each handler keeps its own in memory. */
  advisoryStore?: () => AdvisoryStore | null;
  /** The sweep's items, shown as warnings beside the answer and never deciding it (lib/sweep-warnings.ts). */
  alertStore?: () => AlertStore | null;
};

/** What a scheduled check learns: the answer's kind, or the HTTP status a page would have been given instead. */
/** `line`: the plain route's line, which the watcher keeps as its alert corridor (lib/alert-corridor.ts). */
export type ScheduledCheck = { ok: true; kind: AnswerKind; line?: Point[] } | { ok: false; status: number };

/**
 * POST /api/commute. A demo check uses its trip's sample reports and never reads the report store; a real check uses
 * the stored real reports and never a sample. A real trip is used for this answer only: nothing about it is cached
 * or stored. Both run Muse Spark's investigation the same way.
 */
export function makeCommuteHandler(deps: CommuteDeps) {
  return makeCommuteCheck(deps).POST;
}

/**
 * The page's POST and, for the watcher, `checkTrip`: the same real check of a stored trip, Muse Spark's investigation
 * included, admitted with no address (a scheduled run no client asked for), so it counts against the daily cap and no
 * address's limit.
 */
export function makeCommuteCheck(deps: CommuteDeps) {
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.reports ?? reportStoreFromEnv;
  const muse = () => deps.muse ?? museFromEnv();
  const timing = deps.timing ?? COMMUTE_TIMING;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());
  const routes = new Map<DemoTripId, { route: Route; at: number }>();
  const detours = new Map<string, { result: RouteResult; at: number }>();
  const localAdvisoryStore = new MemoryAdvisoryStore();
  const advisoryStore = () => (deps.advisoryStore ?? advisoryStoreFromEnv)() ?? localAdvisoryStore;

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
    if (result.ok || result.reason === "no_route" || result.reason === "ferry" || result.reason === "too_long") detours.set(key, { result, at: t });
    return result;
  }

  function advisoryAt(at: Date, deadline: number): Promise<SnapshotReading> {
    return snapshotForCheck({ store: advisoryStore(), fetch: doFetch, now: at, deadline: Math.min(deadline, Date.now() + (timing.advisoryMs ?? ADVISORY_TIME_MS)) });
  }

  async function POST(request: Request): Promise<Response> {
    // Epoch ms, from the first byte. Every step below ends by it; only the settle runs past it, cut off at settleBy.
    const deadline = Date.now() + timing.deadlineMs;

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
    if (realTrip === "too_far") return Response.json({ error: TOO_FAR_MESSAGE, routing: "too_far" }, { status: 400 });
    if (!demo && !realTrip) return fail(400, `Send a demo trip, or a real trip whose start and end are both in ${TRIP_AREA_NAME}.`);
    return admitted(demo ? { demo } : { real: realTrip! }, clientIp(request), deadline, true);
  }

  async function checkTrip(trip: { from: Point; to: Point }, opts: { deadline: number }): Promise<ScheduledCheck> {
    const real = parseReal({ mode: "real", from: trip.from, to: trip.to });
    if (!real || real === "too_far") return { ok: false, status: 400 };
    // The caller's deadline bounds the settle too, so the check's own deadline is one store call earlier.
    const startedAt = Date.now();
    const deadline = Math.min(opts.deadline - timing.storeCallMs, startedAt + timing.deadlineMs);
    // The search's cut-off is taken back from the deadline, so with less than the page's whole deadline a search would
    // have less time than the page's check gives it, and could be cut off and still paid for (#26): it isn't started.
    const response = await admitted({ real }, null, deadline, deadline - startedAt >= timing.deadlineMs);
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json()) as { answer?: { kind?: unknown }; route?: { line?: unknown } };
    const kind = body.answer?.kind;
    const line = Array.isArray(body.route?.line) ? (body.route.line as Point[]) : undefined;
    return typeof kind === "string" && Object.hasOwn(TITLES, kind) ? { ok: true, kind: kind as AnswerKind, ...(line ? { line } : {}) } : { ok: false, status: 500 };
  }

  /**
   * The check after its request is read, for the page and the watcher alike. `deadline` is epoch ms: every step ends by
   * it, held in the one CheckRun every step reads; only the settle runs past it, cut off at settleBy. With `canSearch`
   * false, a province's stored search is still used, but no search is planned or reserved for.
   */
  async function admitted(
    check: { demo: DemoRequest } | { real: RealRequest },
    ip: string | null,
    deadline: number,
    canSearch: boolean,
  ): Promise<Response> {
    const settleBy = deadline + timing.storeCallMs;
    const at = now();
    const museDeps = muse();
    const ends = "demo" in check ? DEMO_TRIPS[check.demo.trip] : check.real;
    // Planned from the trip's ends, not its route, so the searches run beside the routing.
    const areas = museDeps.enabled ? searchAreasFor(ends.from, ends.to) : [];
    const plans: WebPlan[] = museDeps.enabled
      ? await planWebSearches(areas, museDeps.searchStore(), at, museDeps.searchBudget(), deadline, canSearch)
      : [{ kind: "off", area: null, why: "Muse Spark is off" }];
    if (Date.now() >= deadline) {
      // Planning took the whole deadline, so nothing is reserved; a search it planned is given back.
      void releaseWebSearches(plans).catch(() => {});
      return fail(503, OUT_OF_TIME);
    }
    const searches = plans.filter((p) => p.kind === "search").length;
    // One admission holds the model's loop and every planned search, so a check can't start a search it can't pay for.
    const reserveMicros = COMMUTE_RESERVE_MICROS + (museDeps.enabled ? investigationReserveMicros({ kind: "cached" }) + searches * SEARCH_RESERVE_MICROS : 0);
    const admitting = admit(budget(), { clientIp: ip, reserveMicros, now: at });
    const admission = await beforeDeadline(admitting, deadline);
    if (admission === "late") {
      // Nothing was asked of anyone, so a reservation that lands late is refunded, and the web search given back.
      void admitting.then(
        async (a) => {
          if (a.ok) await a.run.settle(true);
        },
        () => {},
      );
      void releaseWebSearches(plans).catch(() => {});
      return fail(503, OUT_OF_TIME);
    }
    if (!admission.ok) {
      await beforeDeadline(releaseWebSearches(plans), settleBy);
      return admission.response();
    }
    const run: CheckRun = {
      areas,
      plans,
      store: museDeps.enabled ? museDeps.searchStore() : null,
      modelOff: museDeps.enabled ? undefined : "Muse Spark is off",
      meter: admission.run.meter,
      deadline,
      searched: false,
    };
    let answered = false;
    try {
      const response = "demo" in check ? await answerDemo(check.demo, at, run) : await answerReal(check.real, at, run);
      answered = response.ok;
      return response;
    } finally {
      // A settle cut off here keeps the reservation charged: the safe side. A search the check never ran is given back.
      await beforeDeadline(Promise.all([admission.run.settle(answered), run.searched ? null : releaseWebSearches(plans)]), settleBy);
    }
  }

  return { POST, checkTrip };

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
    // A demo shows its sample reports only, so the sweep's real-world items are left out of it.
    const sweepStore = check.demo ? null : (deps.alertStore ?? alertStoreFromEnv)();
    const sweepAlerts = sweepStore ? sweepStore.all(at.getTime()).catch(() => []) : Promise.resolve([]);
    const [advisory, routed, webParts] = await Promise.all([
      beforeDeadline(advisoryAt(at, run.deadline), run.deadline),
      check.plain(),
      runWebSearches(run.plans, { store: run.store, now: at, deadline: run.deadline, searchBy: searchDeadline, meter: run.meter }),
    ]);
    const web = mergeWebEvidence(webParts);
    if (advisory === "late") return fail(503, OUT_OF_TIME);
    if (!routed.ok) return Response.json({ error: ROUTE_ERRORS[routed.reason], routing: routed.reason }, { status: 503 });

    const route = routed.route;
    const plainLine = lineForTrip(route.line, trip)!;
    const routesByLine = new Map<Point[], Route>();
    // Set inside routeAround, so declared with `as`: TypeScript would otherwise narrow it to null here for good.
    let routingFailure = null as Exclude<PlainResult, { ok: true }>["reason"] | null;

    const result = await investigate({
      plainLine,
      advisoryFor: (line) => judgeRoute(advisory, line, at),
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
            // A way around by ferry, or past the length cap, is no way around on this island's roads.
            if (around.reason === "no_route" || around.reason === "ferry" || around.reason === "too_long") return { ok: false, reason: "no_route" };
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
    const judgedLines = [{ id: "plain", line: plainLine }, ...result.detours];
    const pickable = pickableReportIds(answer);
    const judged = new Map(answer.reports.map((r) => [r.id, r]));
    const used = gathered.filter((r) => answer.decidedBy.includes(r.id));
    const sent = gathered
      .map((r) => {
        const j = judged.get(r.id)!;
        const verdict = r.reading.source === "photo" ? r.reading.verdict : null;
        const voice = r.reading.source === "voice" ? r.reading.says : null;
        const routes = judgedLines.filter((l) => placeOnRoute(r.at, l.line).offM <= ROUTE_CORRIDOR_M).map((l) => l.id);
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
          onRoute: routes.includes("plain"),
          onDetour: shown !== null && routes.includes(shown.id),
          routes,
          role: j.role,
        };
      })
      // A real report off the shown routes is sent only when Muse Spark may pick it; any other report off them played
      // no part, and its exact spot is someone else's.
      .filter((r) => check.demo || r.onRoute || r.onDetour || pickable.has(r.id));

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
        routeId: shown!.id,
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
      advisory: advisoryForPage(result.advisory, answer.route),
      advisoryAreas: advisoryAreasFor(advisory, judgedLines.map((l) => l.line), at),
      sweepWarnings: sweepWarningsAlong(await beforeDeadline(sweepAlerts, run.deadline + timing.storeCallMs), [plainLine, ...(shown ? [shown.line] : [])]),
      reports: sent,
      muse: {
        pick: pickForPage(result, { now: at, advisory: result.advisory, rainingHere: check.rainingHere, pickable }),
        web: webForPage(result.web, webCoverage([route.line, ...(detour ? [detour.line] : [])], webParts, run.areas), at),
      },
      mmdaCredit: MMDA_CREDIT,
    });
  }
}

/** One admitted check's Muse Spark run and its deadline (epoch ms), threaded through every step. */
interface CheckRun {
  /** The provinces the searches were planned from, past the cap included. */
  areas: SearchArea[];
  /** One per province searched, or one "off" plan when none is. */
  plans: WebPlan[];
  store: KvStore | null;
  modelOff?: string;
  meter: Meter;
  deadline: number;
  /** Set once runWebSearches has the plans; until then the handler gives them back itself. */
  searched: boolean;
}
