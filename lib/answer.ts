import type { Verdict } from "./verdict";

/** Answer rules v2 (lance2k/lusong#3, comment "Answer rules v2", 2026-10-30). */

export interface Point {
  lat: number;
  lon: number;
}

export type ReportReading =
  | { source: "photo"; verdict: Verdict; capturedAt: Date | null }
  | { source: "voice"; says: "passable" | "knee_deep_or_deeper" | "not_passable" | "unsure" }
  | { source: "web"; says: "closed"; sourceDate: string | null };

export interface Report {
  id: string;
  at: Point;
  wayId: number | null;
  receivedAt: Date;
  place: string;
  reading: ReportReading;
}

/** A report counts while its age is under this; 3 h has no Cebu drainage data behind it. */
export const REPORT_LIFETIME_MS = 3 * 60 * 60 * 1000;

/** A no_flood photo clears only when its EXIF capture time is at most this long before receipt. */
export const CLEAR_PHOTO_CAPTURE_WINDOW_MS = 60 * 60 * 1000;

/** A newer clearing photo retires a blocker only within this distance, and only on the same OSM way. */
export const SAME_SPOT_M = 50;

/** A report is on a route when it lies within this distance of the route line. */
export const ROUTE_CORRIDOR_M = 30;

/**
 * Under rain, every point of a route must lie within this distance, along the route, of a counting clear report.
 * 500 m has no data behind it; it is a decision for Lance.
 */
export const COVER_GAP_M = 500;

/** What a report can do to a spot: clear it, block it, or neither. */
export type Role = "clear" | "block" | "neutral";

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;

function phtDate(t: Date): string {
  return new Date(t.getTime() + PHT_OFFSET_MS).toISOString().slice(0, 10);
}

export function counts(report: Report, now: Date): boolean {
  return now.getTime() - report.receivedAt.getTime() < REPORT_LIFETIME_MS;
}

export function roleOf(report: Report, now: Date): Role {
  const r = report.reading;
  switch (r.source) {
    case "photo": {
      const v = r.verdict;
      if (v.kind === "no_flood") {
        if (!r.capturedAt) return "neutral";
        const takenBefore = report.receivedAt.getTime() - r.capturedAt.getTime();
        return takenBefore >= 0 && takenBefore <= CLEAR_PHOTO_CAPTURE_WINDOW_MS ? "clear" : "neutral";
      }
      if (v.kind === "measured" && (v.passability === "NPLV" || v.passability === "NPATV")) return "block";
      return "neutral";
    }
    case "voice":
      return r.says === "knee_deep_or_deeper" || r.says === "not_passable" ? "block" : "neutral";
    case "web":
      return r.sourceDate !== null && r.sourceDate === phtDate(now) ? "block" : "neutral";
  }
}

export type AdvisoryState = "active" | "none" | "unreadable";

export interface RouteCandidate {
  id: string;
  line: Point[];
}

export type AnswerKind = "go" | "go_another_way" | "wait" | "no_one_knows";
export type RouteState = "passable" | "blocked" | "unknown";

export interface RouteJudgement {
  routeId: string;
  state: RouteState;
  /** Counting, unretired reports within the corridor, in input order. */
  reportIds: string[];
  /** Of those, the ones that block it. */
  blockedBy: string[];
}

export interface ReportJudgement {
  id: string;
  role: Role;
  counts: boolean;
  /** The newer clear photo that retired this blocker, if any. */
  retiredBy: string | null;
}

export interface Answer {
  answer: AnswerKind;
  /** A few plain sentences: why this answer. */
  reason: string;
  /** The route the answer is about: the plain route, or the detour for Go another way. */
  route: string;
  /** The reports the answer rests on: the blockers for Wait, otherwise the counting reports on the route. */
  decidedBy: string[];
  /** One report or fewer behind the answer, or voice reports only. */
  thinEvidence: boolean;
  routes: RouteJudgement[];
  reports: ReportJudgement[];
}

const EARTH_RADIUS_M = 6_371_008.8;

export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Metres east and north of `origin`; flat-earth is accurate to well under 1 m across a city. */
function toLocal(origin: Point, p: Point): { x: number; y: number } {
  const rad = Math.PI / 180;
  return {
    x: (p.lon - origin.lon) * rad * EARTH_RADIUS_M * Math.cos(origin.lat * rad),
    y: (p.lat - origin.lat) * rad * EARTH_RADIUS_M,
  };
}

/** How far a point lies from a route line (to the nearest segment) and how far along the route that nearest spot is. */
export function placeOnRoute(p: Point, line: readonly Point[]): { offM: number; alongM: number } {
  const origin = line[0];
  const q = toLocal(origin, p);
  let best = { offM: Infinity, alongM: 0 };
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = toLocal(origin, line[i]);
    const b = toLocal(origin, line[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (len * len)));
    const off = Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
    if (off < best.offM) best = { offM: off, alongM: walked + t * len };
    walked += len;
  }
  if (line.length === 1) best = { offM: Math.hypot(q.x, q.y), alongM: 0 };
  return best;
}

export function routeLengthM(line: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = toLocal(line[0], line[i]);
    const b = toLocal(line[0], line[i + 1]);
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** True when every point of [0, lengthM] lies within COVER_GAP_M of one of the positions. */
function covered(positions: number[], lengthM: number): boolean {
  if (positions.length === 0) return false;
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted[0] > COVER_GAP_M || lengthM - sorted[sorted.length - 1] > COVER_GAP_M) return false;
  return sorted.every((p, i) => i === 0 || p - sorted[i - 1] <= 2 * COVER_GAP_M);
}

/** Pairwise, never chained: a blocker is retired only by a clear that itself is within reach of it. */
function retires(clearing: Report, blocking: Report): boolean {
  return (
    clearing.receivedAt.getTime() > blocking.receivedAt.getTime() &&
    blocking.wayId !== null &&
    clearing.wayId === blocking.wayId &&
    distanceM(clearing.at, blocking.at) <= SAME_SPOT_M
  );
}

interface Judged {
  report: Report;
  role: Role;
  retiredBy: string | null;
}

interface RouteVerdict {
  route: RouteCandidate;
  state: RouteState;
  on: Judged[];
  blockers: Judged[];
}

function judgeRoute(route: RouteCandidate, live: readonly Judged[], raining: boolean): RouteVerdict {
  const on = live.filter((j) => placeOnRoute(j.report.at, route.line).offM <= ROUTE_CORRIDOR_M);
  const blockers = on.filter((j) => j.role === "block");
  if (blockers.length > 0) return { route, state: "blocked", on, blockers };
  if (on.some((j) => j.role === "neutral")) return { route, state: "unknown", on, blockers };
  if (!raining) return { route, state: "passable", on, blockers };
  const along = on.map((j) => placeOnRoute(j.report.at, route.line).alongM);
  return { route, state: covered(along, routeLengthM(route.line)) ? "passable" : "unknown", on, blockers };
}

function places(list: readonly Judged[]): string {
  const names = [...new Set(list.map((j) => j.report.place))];
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function rainWords(advisory: AdvisoryState, rainingHere: boolean): string {
  const tap = "you said it's raining here";
  if (advisory === "active") return `PAGASA's flood advisory for Cebu is active${rainingHere ? ` and ${tap}` : ""}`;
  if (advisory === "unreadable") {
    return `Lusong couldn't read PAGASA's flood advisory, so it counts one as active${rainingHere ? `, and ${tap}` : ""}`;
  }
  return tap;
}

function unknownWhy(v: RouteVerdict, which: string): string {
  const neutral = v.on.filter((j) => j.role === "neutral");
  if (neutral.length > 0) return `the report at ${places(neutral)} can't tell whether a motorbike can pass`;
  if (!v.on.some((j) => j.role === "clear")) return `nobody has reported ${which}`;
  return `the reports don't cover all of ${which}`;
}

export function decideAnswer(input: {
  plain: RouteCandidate;
  detours: readonly RouteCandidate[];
  reports: readonly Report[];
  advisory: AdvisoryState;
  rainingHere: boolean;
  now: Date;
}): Answer {
  const raining = input.advisory !== "none" || input.rainingHere;
  const judged = input.reports.map((report) => ({ report, role: roleOf(report, input.now), counts: counts(report, input.now) }));
  const clears = judged.filter((j) => j.counts && j.role === "clear").map((j) => j.report);
  const all = judged.map((j) => ({
    ...j,
    retiredBy: j.role === "block" ? (clears.find((c) => retires(c, j.report))?.id ?? null) : null,
  }));
  const live = all.filter((j) => j.counts && j.retiredBy === null);

  const plain = judgeRoute(input.plain, live, raining);
  const detours = input.detours.map((d) => judgeRoute(d, live, raining));
  const passableDetour = detours.find((d) => d.state === "passable");
  const rain = capitalise(rainWords(input.advisory, input.rainingHere));

  let answer: AnswerKind;
  let reason: string;
  let chosen = plain;
  if (plain.state === "passable") {
    answer = "go";
    if (raining) reason = `${rain}, and reports along your whole way show no flood water.`;
    else if (plain.on.length === 0) reason = "No flood advisory for Cebu, no rain tap, and nothing reported on your way.";
    else reason = "No flood advisory for Cebu, no rain tap, and the reports on your way show no flood water.";
  } else if (plain.state === "blocked" && passableDetour) {
    answer = "go_another_way";
    chosen = passableDetour;
    reason = `Your usual way is blocked at ${places(plain.blockers)}. ${
      raining ? "Reports along all of the other way show no flood water." : "Nothing is reported against the other way."
    }`;
  } else if (plain.state === "blocked" && detours.every((d) => d.state === "blocked")) {
    answer = "wait";
    reason = `Your way is blocked at ${places(plain.blockers)}, and no way around the reported spots was found.`;
  } else if (plain.state === "blocked") {
    answer = "no_one_knows";
    const unsure = detours.find((d) => d.state === "unknown")!;
    const why = unknownWhy(unsure, "the other way");
    reason = `Your usual way is blocked at ${places(plain.blockers)} and ${why}.`;
  } else {
    answer = "no_one_knows";
    const why = unknownWhy(plain, "your way");
    reason = raining && plain.on.every((j) => j.role !== "neutral") ? `${rain}, and ${why}.` : `${capitalise(why)}.`;
  }

  const decidedBy = (answer === "wait" ? plain.blockers : chosen.on).map((j) => j.report.id);
  const evidence = answer === "wait" ? plain.blockers : chosen.on;
  const thinEvidence = answer !== "no_one_knows" && (evidence.length <= 1 || evidence.every((j) => j.report.reading.source === "voice"));
  return {
    answer,
    reason,
    route: chosen.route.id,
    decidedBy,
    thinEvidence,
    routes: [plain, ...detours].map((v) => ({
      routeId: v.route.id,
      state: v.state,
      reportIds: v.on.map((j) => j.report.id),
      blockedBy: v.blockers.map((j) => j.report.id),
    })),
    reports: all.map((j) => ({ id: j.report.id, role: j.role, counts: j.counts, retiredBy: j.retiredBy })),
  };
}
