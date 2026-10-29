import { describe, expect, it } from "vitest";
import {
  COVER_GAP_M,
  decideAnswer,
  REPORT_LIFETIME_MS,
  type AdvisoryState,
  type Point,
  type Report,
  type ReportReading,
  type RouteCandidate,
} from "./answer";
import type { Verdict } from "./verdict";

const NOW = new Date("2026-10-30T07:00:00+08:00");
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;
const START: Point = { lat: 10.3, lon: 123.9 };

/** A point `north` m north and `east` m east of `from`. */
function offset(from: Point, north: number, east = 0): Point {
  return {
    lat: from.lat + north / M_PER_DEG_LAT,
    lon: from.lon + east / (M_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180)),
  };
}

/** A straight route due north from START, `lengthM` long, with a vertex every `stepM`. */
function straightRoute(id: string, lengthM: number, stepM = lengthM): RouteCandidate {
  const line: Point[] = [];
  for (let d = 0; d < lengthM; d += stepM) line.push(offset(START, d));
  line.push(offset(START, lengthM));
  return { id, line };
}

const PLAIN = straightRoute("plain", 2_500, 100);

const measured = (passability: "NPLV" | "NPATV" | "shallow" | "unsure"): Verdict => ({
  kind: "measured",
  rangeCm: passability === "NPATV" ? { low: 66, high: 112 } : passability === "NPLV" ? { low: 38, high: 54 } : { low: 5, high: 20 },
  passability,
  confidence: "medium",
  readingsComplete: true,
  decidedBy: { label: "P1", landmark: "knee", interval: { low: 38, high: 54 } },
  readingsUsed: ["P1"],
});

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let nextId = 0;
function report(reading: ReportReading, opts: { at?: Point; alongM?: number; ageMin?: number; wayId?: number | null } = {}): Report {
  const receivedAt = minutesAgo(opts.ageMin ?? 30);
  return {
    id: `r${++nextId}`,
    at: opts.at ?? offset(START, opts.alongM ?? 1_000),
    wayId: opts.wayId === undefined ? 1 : opts.wayId,
    receivedAt,
    place: `spot ${nextId}`,
    reading,
  };
}

/** A photo report; its EXIF capture time is set relative to its receipt so the 60-minute window can be tested. */
function photoReport(
  verdict: Verdict,
  opts: { alongM?: number; at?: Point; ageMin?: number; wayId?: number | null; capturedMinBeforeReceipt?: number | null } = {},
): Report {
  const r = report({ source: "photo", verdict, capturedAt: null }, opts);
  const before = opts.capturedMinBeforeReceipt === undefined ? 5 : opts.capturedMinBeforeReceipt;
  const capturedAt = before === null ? null : new Date(r.receivedAt.getTime() - before * 60_000);
  return { ...r, reading: { source: "photo", verdict, capturedAt } };
}

const blocker = (opts: Parameters<typeof photoReport>[1] = {}) => photoReport(measured("NPLV"), opts);
const clear = (opts: Parameters<typeof photoReport>[1] = {}) => photoReport({ kind: "no_flood" }, opts);

function answerFor(
  reports: Report[],
  conditions: { advisory?: AdvisoryState; rainingHere?: boolean; detours?: RouteCandidate[]; plain?: RouteCandidate } = {},
) {
  return decideAnswer({
    plain: conditions.plain ?? PLAIN,
    detours: conditions.detours ?? [],
    reports,
    advisory: conditions.advisory ?? "none",
    rainingHere: conditions.rainingHere ?? false,
    now: NOW,
  });
}

describe("rain with no reports", () => {
  it.each([
    { name: "no advisory, no rain tap", advisory: "none", rainingHere: false, expected: "go" },
    { name: "an active advisory", advisory: "active", rainingHere: false, expected: "no_one_knows" },
    { name: "an unreadable advisory, which counts as active", advisory: "unreadable", rainingHere: false, expected: "no_one_knows" },
    { name: "a 'raining here' tap", advisory: "none", rainingHere: true, expected: "no_one_knows" },
  ] as const)("$name ⇒ $expected", ({ advisory, rainingHere, expected }) => {
    expect(answerFor([], { advisory, rainingHere }).answer).toBe(expected);
  });
});


describe("what one report on the way can do, with no advisory and no rain tap", () => {
  const voice = (says: "passable" | "knee_deep_or_deeper" | "not_passable") => report({ source: "voice", says });
  const web = (sourceDate: string | null) => report({ source: "web", says: "closed", sourceDate });

  it.each([
    { name: "an NPLV photo blocks", make: () => photoReport(measured("NPLV")), expected: "wait" },
    { name: "an NPATV photo blocks", make: () => photoReport(measured("NPATV")), expected: "wait" },
    { name: "a voice report of knee-deep or deeper blocks", make: () => voice("knee_deep_or_deeper"), expected: "wait" },
    { name: "a voice report of not passable blocks", make: () => voice("not_passable"), expected: "wait" },
    { name: "a web finding of a closure dated today (PHT) blocks", make: () => web("2026-10-30"), expected: "wait" },
    { name: "a web finding dated yesterday is neutral", make: () => web("2026-10-29"), expected: "no_one_knows" },
    { name: "an undated web finding is neutral", make: () => web(null), expected: "no_one_knows" },
    { name: "a shallow photo never clears", make: () => photoReport(measured("shallow")), expected: "no_one_knows" },
    { name: "an unsure photo never clears", make: () => photoReport(measured("unsure")), expected: "no_one_knows" },
    { name: "a cannot_measure photo never clears", make: () => photoReport({ kind: "cannot_measure" }), expected: "no_one_knows" },
    { name: "a voice report of passable can't clear", make: () => voice("passable"), expected: "no_one_knows" },
    { name: "a no_flood photo taken 5 min before receipt clears", make: () => clear({ capturedMinBeforeReceipt: 5 }), expected: "go" },
    { name: "a no_flood photo taken exactly 60 min before receipt clears", make: () => clear({ capturedMinBeforeReceipt: 60 }), expected: "go" },
    { name: "a no_flood photo taken 61 min before receipt is neutral", make: () => clear({ capturedMinBeforeReceipt: 61 }), expected: "no_one_knows" },
    { name: "a no_flood photo with no capture time is neutral", make: () => clear({ capturedMinBeforeReceipt: null }), expected: "no_one_knows" },
    { name: "a no_flood photo 'taken' after receipt is neutral", make: () => clear({ capturedMinBeforeReceipt: -5 }), expected: "no_one_knows" },
  ])("$name ⇒ $expected", ({ make, expected }) => {
    expect(answerFor([make()]).answer).toBe(expected);
  });

  it("'today' is the date in Manila, not in UTC", () => {
    const justAfterMidnightPht = new Date("2026-10-30T00:30:00+08:00");
    const closure: Report = { ...web("2026-10-30"), receivedAt: new Date("2026-10-30T00:10:00+08:00") };
    const input = { plain: PLAIN, detours: [], advisory: "none" as const, rainingHere: false, now: justAfterMidnightPht };
    expect(decideAnswer({ ...input, reports: [closure] }).answer).toBe("wait");
  });
});

describe("counting: a report counts while its age is under 3 h", () => {
  it("REPORT_LIFETIME is 3 h", () => {
    expect(REPORT_LIFETIME_MS).toBe(3 * 60 * 60 * 1000);
  });

  it.each([
    { name: "a blocker 2 h 59 min old still counts", ageMin: 179, expected: "wait" },
    { name: "a blocker exactly 3 h old no longer counts", ageMin: 180, expected: "go" },
    { name: "a blocker 3 h 1 min old no longer counts", ageMin: 181, expected: "go" },
  ])("$name ⇒ $expected", ({ ageMin, expected }) => {
    expect(answerFor([blocker({ ageMin })]).answer).toBe(expected);
  });

  it("an unsure photo exactly 3 h old no longer holds back a dry Go", () => {
    expect(answerFor([photoReport(measured("unsure"), { ageMin: 180 })]).answer).toBe("go");
  });
});

describe("same spot: only a newer clearing photo within 50 m on the same road retires a blocker", () => {
  const at1000 = offset(START, 1_000);

  it.each([
    { name: "newer clear 49 m away on the same way retires it", clearAt: offset(at1000, 49), wayId: 1, expected: "go" },
    { name: "newer clear 51 m away on the same way does not", clearAt: offset(at1000, 51), wayId: 1, expected: "wait" },
    { name: "newer clear 10 m away on a different way does not", clearAt: offset(at1000, 10), wayId: 2, expected: "wait" },
    { name: "newer clear with no way id does not", clearAt: offset(at1000, 10), wayId: null, expected: "wait" },
  ])("$name", ({ clearAt, wayId, expected }) => {
    const reports = [blocker({ at: at1000, ageMin: 60 }), clear({ at: clearAt, wayId, ageMin: 10 })];
    expect(answerFor(reports).answer).toBe(expected);
  });

  it("a blocker with no way id is never retired", () => {
    const reports = [blocker({ at: at1000, ageMin: 60, wayId: null }), clear({ at: at1000, wayId: 1, ageMin: 10 })];
    expect(answerFor(reports).answer).toBe("wait");
  });

  it("a clear and a blocker that both lack a way id are not the same road", () => {
    const reports = [blocker({ at: at1000, ageMin: 60, wayId: null }), clear({ at: at1000, wayId: null, ageMin: 10 })];
    expect(answerFor(reports).answer).toBe("wait");
  });

  it("an older clear does not retire a newer blocker", () => {
    expect(answerFor([clear({ at: at1000, ageMin: 60 }), blocker({ at: at1000, ageMin: 10 })]).answer).toBe("wait");
  });

  it("equal timestamps: the block wins", () => {
    expect(answerFor([blocker({ at: at1000, ageMin: 20 }), clear({ at: at1000, ageMin: 20 })]).answer).toBe("wait");
  });

  it("NPLV photo then a newer voice 'passable' ⇒ still blocked", () => {
    const reports = [blocker({ at: at1000, ageMin: 60 }), report({ source: "voice", says: "passable" }, { at: at1000, ageMin: 5 })];
    expect(answerFor(reports).answer).toBe("wait");
  });

  it("NPLV photo then a newer unsure photo ⇒ still blocked", () => {
    const reports = [blocker({ at: at1000, ageMin: 60 }), photoReport(measured("unsure"), { at: at1000, ageMin: 5 })];
    expect(answerFor(reports).answer).toBe("wait");
  });

  it("a clear 40 m away on a parallel road does not retire a blocker on the route", () => {
    const parallel = offset(at1000, 0, 40);
    const reports = [blocker({ at: at1000, ageMin: 60, wayId: 1 }), clear({ at: parallel, ageMin: 5, wayId: 2 })];
    expect(answerFor(reports).answer).toBe("wait");
  });

  it("chained neighbours A–B–C: a clear at C retires B, 40 m away, but not A, 80 m away", () => {
    const a = blocker({ at: at1000, ageMin: 90 });
    const b = blocker({ at: offset(at1000, 40), ageMin: 60 });
    const c = clear({ at: offset(at1000, 80), ageMin: 5 });
    const result = answerFor([a, b, c]);
    expect(result.answer).toBe("wait");
    expect(result.decidedBy).toEqual([a.id]);
  });

  it("the answer and its deciding reports don't depend on input order", () => {
    const reports = [
      blocker({ at: at1000, ageMin: 90 }),
      clear({ at: offset(at1000, 30), ageMin: 30 }),
      blocker({ at: offset(at1000, 60), ageMin: 20 }),
      photoReport(measured("unsure"), { at: offset(at1000, 500), ageMin: 15 }),
      clear({ at: offset(at1000, 90), ageMin: 10 }),
    ];
    const expected = answerFor(reports);
    // Both blockers are retired by a newer clear within 30 m; the unsure photo still holds back Go.
    expect(expected.answer).toBe("no_one_knows");
    for (const order of permutations(reports)) {
      const got = answerFor(order);
      expect([got.answer, [...got.decidedBy].sort()]).toEqual([expected.answer, [...expected.decidedBy].sort()]);
    }
  });
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("on a route: within 30 m of the route line, measured to the nearest segment", () => {
  const oneSegment = straightRoute("plain", 2_500);
  const midway = offset(START, 1_250);

  it.each([
    { name: "a blocker 29 m from the middle of a 2.5 km segment is on it", eastM: 29, expected: "wait" },
    { name: "a blocker 31 m from it is not", eastM: 31, expected: "go" },
    { name: "a blocker 200 m away is not", eastM: 200, expected: "go" },
  ])("$name", ({ eastM, expected }) => {
    expect(answerFor([blocker({ at: offset(midway, 0, eastM) })], { plain: oneSegment }).answer).toBe(expected);
  });

  it("a report beyond the route's end is measured to the end point, not the line's extension", () => {
    const pastTheEnd = offset(START, 2_540);
    expect(answerFor([blocker({ at: pastTheEnd })], { plain: oneSegment }).answer).toBe("go");
  });

  it("an unsure photo off the route doesn't hold back a dry Go", () => {
    expect(answerFor([photoReport(measured("unsure"), { at: offset(midway, 0, 100) })]).answer).toBe("go");
  });
});

describe("under rain, Go needs every point of the route within 500 m (along it) of a counting clear", () => {
  const clearsAt = (...alongs: number[]) => alongs.map((alongM) => clear({ alongM }));

  it("COVER_GAP_M is 500 m", () => {
    expect(COVER_GAP_M).toBe(500);
  });

  it.each([
    { name: "one clear at the start of a 2.5 km route", alongs: [0], expected: "no_one_knows" },
    { name: "clears at 400, 1399 and 2398 m cover it", alongs: [400, 1_399, 2_398], expected: "go" },
    { name: "the same, given in reverse order", alongs: [2_398, 1_399, 400], expected: "go" },
    { name: "a 1001 m gap between clears leaves a point 500.5 m from both", alongs: [400, 1_401, 2_400], expected: "no_one_knows" },
    { name: "the first clear 501 m from the start", alongs: [501, 1_400, 2_400], expected: "no_one_knows" },
    { name: "the last clear 501 m before the end", alongs: [400, 1_000, 1_999], expected: "no_one_knows" },
    { name: "clears only at both ends", alongs: [0, 2_500], expected: "no_one_knows" },
  ])("$name ⇒ $expected", ({ alongs, expected }) => {
    expect(answerFor(clearsAt(...alongs), { advisory: "active" }).answer).toBe(expected);
  });

  it("a covered route with a neutral report on it is not Go", () => {
    const reports = [...clearsAt(400, 1_399, 2_398), photoReport(measured("shallow"), { alongM: 900 })];
    expect(answerFor(reports, { rainingHere: true }).answer).toBe("no_one_knows");
  });

  it("a clear exactly 3 h old doesn't count toward cover", () => {
    const reports = [clear({ alongM: 400 }), clear({ alongM: 1_399, ageMin: 180 }), clear({ alongM: 2_398 })];
    expect(answerFor(reports, { advisory: "unreadable" }).answer).toBe("no_one_knows");
  });

  it("with no advisory and no rain tap, a partly reported route is still Go", () => {
    expect(answerFor(clearsAt(0)).answer).toBe("go");
  });
});

describe("each route is judged the same way; the answer comes from the plain route and its detours", () => {
  const detourEast = (id: string, eastM: number): RouteCandidate => ({
    id,
    line: [START, offset(START, 0, eastM), offset(START, 2_500, eastM), offset(START, 2_500)],
  });
  const onDetour = (eastM: number) => offset(START, 1_250, eastM);

  it("plain blocked and no detour found ⇒ Wait, saying no way around was found", () => {
    const result = answerFor([blocker()]);
    expect(result.answer).toBe("wait");
    expect(result.reason).toContain("no way around the reported spots was found");
  });

  it("plain blocked and an unreported detour, no rain ⇒ Go another way, on the detour", () => {
    const result = answerFor([blocker()], { detours: [detourEast("d1", 300)] });
    expect([result.answer, result.route]).toEqual(["go_another_way", "d1"]);
  });

  it("plain blocked and every detour blocked ⇒ Wait", () => {
    const reports = [blocker(), blocker({ at: onDetour(300), wayId: 7 })];
    expect(answerFor(reports, { detours: [detourEast("d1", 300)] }).answer).toBe("wait");
  });

  it("rain + plain blocked + a detour with no clear reports ⇒ No one knows, naming the blocked spot", () => {
    const block = blocker();
    const result = answerFor([block], { detours: [detourEast("d1", 300)], rainingHere: true });
    expect(result.answer).toBe("no_one_knows");
    expect(result.reason).toContain(block.place);
    expect(result.reason).toContain("nobody has reported the other way");
  });

  it("plain blocked, one detour blocked and one clear ⇒ Go another way on the clear one", () => {
    const reports = [blocker(), blocker({ at: onDetour(300), wayId: 7 })];
    const result = answerFor(reports, { detours: [detourEast("d1", 300), detourEast("d2", 600)] });
    expect([result.answer, result.route]).toEqual(["go_another_way", "d2"]);
  });

  it("plain blocked, one detour blocked and one unknown ⇒ No one knows", () => {
    const reports = [blocker(), blocker({ at: onDetour(300), wayId: 7 }), photoReport(measured("unsure"), { at: onDetour(600), wayId: 8 })];
    expect(answerFor(reports, { detours: [detourEast("d1", 300), detourEast("d2", 600)] }).answer).toBe("no_one_knows");
  });

  it("plain unknown is No one knows even when a detour is passable", () => {
    const reports = [photoReport(measured("unsure"))];
    expect(answerFor(reports, { detours: [detourEast("d1", 300)] }).answer).toBe("no_one_knows");
  });

  it("a detour under rain is Go another way only with its own clear cover", () => {
    // The detour is 300 + 2500 + 300 m long; these sit 500, 1499, 2498 and 2800 m along it.
    const cover = [200, 1_199, 2_198, 2_500].map((n) => clear({ at: offset(START, n, 300), wayId: 9 }));
    const result = answerFor([blocker(), ...cover], { detours: [detourEast("d1", 300)], advisory: "active" });
    expect([result.answer, result.route]).toEqual(["go_another_way", "d1"]);
  });
});

describe("the reason and the thin-evidence note", () => {
  it("rain with no reports says why in plain words", () => {
    expect(answerFor([], { advisory: "active" }).reason).toBe(
      "PAGASA's flood advisory for Cebu is active, and nobody has reported your way.",
    );
    expect(answerFor([], { advisory: "unreadable" }).reason).toContain("couldn't read PAGASA's flood advisory");
    expect(answerFor([], { rainingHere: true }).reason).toBe("You said it's raining here, and nobody has reported your way.");
  });

  it("a neutral report names its spot", () => {
    const unsure = photoReport(measured("unsure"));
    expect(answerFor([unsure]).reason).toBe(`The report at ${unsure.place} can't tell whether a motorbike can pass.`);
  });

  it.each([
    { name: "Go on one clear report is thin", reports: () => [clear({ alongM: 100 })], thin: true },
    { name: "Go on nothing reported is thin", reports: () => [], thin: true },
    { name: "Go on three clear reports is not", reports: () => [100, 900, 1_700].map((alongM) => clear({ alongM })), thin: false },
    {
      name: "Wait on two voice reports only is thin",
      reports: () => [0, 1_000].map((alongM) => report({ source: "voice", says: "not_passable" }, { alongM })),
      thin: true,
    },
    { name: "Wait on two photo blockers is not", reports: () => [blocker({ alongM: 0 }), blocker({ alongM: 1_000 })], thin: false },
  ])("$name", ({ reports, thin }) => {
    expect(answerFor(reports()).thinEvidence).toBe(thin);
  });
});
