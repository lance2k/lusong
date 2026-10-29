import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_URL } from "./advisory";
import { createBudget, MemoryBudgetStore, type Budget, type BudgetStore } from "./budget";
import {
  ADVISORY_CACHE_MS,
  COMMUTE_DEADLINE_MS,
  COMMUTE_RESERVE_MICROS,
  COMMUTE_TIMING,
  makeCommuteCheck,
  makeCommuteHandler,
  MUSE_OFF,
  ROUTE_CACHE_MS,
  SETTLE_ROOM_MS,
  UNREADABLE_RETRY_MS,
  type CommuteTiming,
  type MuseDeps,
} from "./commute-handler";
import { investigationReserveMicros, PICK_UNAVAILABLE } from "./investigation";
import { sampleReports, scenariosFor, type DemoTripId } from "./samples";
import { MemoryKvStore, planWebSearch, SEARCH_RESERVE_MICROS, WEB_SEARCH_LEASE_KEY, type KvStore } from "./web-search";
import { callsReply, fakeMeta, hangs, searchReply, textReply } from "../test/muse-derived";
import { cutEnd, cutStart, derivedReply } from "../test/valhalla-derived";
import { CAP_EDITS, CV_GFA5, FEED, feedWith, SAVED } from "../test/pagasa-fixtures";
import { decodePolyline6, makeValhallaGate, MemorySlotStore, VALHALLA_URL, type SlotStore } from "./router";
import { distanceM, placeOnRoute, ROUTE_CORRIDOR_M, type Point } from "./answer";
import { MemoryReportStore, UpstashReportStore, type ReportStore, type StoredPhotoReport, type StoredVoiceReport } from "./report-store";
import { seedReport } from "../test/seed-report";
import { randomUUID } from "node:crypto";

const read = (path: string) => readFileSync(path, "utf8");
const ROUTES: Record<string, string> = {
  "10.346,123.911": read("test/fixtures/valhalla/banilad-itpark-plain.json"),
  "10.3143,123.9147": read("test/fixtures/valhalla/mabolo-cbp-plain.json"),
};
/** Valhalla's saved replies with blocked spots excluded (2026-10-30 01:16 and 02:24 PHT), each beside the request it answered. */
const recorded = (name: string, status: number) => ({
  request: JSON.parse(read(`test/fixtures/valhalla/${name}.request.json`)),
  reply: read(`test/fixtures/valhalla/${name}.json`),
  status,
});
const DETOUR_RECORDS = [
  recorded("banilad-itpark-excluded", 200),
  recorded("mabolo-cbp-excluded", 200),
  /** IT Park itself excluded: Valhalla's real "No path could be found". */
  recorded("banilad-itpark-destination-excluded", 400),
];
const NO_ROUTE = DETOUR_RECORDS[2].reply;
const EXCLUDED_REQUEST = DETOUR_RECORDS[0].request;

const near = (a: number[][][], b: number[][][]) =>
  a.length === b.length &&
  a.every((ring, i) => ring.length === b[i].length && ring.every(([x, y], k) => Math.abs(x - b[i][k][0]) < 1e-9 && Math.abs(y - b[i][k][1]) < 1e-9));

/** The saved reply to exactly this request (same trip, same boxes), or none. */
function detourRecordFor(sent: { locations: unknown; exclude_polygons: number[][][] }) {
  return DETOUR_RECORDS.find(
    (r) => JSON.stringify(r.request.locations) === JSON.stringify(sent.locations) && near(r.request.exclude_polygons, sent.exclude_polygons),
  );
}

/** 20:00 PHT on 2026-10-25: the Central Visayas advisory sent at 17:27 is active. */
const ADVISORY_ACTIVE = new Date("2026-10-25T20:00:00+08:00");
/** Noon on 2026-10-29: no GFA entry in the feed's last 24 h, so no advisory. */
const NO_ADVISORY = new Date("2026-10-29T12:00:00+08:00");

type Options = {
  valhalla?: "ok" | "down";
  /** How Valhalla answers a request with spots excluded: its recorded detour, no route, the plain route again, or down. */
  detour?: "ok" | "no_route" | "plain" | "down";
  feed?: "ok" | "down";
  pagasa?: Record<string, string>;
  /** A reply to send instead of the saved plain route or the saved detour (derived fixtures). */
  plainReply?: string;
  detourReply?: string;
  /** A reply to one detour request in particular; undefined leaves it to the options above. */
  detourReplyFor?: (sent: { exclude_polygons: number[][][] }) => string | undefined;
  /** Hold the plain route's reply this long; a detour that "hangs" answers only when its own timeout aborts it. */
  plainDelayMs?: number;
  detourHangs?: boolean;
  /** The plain route never answers until its own timeout aborts it. */
  plainHangs?: boolean;
  /** Valhalla answers only after this long. */
  valhallaDelayMs?: number;
};

/** PAGASA and Valhalla faked at fetch with their saved records; any CAP link not saved fails as a dropped connection. */
function network(opts: Options = {}) {
  const calls: { url: string; at: number; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, at: performance.now(), body: init?.body ? String(init.body) : undefined });
    if (u === FEED_URL && opts.feed === "down") throw new TypeError("fetch failed");
    const pagasa = opts.pagasa ?? { [FEED_URL]: FEED, ...SAVED };
    if (u in pagasa) return new Response(pagasa[u]);
    if (u === `${VALHALLA_URL}/route`) {
      if (opts.valhallaDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.valhallaDelayMs));
      if (opts.valhalla === "down") throw new TypeError("fetch failed");
      const sent = JSON.parse(String(init!.body));
      const from = `${sent.locations[0].lat},${sent.locations[0].lon}`;
      if (!sent.exclude_polygons && opts.plainHangs) {
        const signal = init!.signal!;
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      if (!sent.exclude_polygons) {
        if (opts.plainDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.plainDelayMs));
        return new Response(opts.plainReply ?? ROUTES[from], { status: 200 });
      }
      if (opts.detourHangs) {
        const signal = init!.signal!;
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      if (opts.detour === "down") throw new TypeError("fetch failed");
      const particular = opts.detourReplyFor?.(sent);
      if (particular) return new Response(particular, { status: 200 });
      if (opts.detourReply) return new Response(opts.detourReply, { status: 200 });
      if (opts.detour === "no_route") return new Response(NO_ROUTE, { status: 400 });
      if (opts.detour === "plain") return new Response(ROUTES[from], { status: 200 });
      const saved = detourRecordFor(sent);
      if (!saved) throw new TypeError("fetch failed: no saved Valhalla reply for this request");
      return new Response(saved.reply, { status: saved.status });
    }
    throw new TypeError("fetch failed");
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls, valhallaCalls: () => calls.filter((c) => c.url.startsWith(VALHALLA_URL)) };
}

const openBudget = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 100 });

function handlerAt(
  now: Date,
  opts: Options = {},
  store: SlotStore = new MemorySlotStore(),
  budget: Budget = openBudget(),
  reports: ReportStore | null = new MemoryReportStore(),
  muse: MuseDeps = MUSE_OFF,
  timing?: Partial<CommuteTiming>,
) {
  const net = network(opts);
  const gate = makeValhallaGate(store);
  const { POST: handler, checkTrip } = makeCommuteCheck({
    fetch: net.fetch,
    now: () => now,
    gate: () => gate,
    budget: () => budget,
    reports: () => reports,
    muse,
    timing: timing && { ...COMMUTE_TIMING, ...timing },
  });
  return { handler, checkTrip, ...net };
}

function check(body: object): Request {
  return new Request("http://localhost/api/commute", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
  });
}

const demo = (trip: string, scenario: string, rainingHere = false) => check({ mode: "demo", trip, scenario, rainingHere });

describe("the demo commute check", () => {
  it.each([
    { trip: "banilad-itpark", scenario: "none", now: NO_ADVISORY, rain: false, answer: "go" },
    { trip: "banilad-itpark", scenario: "none", now: NO_ADVISORY, rain: true, answer: "no_one_knows" },
    { trip: "banilad-itpark", scenario: "none", now: ADVISORY_ACTIVE, rain: false, answer: "no_one_knows" },
    { trip: "banilad-itpark", scenario: "flooded", now: NO_ADVISORY, rain: false, answer: "go_another_way" },
    { trip: "banilad-itpark", scenario: "flooded", now: NO_ADVISORY, rain: true, answer: "no_one_knows" },
    { trip: "banilad-itpark", scenario: "flooded", now: ADVISORY_ACTIVE, rain: false, answer: "no_one_knows" },
    { trip: "banilad-itpark", scenario: "unclear", now: NO_ADVISORY, rain: false, answer: "no_one_knows" },
    { trip: "banilad-itpark", scenario: "no_way_around", now: NO_ADVISORY, rain: false, answer: "wait" },
    { trip: "banilad-itpark", scenario: "no_way_around", now: ADVISORY_ACTIVE, rain: true, answer: "wait" },
    { trip: "mabolo-cbp", scenario: "none", now: NO_ADVISORY, rain: false, answer: "go" },
    { trip: "mabolo-cbp", scenario: "none", now: NO_ADVISORY, rain: true, answer: "no_one_knows" },
    { trip: "mabolo-cbp", scenario: "flooded", now: NO_ADVISORY, rain: false, answer: "go_another_way" },
    { trip: "mabolo-cbp", scenario: "flooded", now: ADVISORY_ACTIVE, rain: true, answer: "no_one_knows" },
    { trip: "mabolo-cbp", scenario: "unclear", now: NO_ADVISORY, rain: false, answer: "no_one_knows" },
  ])("$trip, $scenario, rain tap $rain, at $now ⇒ $answer", async ({ trip, scenario, now, rain, answer }) => {
    const { handler } = handlerAt(now);
    const res = await handler(demo(trip, scenario, rain));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer.kind).toBe(answer);
    expect(body.demo).toBe(true);
  });

  it("shows the advisory's forecast, rivers and times, the route's length and time, and the MMDA credit", async () => {
    const { handler } = handlerAt(ADVISORY_ACTIVE);
    const body = await (await handler(demo("banilad-itpark", "none"))).json();
    expect(body.advisory).toMatchObject({
      state: "active",
      rainForecast: "light to moderate rains and thunderstorms",
      rivers: "Kotkot, Mananga, Guinabasan, Balamban and Sabangdaku",
      sent: "25 Oct, 5:27 p.m. PHT",
      expires: "26 Oct, 5:27 a.m. PHT",
    });
    expect(body.route).toMatchObject({ lengthKm: 2.552, timeMin: 11 });
    expect(body.answer.reason).toBe("PAGASA's flood advisory for Cebu is active, and nobody has reported your way.");
    expect(body.mmdaCredit).toContain("MMDA");
  });

  it("each report shows its age, its reading in body-part words, and its real origin as a sample", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const body = await (await handler(demo("mabolo-cbp", "flooded"))).json();
    expect(body.reports).toEqual([
      expect.objectContaining({
        sample: true,
        place: "M.J. Cuenco Avenue at H. Joaquino Street, Mabolo",
        age: "1 h 10 min ago",
        depth: "ankle- to thigh-deep (5–72 cm)",
        passability: "Not passable to any vehicle (MMDA gauge, Metro Manila)",
        origin: "Quiapo, City of Manila, during the Habagat and Typhoon Carina (Gaemi) floods of July 2024",
        counts: true,
        onRoute: true,
      }),
      expect.objectContaining({ place: "Leyte Loop, Cebu Business Park", age: "3 h 20 min ago", counts: false }),
    ]);
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.answer.reason).toContain("M.J. Cuenco Avenue at H. Joaquino Street, Mabolo");
  });

  it("an unreadable advisory feed is said so on the page and counts as active", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { feed: "down" });
    const body = await (await handler(demo("banilad-itpark", "none"))).json();
    expect(body.advisory.state).toBe("unreadable");
    expect(body.advisory.note).toBe("Lusong couldn't read PAGASA's flood advisory feed, so it counts an advisory as active.");
    expect(body.answer.kind).toBe("no_one_knows");
  });

  it.each(CAP_EDITS.map((e) => [e.name, e.edit] as const))(
    "the active Cebu record with %s gives no Go, dry and with nothing reported (🔴2)",
    async (_name, edit) => {
      const onlyCebu = feedWith((t) => t === "GFA #5 - Region 7 (Central Visayas)");
      const control = handlerAt(ADVISORY_ACTIVE, { pagasa: { [FEED_URL]: onlyCebu, [CV_GFA5]: SAVED[CV_GFA5] } });
      expect((await (await control.handler(demo("banilad-itpark", "none"))).json()).answer.kind).toBe("no_one_knows");
      const { handler } = handlerAt(ADVISORY_ACTIVE, { pagasa: { [FEED_URL]: onlyCebu, [CV_GFA5]: edit(SAVED[CV_GFA5]) } });
      const body = await (await handler(demo("banilad-itpark", "none"))).json();
      expect(body.advisory.state).toBe("unreadable");
      expect(body.answer.kind).not.toBe("go");
    },
  );

  it("the active Cebu record with its areaDesc changed to 'Unknown' (geocode and polygon kept) is still active: no dry Go (🔴2)", async () => {
    const onlyCebu = feedWith((t) => t === "GFA #5 - Region 7 (Central Visayas)");
    const derived = SAVED[CV_GFA5].replace("<areaDesc>Cebu</areaDesc>", "<areaDesc>Unknown</areaDesc>");
    expect(derived).not.toBe(SAVED[CV_GFA5]);
    const { handler } = handlerAt(ADVISORY_ACTIVE, { pagasa: { [FEED_URL]: onlyCebu, [CV_GFA5]: derived } });
    const body = await (await handler(demo("banilad-itpark", "none"))).json();
    expect(body.advisory.state).toBe("active");
    expect(body.answer.kind).toBe("no_one_knows");
  });

  it("an unreachable routing server is said so, with no answer", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { valhalla: "down" });
    const res = await handler(demo("banilad-itpark", "none"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.answer).toBeUndefined();
    expect(body.error).toBe("Lusong couldn't reach the routing server, so it can't give an answer. Try again in a minute.");
  });

  it("a routing gate with no store makes no request and gives no answer", async () => {
    const net = network();
    const handler = makeCommuteHandler({ fetch: net.fetch, now: () => NO_ADVISORY, gate: () => makeValhallaGate(null), budget: openBudget });
    const res = await handler(demo("banilad-itpark", "none"));
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
    expect(net.valhallaCalls()).toHaveLength(0);
  });

  it("two handler instances on one store: their Valhalla requests start at least 1 s apart (🔴P7)", async () => {
    const store = new MemorySlotStore();
    const a = handlerAt(NO_ADVISORY, {}, store);
    const b = handlerAt(NO_ADVISORY, {}, store);
    const [ra, rb] = await Promise.all([a.handler(demo("banilad-itpark", "none")), b.handler(demo("mabolo-cbp", "none"))]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const starts = [...a.valhallaCalls(), ...b.valhallaCalls()].map((c) => c.at).sort((x, y) => x - y);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1_000);
  }, 10_000);

  it("reuses a demo trip's route for 10 minutes instead of asking Valhalla again", async () => {
    let now = NO_ADVISORY;
    const net = network();
    const gate = makeValhallaGate(new MemorySlotStore());
    const handler = makeCommuteHandler({ fetch: net.fetch, now: () => now, gate: () => gate, budget: openBudget });
    await handler(demo("banilad-itpark", "none"));
    await handler(demo("banilad-itpark", "unclear"));
    expect(net.valhallaCalls()).toHaveLength(1);
    expect(ROUTE_CACHE_MS).toBe(10 * 60_000);
    now = new Date(NO_ADVISORY.getTime() + ROUTE_CACHE_MS);
    await handler(demo("banilad-itpark", "none"));
    expect(net.valhallaCalls()).toHaveLength(2);
  });

  it("reuses a readable PAGASA reading for 5 minutes", async () => {
    let now = NO_ADVISORY;
    const net = network();
    const gate = makeValhallaGate(new MemorySlotStore());
    const handler = makeCommuteHandler({ fetch: net.fetch, now: () => now, gate: () => gate, budget: openBudget });
    const feedCalls = () => net.calls.filter((c) => c.url === FEED_URL).length;
    await handler(demo("banilad-itpark", "none"));
    await handler(demo("mabolo-cbp", "none"));
    expect(feedCalls()).toBe(1);
    now = new Date(NO_ADVISORY.getTime() + ADVISORY_CACHE_MS);
    await handler(demo("banilad-itpark", "none"));
    expect(feedCalls()).toBe(2);
  }, 10_000);

  it("while PAGASA is down, demo clicks ask it again only once a minute", async () => {
    let now = NO_ADVISORY;
    const down = network({ feed: "down" });
    const gate = makeValhallaGate(new MemorySlotStore());
    const handler = makeCommuteHandler({ fetch: down.fetch, now: () => now, gate: () => gate, budget: openBudget });
    const feedCalls = () => down.calls.filter((c) => c.url === FEED_URL).length;
    for (const scenario of ["none", "flooded", "unclear", "none"]) {
      expect((await (await handler(demo("banilad-itpark", scenario))).json()).advisory.state).toBe("unreadable");
    }
    expect(feedCalls()).toBe(1);
    now = new Date(NO_ADVISORY.getTime() + UNREADABLE_RETRY_MS);
    await handler(demo("banilad-itpark", "none"));
    expect(feedCalls()).toBe(2);
    expect(UNREADABLE_RETRY_MS).toBe(60_000);
  });

  it("clicking through every demo choice asks Valhalla once per trip, once per detour, and PAGASA's feed once", async () => {
    const { handler, calls, valhallaCalls } = handlerAt(NO_ADVISORY);
    for (const trip of ["banilad-itpark", "mabolo-cbp"] as DemoTripId[]) {
      for (const { id } of scenariosFor(trip)) {
        for (const rain of [false, true]) expect((await handler(demo(trip, id, rain))).status).toBe(200);
      }
    }
    expect(valhallaCalls().filter((c) => !JSON.parse(c.body!).exclude_polygons)).toHaveLength(2);
    // Banilad flooded, Banilad with no way around (its "no route" is kept too), Mabolo flooded.
    expect(valhallaCalls().filter((c) => JSON.parse(c.body!).exclude_polygons)).toHaveLength(3);
    expect(calls.filter((c) => c.url === FEED_URL)).toHaveLength(1);
  }, 10_000);

  it("a commute check goes through the daily admission, reserving a small positive amount from the client's address", async () => {
    const admits: unknown[] = [];
    const settles: boolean[] = [];
    const inner = openBudget();
    const watched: Budget = {
      admit: (ip, at, reserve) => {
        admits.push([ip, at.toISOString(), reserve]);
        return inner.admit(ip, at, reserve);
      },
      settle: (a, usage, succeeded) => {
        settles.push(succeeded);
        return inner.settle(a, usage, succeeded);
      },
    };
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), watched);
    expect((await handler(demo("banilad-itpark", "none"))).status).toBe(200);
    expect(Number.isSafeInteger(COMMUTE_RESERVE_MICROS) && COMMUTE_RESERVE_MICROS > 0).toBe(true);
    expect(admits).toEqual([["192.0.2.1", NO_ADVISORY.toISOString(), COMMUTE_RESERVE_MICROS]]);
    expect(settles).toEqual([true]);
  });

  it("a refused commute check returns the admission's response and asks neither PAGASA nor Valhalla", async () => {
    const tight = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 1 });
    const { handler, calls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), tight);
    expect((await handler(demo("banilad-itpark", "none"))).status).toBe(200);
    const before = calls.length;
    const refused = await handler(demo("banilad-itpark", "none"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "You've used today's checks. They start again at 8:00 a.m. Philippine time.",
      reason: "ip",
    });
    expect(calls.length).toBe(before);
  });

  it("an unanswered check settles as failed", async () => {
    const settles: boolean[] = [];
    const inner = openBudget();
    const watched: Budget = { admit: inner.admit, settle: (a, u, ok) => (settles.push(ok), inner.settle(a, u, ok)) };
    const { handler } = handlerAt(NO_ADVISORY, { valhalla: "down" }, new MemorySlotStore(), watched);
    expect((await handler(demo("banilad-itpark", "none"))).status).toBe(503);
    expect(settles).toEqual([false]);
  });

  it("a malformed check is refused before any request", async () => {
    const { handler, calls } = handlerAt(NO_ADVISORY);
    for (const body of [
      { mode: "real", trip: "banilad-itpark", scenario: "flooded" },
      { trip: "banilad-itpark", scenario: "flooded" },
      { mode: "demo", trip: "lahug-anywhere", scenario: "none" },
      { mode: "demo", trip: "banilad-itpark", scenario: "everything" },
      { mode: "demo", trip: "banilad-itpark", scenario: "none", rainingHere: "yes" },
    ]) {
      const res = await handler(check(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await handler(new Request("http://localhost/api/commute", { method: "POST", body: "{" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("never says 'passable to all types of vehicles' or PATV, in any demo answer", async () => {
    for (const now of [NO_ADVISORY, ADVISORY_ACTIVE]) {
      const { handler } = handlerAt(now);
      for (const trip of ["banilad-itpark", "mabolo-cbp"] as DemoTripId[]) {
        for (const { id: scenario } of scenariosFor(trip)) {
          for (const rain of [false, true]) {
            const text = await handler(demo(trip, scenario, rain)).then((r) => r.text());
            expect(text.toLowerCase()).not.toContain("passable to all types of vehicles");
            expect(text).not.toMatch(/\bPATV\b/);
          }
        }
      }
    }
  }, 20_000);
});

describe("go another way", () => {
  it("Banilad → IT Park with a flooded spot reported on Governor M. Cuenco Avenue ⇒ Go another way, with the detour's length and time", async () => {
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY);
    const res = await handler(demo("banilad-itpark", "flooded"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.answer.title).toBe("Go another way");
    expect(body.answer.reason).toContain("Governor M. Cuenco Avenue");
    expect(body.route).toMatchObject({ lengthKm: 2.552, timeMin: 11 });
    expect(body.detour).toMatchObject({ lengthKm: 3.293, timeMin: 15, extraKm: 0.7, extraMin: 4 });
    expect(body.detour.streets).toContain("Camp Lapu-Lapu Road");
    expect(body.detour.streets).not.toContain("Jose Maria Del Mar Avenue");
    expect(body.answer.thin).toBe("Nobody has reported the other way. This answer rests on no advisory and no rain tap.");

    const [, second] = valhallaCalls();
    const sent = JSON.parse(second.body!);
    expect(sent.locations).toEqual(EXCLUDED_REQUEST.locations);
    expect(sent.costing).toBe("motorcycle");
    expect(sent.exclude_polygons).toHaveLength(1);
    sent.exclude_polygons[0].forEach(([lon, lat]: number[], i: number) => {
      expect(lon).toBeCloseTo(EXCLUDED_REQUEST.exclude_polygons[0][i][0], 9);
      expect(lat).toBeCloseTo(EXCLUDED_REQUEST.exclude_polygons[0][i][1], 9);
    });
  });

  it("no route avoids every blocked spot ⇒ Wait, saying no way around the reported spots was found", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { detour: "no_route" });
    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();
    expect(body.answer.kind).toBe("wait");
    expect(body.answer.reason).toBe(
      "Your way is blocked at Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue, and no way around the reported spots was found.",
    );
    expect(body.detour).toBeNull();
  });

  it("rain + plain blocked + a detour nobody has reported ⇒ No one knows, naming the blocked spot (🔴P2)", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const body = await (await handler(demo("banilad-itpark", "flooded", true))).json();
    expect(body.answer.kind).toBe("no_one_knows");
    expect(body.answer.reason).toBe(
      "Your usual way is blocked at Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue and nobody has reported the other way.",
    );
    expect(body.detour).toMatchObject({ state: "unknown", lengthKm: 3.293 });
  });

  it("a reply that still runs through the blocked spot is no way around it ⇒ Wait, not Go another way", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { detour: "plain" });
    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();
    expect(body.answer.kind).toBe("wait");
    expect(body.detour).toBeNull();
  });

  it("the detour request goes through the same 1-a-second gate: two requests, two grants, at least 1 s apart", async () => {
    const store = new MemorySlotStore();
    const inner = makeValhallaGate(store);
    let grants = 0;
    const counted = { acquire: async () => ((await inner.acquire()) === "ok" ? (grants++, "ok" as const) : "busy" as const) };
    const net = network();
    const handler = makeCommuteHandler({ fetch: net.fetch, now: () => NO_ADVISORY, gate: () => counted, budget: openBudget });
    expect((await handler(demo("banilad-itpark", "flooded"))).status).toBe(200);
    const [first, second] = net.valhallaCalls();
    expect(grants).toBe(2);
    expect(second.at - first.at).toBeGreaterThanOrEqual(1_000);
  }, 10_000);

  it("when the gate refuses the detour request, nothing is sent and there is no answer", async () => {
    const inner = makeValhallaGate(new MemorySlotStore());
    let asked = 0;
    const firstOnly = { acquire: async () => (++asked === 1 ? inner.acquire() : ("busy" as const)) };
    const net = network();
    const handler = makeCommuteHandler({ fetch: net.fetch, now: () => NO_ADVISORY, gate: () => firstOnly, budget: openBudget });
    const res = await handler(demo("banilad-itpark", "flooded"));
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
    expect(net.valhallaCalls()).toHaveLength(1);
  });

  it("an unreachable routing server on the detour request gives no answer, not Wait", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { detour: "down" });
    const res = await handler(demo("banilad-itpark", "flooded"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.answer).toBeUndefined();
    expect(body.routing).toBe("unreachable");
  }, 10_000);

  it("Mabolo → Cebu Business Park around the flooded M.J. Cuenco corner ⇒ Go another way by Pope John Paul II Avenue", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const body = await (await handler(demo("mabolo-cbp", "flooded"))).json();
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.detour).toMatchObject({ lengthKm: 1.909, timeMin: 7 });
    expect(body.detour.streets[0]).toBe("Pope John Paul Ⅱ Avenue");
  });

  it("Banilad → IT Park with a flooded spot at IT Park itself ⇒ Wait: Valhalla found no way around it (real 442 record)", async () => {
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY);
    const body = await (await handler(demo("banilad-itpark", "no_way_around"))).json();
    expect(body.answer.kind).toBe("wait");
    expect(body.answer.title).toBe("Wait. Check again in 30 minutes.");
    expect(body.answer.reason).toBe("Your way is blocked at V. Padriga Street at IT Park, and no way around the reported spots was found.");
    expect(body.detour).toBeNull();
    expect(body.reports).toEqual([expect.objectContaining({ sample: true, onRoute: true, role: "block", counts: true })]);
    const sent = JSON.parse(valhallaCalls()[1].body!);
    expect(detourRecordFor(sent)?.status).toBe(400);
  });

  it("the no-way-around scenario is offered on Banilad → IT Park only: elsewhere it is refused before any request", async () => {
    const { handler, calls } = handlerAt(NO_ADVISORY);
    expect((await handler(demo("mabolo-cbp", "no_way_around"))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("on a dry day, with no rain tap, the demo reaches every answer (spec story 36)", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const reached = new Set<string>();
    for (const trip of ["banilad-itpark", "mabolo-cbp"] as DemoTripId[]) {
      for (const { id } of scenariosFor(trip)) reached.add((await (await handler(demo(trip, id))).json()).answer.kind);
    }
    expect([...reached].sort()).toEqual(["go", "go_another_way", "no_one_knows", "wait"]);
  }, 10_000);
});

describe("a route must reach the trip's own start and end (🔴1)", () => {
  const SAVED_BANILAD_PLAIN = ROUTES["10.346,123.911"];
  const SAVED_BANILAD_DETOUR = DETOUR_RECORDS[0].reply;
  // The saved routes loop round IT Park at the end, passing 13 m from it, so the cuts are by measured effect:
  // 675 m off the end leaves the line ~330 m from IT Park and wholly outside its 330 m box; 300 m off leaves it 37 m away.
  const DERIVED_DETOUR_ENDING_330_M_FROM_IT_PARK = derivedReply(SAVED_BANILAD_DETOUR, (l) => cutEnd(l, 675));
  const DERIVED_DETOUR_STARTING_300_M_IN = derivedReply(SAVED_BANILAD_DETOUR, (l) => cutStart(l, 300));
  const DERIVED_PLAIN_ENDING_330_M_FROM_IT_PARK = derivedReply(SAVED_BANILAD_PLAIN, (l) => cutEnd(l, 675));
  const DERIVED_PLAIN_STARTING_300_M_IN = derivedReply(SAVED_BANILAD_PLAIN, (l) => cutStart(l, 300));
  const DERIVED_PLAIN_ENDING_37_M_FROM_IT_PARK = derivedReply(SAVED_BANILAD_PLAIN, (l) => cutEnd(l, 300));

  it("a detour that stops 330 m short of a flooded IT Park is no way around it ⇒ Wait, not Go another way", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { detourReply: DERIVED_DETOUR_ENDING_330_M_FROM_IT_PARK });
    const res = await handler(demo("banilad-itpark", "no_way_around"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer.kind).toBe("wait");
    expect(body.detour).toBeNull();
  });

  it("a detour that starts 300 m along the way is no way around ⇒ Wait", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { detourReply: DERIVED_DETOUR_STARTING_300_M_IN });
    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();
    expect(body.answer.kind).toBe("wait");
    expect(body.detour).toBeNull();
  });

  it.each([
    ["stops 330 m short of IT Park", DERIVED_PLAIN_ENDING_330_M_FROM_IT_PARK],
    ["starts 300 m from Banilad", DERIVED_PLAIN_STARTING_300_M_IN],
  ])("a plain route that %s gives no answer, never one judged on part of the trip", async (_what, reply) => {
    for (const scenario of ["none", "no_way_around"]) {
      const { handler } = handlerAt(NO_ADVISORY, { plainReply: reply });
      const res = await handler(demo("banilad-itpark", scenario));
      expect(res.status, scenario).toBe(503);
      const body = await res.json();
      expect(body.answer).toBeUndefined();
      expect(body.routing).toBe("off_trip");
    }
  });

  it("a plain route ending 37 m from IT Park is used, and the gap to IT Park is judged with it: the flooded spot there blocks it", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { plainReply: DERIVED_PLAIN_ENDING_37_M_FROM_IT_PARK });
    const body = await (await handler(demo("banilad-itpark", "no_way_around"))).json();
    expect(body.answer.kind).toBe("wait");
    expect(body.reports[0]).toMatchObject({ onRoute: true, role: "block" });
  });
});

/** The demo Banilad → IT Park trip's ends, sent as a real trip: the saved Valhalla replies answer for them. */
const BANILAD = { lat: 10.346, lon: 123.911 };
const IT_PARK = { lat: 10.3307, lon: 123.9058 };
const real = (from = BANILAD, to = IT_PARK, rainingHere = false) => check({ mode: "real", from, to, rainingHere });

/** A real photo report, NPLV, 40 min old, at the same spot as the demo's flooded sample (so the saved detour answers). */
function storedReport(at: Date, overrides: Partial<StoredPhotoReport> = {}): StoredPhotoReport {
  return {
    id: randomUUID(),
    kind: "photo",
    at: { lat: 10.335398, lon: 123.910908 },
    wayId: null,
    place: "Governor M. Cuenco Avenue",
    receivedAt: new Date(at.getTime() - 40 * 60_000).toISOString(),
    capturedAt: null,
    verdict: {
      kind: "measured",
      rangeCm: { low: 27, high: 39 },
      passability: "NPLV",
      confidence: "low",
      readingsComplete: true,
      decidedBy: { label: "C1", landmark: "tyre_half", interval: { low: 27, high: 39 } },
      readingsUsed: ["C1"],
    },
    // One photo per report: the store keeps one report per photo.
    photoHash: randomUUID().replaceAll("-", ""),
    ...overrides,
  };
}

describe("a real commute check (#6)", () => {
  it("a real commute check uses a stored real report and never a sample", async () => {
    const store = new MemoryReportStore();
    const flooded = storedReport(NO_ADVISORY);
    await seedReport(store, flooded);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const res = await handler(real());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.demo).toBe(false);
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.reports).toEqual([expect.objectContaining({ id: flooded.id, sample: false, role: "block", counts: true, onRoute: true })]);
    expect(body.reports.some((r: { id: string }) => r.id.startsWith("sample-"))).toBe(false);
    expect(body.detour).not.toBeNull();
  });

  it("a report with a published blurred photo carries its URL to the page; one without carries none (#8)", async () => {
    const store = new MemoryReportStore();
    const shown = storedReport(NO_ADVISORY, { photoUrl: "https://blob.test/report-photos/a.jpg" });
    const hidden = storedReport(NO_ADVISORY, { verdict: { kind: "no_flood" } });
    await seedReport(store, shown);
    await seedReport(store, hidden);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const body = await (await handler(real())).json();
    const byId = Object.fromEntries(body.reports.map((r: { id: string; photoUrl: string | null }) => [r.id, r.photoUrl]));
    expect(byId).toEqual({ [shown.id]: "https://blob.test/report-photos/a.jpg", [hidden.id]: null });
  });

  it("a demo check's sample reports carry no blurred photo URL (#8)", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();
    expect(body.reports.length).toBeGreaterThan(0);
    expect(body.reports.every((r: { photoUrl: unknown }) => r.photoUrl === null)).toBe(true);
  });

  it("with no stored reports, the same trip is Go: no sample stands in for a report", async () => {
    const { handler } = handlerAt(NO_ADVISORY);
    const body = await (await handler(real())).json();
    expect(body.answer.kind).toBe("go");
    expect(body.reports).toEqual([]);
  });

  it("a report on a road the trip doesn't take is left out of the answer: its spot isn't sent to the rider", async () => {
    const store = new MemoryReportStore();
    const far = storedReport(NO_ADVISORY, { at: { lat: 10.3143, lon: 123.9147 } });
    const near = storedReport(NO_ADVISORY, { verdict: { kind: "no_flood" } });
    await seedReport(store, far);
    await seedReport(store, near);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const body = await (await handler(real())).json();
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual([near.id]);
    expect(JSON.stringify(body)).not.toContain("123.9147");
  });

  it("a report off the trip with a published blurred photo sends neither its spot nor its photo URL (#8)", async () => {
    const store = new MemoryReportStore();
    const far = storedReport(NO_ADVISORY, { at: { lat: 10.3143, lon: 123.9147 }, photoUrl: "https://blob.test/report-photos/far.jpg" });
    const near = storedReport(NO_ADVISORY, { verdict: { kind: "no_flood" } });
    await seedReport(store, far);
    await seedReport(store, near);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const body = await (await handler(real())).json();
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual([near.id]);
    expect(JSON.stringify(body)).not.toContain("far.jpg");
  });

  it("a demo check never uses a real report, and never reads the store", async () => {
    const store = new MemoryReportStore();
    await seedReport(store, storedReport(NO_ADVISORY));
    const recent = vi.spyOn(store, "recent");
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const body = await (await handler(demo("banilad-itpark", "none"))).json();
    expect(body.answer.kind).toBe("go");
    expect(body.reports).toEqual([]);
    expect(recent).not.toHaveBeenCalled();
  });

  it("a failed report-store read gives no answer, never an empty one", async () => {
    const store = new MemoryReportStore();
    store.recent = async () => {
      throw new Error("Upstash HTTP 500");
    };
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const res = await handler(real());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.answer).toBeUndefined();
    expect(body.error).toMatch(/reports/);
    expect(valhallaCalls()).toHaveLength(0);
  });

  it("no report store configured gives no answer", async () => {
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), null);
    const res = await handler(real());
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
  });

  it("goes through the daily admission with the client's address, before any request", async () => {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 1 });
    const store = new MemoryReportStore();
    const recent = vi.spyOn(store, "recent");
    const { handler, calls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store);
    expect((await handler(real())).status).toBe(200);
    const before = calls.length;
    const refused = await handler(real());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "ip" });
    expect(calls).toHaveLength(before);
    expect(recent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no start", { mode: "real", to: IT_PARK }],
    ["a start that isn't a number", { mode: "real", from: { lat: "10.3", lon: 123.9 }, to: IT_PARK }],
    ["an end outside the Philippines", { mode: "real", from: BANILAD, to: { lat: 35.68, lon: 139.76 } }],
    ["an end north of Metro Cebu", { mode: "real", from: BANILAD, to: { lat: 10.95, lon: 124.0 } }],
    ["a rain tap that isn't true or false", { mode: "real", from: BANILAD, to: IT_PARK, rainingHere: "yes" }],
  ])("%s is refused before any request", async (_why, body) => {
    const store = new MemoryReportStore();
    const recent = vi.spyOn(store, "recent");
    const { handler, calls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    expect((await handler(check(body))).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(recent).not.toHaveBeenCalled();
  });

  it("a trip outside Metro Cebu is refused before any request: the advisory Lusong reads is Cebu's only", async () => {
    const store = new MemoryReportStore();
    const recent = vi.spyOn(store, "recent");
    const { handler, calls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    // Quezon City to Makati, Metro Manila: PAGASA's Cebu advisory says nothing about it.
    const res = await handler(real({ lat: 14.676, lon: 121.0437 }, { lat: 14.5547, lon: 121.0244 }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(recent).not.toHaveBeenCalled();
    // Toledo City, Cebu province but outside Metro Cebu, to Cebu IT Park.
    expect((await handler(real({ lat: 10.3773, lon: 123.6386 }, IT_PARK))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("a Lapu-Lapu → Cebu IT Park trip is taken", async () => {
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY);
    const res = await handler(real({ lat: 10.3103, lon: 123.9494 }, IT_PARK));
    expect(res.status).not.toBe(400);
    expect(valhallaCalls()).toHaveLength(1);
  });

  it("asks Valhalla for the trip as sent", async () => {
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY);
    await handler(real());
    expect(JSON.parse(valhallaCalls()[0].body!).locations).toEqual([BANILAD, IT_PARK]);
  });
});

/** A real voice report at the same spot as storedReport's photo, `ageMin` old. */
function storedVoice(at: Date, claim: StoredVoiceReport["claim"], ageMin = 5): StoredVoiceReport {
  return {
    id: randomUUID(),
    kind: "voice",
    at: { lat: 10.335398, lon: 123.910908 },
    wayId: null,
    place: "Governor M. Cuenco Avenue",
    receivedAt: new Date(at.getTime() - ageMin * 60_000).toISOString(),
    claim,
    audioHash: randomUUID().replaceAll("-", ""),
  };
}

describe("voice reports in a real commute check, through the answer rules on the saved Banilad → IT Park route (#9)", () => {
  const PASSABLE = { place: null, depth: "below_knee", passable: "yes" } as const;
  const KNEE_DEEP = { place: "Cuenco", depth: "knee_or_deeper", passable: "not_said" } as const;

  async function answerWith(...reports: (StoredPhotoReport | StoredVoiceReport)[]) {
    const store = new MemoryReportStore();
    for (const r of reports) await seedReport(store, r);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const res = await handler(real());
    expect(res.status).toBe(200);
    return res.json();
  }

  it("a voice report saying the street is passable doesn't clear it: a blocking photo there still blocks", async () => {
    const photo = storedReport(NO_ADVISORY);
    const voice = storedVoice(NO_ADVISORY, PASSABLE);
    const body = await answerWith(photo, voice);
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: photo.id, role: "block" }),
        expect.objectContaining({ id: voice.id, role: "neutral", onRoute: true }),
      ]),
    );
  });

  it("a voice report saying passable, alone on the way, is not a Go: the same trip with nothing reported is", async () => {
    expect((await answerWith()).answer.kind).toBe("go");
    expect((await answerWith(storedVoice(NO_ADVISORY, PASSABLE))).answer.kind).toBe("no_one_knows");
  });

  it("a voice report saying knee-deep blocks the way, and the detour is taken", async () => {
    const voice = storedVoice(NO_ADVISORY, KNEE_DEEP);
    const body = await answerWith(voice);
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.reports).toEqual([
      expect.objectContaining({ id: voice.id, role: "block", onRoute: true, counts: true, depth: "knee-deep or deeper", passability: "Not passable, says a voice report" }),
    ]);
  });
});

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

/** Every key under the prefix with its value (a string, or a sorted set's members), read with SCAN. */
async function upstashHeld(prefix: string): Promise<Record<string, unknown>> {
  const call = async (command: string[]) => {
    const res = await fetch(upstashUrl!, {
      method: "POST",
      headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    return ((await res.json()) as { result: unknown }).result;
  };
  const out: Record<string, unknown> = {};
  let cursor = "0";
  do {
    const [next, keys] = (await call(["SCAN", cursor, "MATCH", `${prefix}:*`, "COUNT", "1000"])) as [string, string[]];
    for (const key of keys) out[key] = (await call(["TYPE", key])) === "zset" ? await call(["ZRANGE", key, "0", "-1"]) : await call(["GET", key]);
    cursor = next;
  } while (cursor !== "0");
  return out;
}

describe.each([
  ["memory store", () => {
    const store = new MemoryReportStore();
    return { store, held: async () => store.dump() as Record<string, unknown> };
  }],
  ...(upstashUrl
    ? [["Upstash store", () => {
        const prefix = `lusong-test-${randomUUID()}`;
        return { store: new UpstashReportStore(upstashUrl, upstashToken, prefix) as ReportStore, held: () => upstashHeld(prefix) };
      }] as const]
    : []),
] as [string, () => { store: ReportStore; held: () => Promise<Record<string, unknown>> }][])("after a real check, the %s", (_name, make) => {
  it("holds nothing about the trip: every key and value is as it was", async () => {
    const { store, held } = make();
    await seedReport(store, storedReport(new Date(), { receivedAt: new Date(Date.now() - 40 * 60_000).toISOString() }));
    const before = await held();
    expect(Object.keys(before)).toHaveLength(3);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    expect((await handler(real())).status).toBe(200);
    const after = await held();
    expect(after).toEqual(before);
    const everything = JSON.stringify(after);
    for (const coordinate of ["10.346", "123.911", "10.3307", "123.9058"]) expect(everything).not.toContain(coordinate);
  });
});

describe("one deadline for the whole commute check, real trips included (#6)", () => {
  /** Scaled down from 80 s, 28 s and 5 s so the test runs in seconds. */
  const timing: CommuteTiming = { deadlineMs: 2_200, routeWorstMs: 500, storeCallMs: 200, modelRoomMs: 300 };
  const limit = timing.deadlineMs + timing.storeCallMs;

  it("a slow plain route, then a detour that never answers: no answer, within the budget", async () => {
    const store = new MemoryReportStore();
    await seedReport(store, storedReport(NO_ADVISORY));
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, { plainDelayMs: 1_200, detourHangs: true }, new MemorySlotStore(), openBudget(), store, MUSE_OFF, timing);
    const started = Date.now();
    const res = await handler(real());
    expect(Date.now() - started).toBeLessThan(limit);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.answer).toBeUndefined();
    expect(body.routing).toBe("out_of_time");
    expect(valhallaCalls()).toHaveLength(2);
  }, 30_000);

  it("a demo check's detour that never answers is cut off the same way", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { plainDelayMs: 1_200, detourHangs: true }, new MemorySlotStore(), openBudget(), new MemoryReportStore(), MUSE_OFF, timing);
    const started = Date.now();
    const res = await handler(demo("banilad-itpark", "flooded"));
    expect(Date.now() - started).toBeLessThan(limit);
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
  }, 30_000);

  it("a report store that never answers: no answer, within the budget, and Valhalla isn't asked", async () => {
    const store = new MemoryReportStore();
    store.recent = () => new Promise(() => {});
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, MUSE_OFF, timing);
    const started = Date.now();
    const res = await handler(real());
    expect(Date.now() - started).toBeLessThan(limit);
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
    expect(valhallaCalls()).toHaveLength(0);
  }, 10_000);

  it("the real deadline and the settle's cut-off leave the route's 90 s limit room for the response", () => {
    // The route module imports through the "@/" alias, which vitest doesn't resolve, so its limit is read from source.
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/commute/route.ts", "utf8"))?.[1]);
    expect(maxDuration).toBe(90);
    expect(COMMUTE_TIMING.deadlineMs + COMMUTE_TIMING.storeCallMs).toBeLessThan(maxDuration * 1_000);
    expect(COMMUTE_TIMING.storeCallMs).toBeGreaterThanOrEqual(5_000);
    expect(COMMUTE_TIMING.storeCallMs).toBeLessThan(SETTLE_ROOM_MS);
  });
});

describe("Muse Spark in the demo check (#7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  process.env.MODEL_API_KEY = "test-key";

  const roomy = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 });
  const museOn = (kv = new MemoryKvStore(), searchBudget: Budget = roomy()): MuseDeps => ({ enabled: true, searchStore: () => kv, searchBudget: () => searchBudget });
  const FLOODED = () => sampleReports("banilad-itpark", "flooded", NO_ADVISORY)[0].id;
  /** NO_ADVISORY is 2026-10-29 in PHT. */
  const closures = JSON.stringify({
    closures: [
      { place: "A. S. Fortuna St, Mandaue", lat: 10.335, lon: 123.935, url: "https://news.example.ph/fortuna", date: "2026-10-29", kind: "closed", summary: "Closed by flooding." },
      { place: "Colon St", lat: null, lon: null, url: "https://example.ph/colon", date: null, kind: "flooded", summary: "Flooded." },
    ],
  });
  const pickOf = (answer: string, evidence: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ answer, evidence, ...extra });
  const loop = () => [
    callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]),
    textReply("resp_2", pickOf("go_another_way", [FLOODED(), "detour"])),
  ];
  const LABEL = "Muse Spark picked this evidence";

  it("shows the rules' reason, then the evidence Muse Spark picked in Lusong's words, and the web findings with their links and search time", async () => {
    const meta = fakeMeta({ search: [searchReply(closures)], turns: loop() });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

    const res = await handler(demo("banilad-itpark", "flooded"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.answer.reason).toMatch(/^Your usual way is blocked at /);
    expect(body.muse.pick).toEqual({
      shown: true,
      label: LABEL,
      sentences: [
        "A sample report 40 min ago on Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue reads half-knee- to knee-deep (27–39 cm): not passable to light vehicles (MMDA gauge, Metro Manila).",
        "Nothing reported blocks the other way.",
      ],
      note: null,
    });
    expect(body.muse.web.line).toBe("Searched the web at 29 Oct, 12:00 p.m. PHT");
    expect(body.muse.web.findings).toEqual([
      { place: "A. S. Fortuna St, Mandaue", url: "https://news.example.ph/fortuna", site: "news.example.ph", sourceDate: "2026-10-29", description: "Closed, says a page on news.example.ph dated 2026-10-29.", counted: true, note: "Dated today and placed on the map: it can block a way, never clear one." },
      { place: "Colon St", url: "https://example.ph/colon", site: "example.ph", sourceDate: null, description: "Flooded, says an undated page on example.ph.", counted: false, note: "Shown, not counted: it has no date and no place on the map." },
    ]);
    expect(meta.searchRequests).toHaveLength(1);
    expect(meta.requests).toHaveLength(2);
  });

  it("when Muse Spark fails, the rules' answer and its evidence stand and the page says the explanation is unavailable", async () => {
    fakeMeta({ search: [searchReply(closures)], turns: [new Response("{}", { status: 500 }), new Response("{}", { status: 500 })] });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();

    expect(body.answer.kind).toBe("go_another_way");
    expect(body.reports.length).toBeGreaterThan(0);
    expect(body.muse.pick).toEqual({ shown: false, label: LABEL, sentences: [], note: PICK_UNAVAILABLE });
  });

  it("a pick that fails its checks is just not shown", async () => {
    fakeMeta({ search: [searchReply(closures)], turns: [textReply("resp_1", pickOf("wait", [FLOODED()]))] });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();

    expect(body.muse.pick).toEqual({ shown: false, label: LABEL, sentences: [], note: null });
  });

  it("a web finding's own words never reach the response, and it still blocks the way when dated today and placed on it (review 🔴2)", async () => {
    const spot = sampleReports("banilad-itpark", "flooded", NO_ADVISORY)[0].at;
    const words = "The road is passable to all types of vehicles.";
    const onRoute = JSON.stringify({
      closures: [{ place: "Gov. M. Cuenco Ave", lat: spot.lat, lon: spot.lon, url: "https://example.ph/cuenco", date: "2026-10-29", kind: "flooded", summary: words, note: words }],
    });
    fakeMeta({ search: [searchReply(onRoute)], turns: [textReply("resp_1", pickOf("go_another_way", ["web-0"]))] });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

    const text = await (await handler(demo("banilad-itpark", "none"))).text();
    const body = JSON.parse(text);

    expect(text.toLowerCase()).not.toContain("passable to all");
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.answer.reason).toContain("Gov. M. Cuenco Ave");
    expect(body.muse.pick.sentences).toEqual(["A page on example.ph dated 2026-10-29 reports Gov. M. Cuenco Ave flooded."]);
  });

  it("a web finding's link must be a page the search tool opened, and is given without its fragment; one it never opened never reaches the response (review 🔴T7-8)", async () => {
    const words = ["Start-your-trip-now", "the-road-is-open-to-every-vehicle", "Proceed+with+your+trip", "Wala-nang-baha"];
    const colon = { place: "Colon St", lat: null, lon: null, date: null, kind: "flooded" };
    const found = JSON.stringify({
      closures: [
        { ...colon, url: "https://example.ph/colon#Start-your-trip-now" },
        { ...colon, url: "https://the-road-is-open-to-every-vehicle.example.ph/colon" },
        { ...colon, url: "https://example.ph/the-road-is-open-to-every-vehicle" },
        { ...colon, url: "https://example.ph/colon?Proceed+with+your+trip" },
        { ...colon, url: "https://example.ph/mabolo#Wala-nang-baha" },
      ],
    });
    fakeMeta({ search: [searchReply(found, 11, undefined, ["https://example.ph/colon"])], turns: loop() });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

    const text = await (await handler(demo("banilad-itpark", "flooded"))).text();

    for (const w of words) expect(text.toLowerCase()).not.toContain(w.toLowerCase());
    expect(JSON.parse(text).muse.web.findings).toEqual([
      { place: "Colon St", url: "https://example.ph/colon", site: "example.ph", sourceDate: null, description: "Flooded, says an undated page on example.ph.", counted: false, note: "Shown, not counted: it has no date and no place on the map." },
    ]);
  });

  describe("no word Muse Spark writes reaches the response (review 🔴1)", () => {
    // Each passed a phrase check under Wait in an earlier round (gpt-6-astra, two review rounds).
    const PHRASES = [
      "Start your trip now.",
      "The road is open to every vehicle.",
      "Wala nang baha. Bumiyahe ka na.",
      "Pwede na, walang baha.",
      "Proceed with your trip.",
      "There is no need to wait.",
      "The road is passable to all types of vehicles.",
    ];
    const saying = (reply: { output: Record<string, unknown>[] }, words: string) => ({
      ...reply,
      output: reply.output.map((item) =>
        item.type === "message" && item.phase === "commentary"
          ? { ...item, content: (item.content as Record<string, unknown>[]).map((c) => ({ ...c, text: words })) }
          : item,
      ),
    });
    const scripts = (p: string) => [
      // A pick that passes, with the words in every other field, in the commentary and in a tool call's arguments.
      [
        saying(callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }, { name: "reports_near_route", args: { route: p } }]), p),
        textReply("resp_2", pickOf("go_another_way", [FLOODED(), "detour"], { sentences: [{ text: p, evidence: [FLOODED()] }], note: p, [p]: p })),
      ],
      [textReply("resp_1", pickOf("go_another_way", [p]))],
      [textReply("resp_1", pickOf(p, [FLOODED()]))],
      [textReply("resp_1", p)],
    ];

    it.each(PHRASES)("%s", async (p) => {
      const shown: boolean[] = [];
      for (const turns of scripts(p)) {
        fakeMeta({ search: [searchReply(closures)], turns });
        const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn());

        const text = await (await handler(demo("banilad-itpark", "flooded"))).text();

        expect(text.toLowerCase()).not.toContain(p.toLowerCase());
        shown.push(JSON.parse(text).muse.pick.shown);
        vi.unstubAllGlobals();
      }
      expect(shown).toEqual([true, false, false, false]);
    }, 20_000);
  });

  it("a cold check reserves the search and the loop on top of its 1 µ$, a warm one only the loop; both settle at the metered cost", async () => {
    const admits: number[] = [];
    const settled: { queries: number; complete: boolean; ok: boolean }[] = [];
    const inner = openBudget();
    const watched: Budget = {
      admit: (ip, at, reserve) => (admits.push(reserve!), inner.admit(ip, at, reserve)),
      settle: (a, usage, ok) => (settled.push({ queries: usage.webSearchQueries, complete: usage.complete, ok }), inner.settle(a, usage, ok)),
    };
    const kv = new MemoryKvStore();
    fakeMeta({ search: [searchReply(closures)], turns: [...loop(), ...loop()] });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), watched, new MemoryReportStore(), museOn(kv));

    expect((await handler(demo("banilad-itpark", "flooded"))).status).toBe(200);
    expect((await handler(demo("banilad-itpark", "flooded"))).status).toBe(200);

    expect(admits).toEqual([
      COMMUTE_RESERVE_MICROS + investigationReserveMicros({ kind: "search" }),
      COMMUTE_RESERVE_MICROS + investigationReserveMicros({ kind: "cached" }),
    ]);
    expect(settled).toEqual([
      { queries: 11, complete: true, ok: true },
      { queries: 0, complete: true, ok: true },
    ]);
  });

  describe("settles through the shared admission at what Meta's replies report", () => {
    function charging() {
      const charged: number[] = [];
      const store: BudgetStore = { admit: async () => "admitted", settle: async (x) => (charged.push(x.chargeMicros), true) };
      return { budget: createBudget({ store, budgetUsd: 10, ipLimit: 10 }), charged };
    }
    const COLD = COMMUTE_RESERVE_MICROS + investigationReserveMicros({ kind: "search" });

    it.each([
      // 90,257 × 1.25 + 3,000 × 4.25 + 11 × 2,500 + 2 × (679 × 1.25 + 327 × 4.25) = 157,548.25 µ$
      ["success: the search's tokens and queries and the loop's tokens", () => ({ search: [searchReply(closures)], turns: loop() }), 157_549],
      ["retry: a retried call keeps the whole reservation", () => ({ search: [searchReply(closures)], turns: [new Response("{}", { status: 503 }), ...loop()] }), COLD],
      ["partial: usage without output tokens keeps it", () => ({ search: [searchReply(closures)], turns: [loop()[0], { ...loop()[1], usage: { input_tokens: 679 } }] }), COLD],
      ["usage missing: a search reply without usage keeps it", () => ({ search: [searchReply(closures, 11, null)], turns: loop() }), COLD],
      // 400,000 × 1.25 + 4,000 × 4.25 + 1,000 × 2,500 + 4,477 = 3,021,477 µ$, past the 849,126 µ$ reserved
      ["search overrun: charged in full past the reservation", () => ({ search: [searchReply(closures, 1_000, { input_tokens: 400_000, output_tokens: 4_000 })], turns: loop() }), 3_021_477],
    ] as const)("%s", async (_name, script, expected) => {
      const { budget, charged } = charging();
      fakeMeta(script());
      const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, new MemoryReportStore(), museOn());

      expect((await handler(demo("banilad-itpark", "flooded"))).status).toBe(200);

      expect(charged).toEqual([expected]);
    });
  });

  it("a check the daily budget refuses makes no Meta call and gives its search reservation back", async () => {
    const meta = fakeMeta({});
    const kv = new MemoryKvStore();
    const searchBudget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: SEARCH_RESERVE_MICROS / 1e6, ipLimit: 1 });
    const broke = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 0.000_01, ipLimit: 10 });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), broke, new MemoryReportStore(), museOn(kv, searchBudget));

    expect((await handler(demo("banilad-itpark", "flooded"))).status).toBe(503);

    expect(meta.fetchMock).not.toHaveBeenCalled();
    expect(await planWebSearch(kv, NO_ADVISORY, searchBudget)).toMatchObject({ kind: "search" });
  });

  it("past today's web search cap the check runs without web search and says so", async () => {
    const meta = fakeMeta({ turns: loop() });
    const spent = createBudget({ store: new MemoryBudgetStore(), budgetUsd: (SEARCH_RESERVE_MICROS - 1) / 1e6, ipLimit: 1 });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn(new MemoryKvStore(), spent));

    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();

    expect(meta.searchRequests).toHaveLength(0);
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.muse.web).toEqual({ line: "Web search skipped: today's web search budget is used up.", findings: [] });
  });

  it("with Muse Spark off the check reserves 1 µ$, calls no model, and says the explanation is unavailable", async () => {
    const meta = fakeMeta({});
    const { handler } = handlerAt(NO_ADVISORY);

    const body = await (await handler(demo("banilad-itpark", "flooded"))).json();

    expect(meta.fetchMock).not.toHaveBeenCalled();
    expect(body.muse.pick.note).toBe(PICK_UNAVAILABLE);
    expect(body.muse.web.line).toBe("Web search skipped: Muse Spark is off.");
  });
});

describe("one deadline for the whole commute check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  process.env.MODEL_API_KEY = "test-key";
  const museOn = (): MuseDeps => ({
    enabled: true,
    searchStore: () => new MemoryKvStore(),
    searchBudget: () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 }),
  });

  it(`fits the route's maxDuration with ${SETTLE_ROOM_MS / 1000} s left to settle`, () => {
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(read("app/api/commute/route.ts"))![1]);
    expect(maxDuration).toBe(90);
    expect(COMMUTE_DEADLINE_MS + SETTLE_ROOM_MS).toBeLessThanOrEqual(maxDuration * 1000);
  });

  it("a slow plain route that leaves no time for the way around fails in a controlled way, before the deadline", async () => {
    const settles: boolean[] = [];
    const inner = openBudget();
    const watched: Budget = { admit: inner.admit, settle: (a, u, ok) => (settles.push(ok), inner.settle(a, u, ok)) };
    const meta = fakeMeta({ search: [hangs] });
    const { handler } = handlerAt(NO_ADVISORY, { valhallaDelayMs: 1_200 }, new MemorySlotStore(), watched, new MemoryReportStore(), museOn(), { deadlineMs: 2_000, routeWorstMs: 1_000, modelRoomMs: 400 });

    const started = Date.now();
    const res = await handler(demo("banilad-itpark", "flooded"));

    expect(Date.now() - started).toBeLessThan(2_500);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Lusong ran out of time looking for a way around, so it can't give an answer. Try again in a minute.");
    expect(settles).toEqual([false]);
    expect(meta.searchRequests).toHaveLength(1);
  });

  it("a slow plain route, a slow detour and a model that never answers still give the rules' answer by the deadline", async () => {
    const meta = fakeMeta({ search: [hangs], turns: [hangs] });
    const { handler } = handlerAt(NO_ADVISORY, { valhallaDelayMs: 400 }, new MemorySlotStore(), openBudget(), new MemoryReportStore(), museOn(), { deadlineMs: 2_500, routeWorstMs: 600, modelRoomMs: 500 });

    const started = Date.now();
    const res = await handler(demo("banilad-itpark", "flooded"));

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer.kind).toBe("go_another_way");
    expect(body.muse.pick.note).toBe(PICK_UNAVAILABLE);
    expect(body.muse.web.line).toBe("Web search skipped: the search failed.");
    expect(meta.searchRequests).toHaveLength(1);
    expect(meta.requests).toHaveLength(1);
  });
});

describe("Muse Spark in a real check (#6 with #7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  process.env.MODEL_API_KEY = "test-key";

  const roomy = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 });
  const museOn = (kv = new MemoryKvStore(), searchBudget: Budget = roomy()): MuseDeps => ({ enabled: true, searchStore: () => kv, searchBudget: () => searchBudget });
  const closures = JSON.stringify({ closures: [{ place: "Colon St", lat: null, lon: null, url: "https://example.ph/colon", date: null, kind: "flooded" }] });
  const pickOf = (answer: string, evidence: unknown[]) => JSON.stringify({ answer, evidence });
  function watched() {
    const admits: number[] = [];
    const settles: boolean[] = [];
    const inner = openBudget();
    const budget: Budget = {
      admit: (ip, at, reserve) => (admits.push(reserve!), inner.admit(ip, at, reserve)),
      settle: (a, u, ok) => (settles.push(ok), inner.settle(a, u, ok)),
    };
    return { budget, admits, settles };
  }
  /** A search budget with room for exactly one search: a second plan finds a search only if the first was given back. */
  const oneSearch = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: SEARCH_RESERVE_MICROS / 1e6, ipLimit: 1 });

  it("runs the investigation a demo check runs: reports_near_route reads the stored report, and Muse Spark's pick of it is shown in Lusong's words beside the web findings", async () => {
    const store = new MemoryReportStore();
    const flooded = storedReport(NO_ADVISORY);
    await seedReport(store, flooded);
    const meta = fakeMeta({
      search: [searchReply(closures)],
      turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("go_another_way", [flooded.id, "detour"]))],
    });
    const { admits, budget } = watched();
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store, museOn());

    const res = await handler(real());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.demo).toBe(false);
    expect(body.answer.kind).toBe("go_another_way");
    expect(admits).toEqual([COMMUTE_RESERVE_MICROS + investigationReserveMicros({ kind: "search" })]);
    const toolOutput = JSON.parse((meta.requests[1].input as { output: string }[])[0].output);
    expect(toolOutput.reports.map((r: { id: string }) => r.id)).toEqual([flooded.id]);
    expect(body.muse.pick).toEqual({
      shown: true,
      label: "Muse Spark picked this evidence",
      sentences: [expect.stringMatching(/^A report 40 min ago on Governor M\. Cuenco Avenue reads /), "Nothing reported blocks the other way."],
      note: null,
    });
    expect(body.muse.web.line).toBe("Searched the web at 29 Oct, 12:00 p.m. PHT");
    expect(body.muse.web.findings.map((f: { place: string }) => f.place)).toEqual(["Colon St"]);
    expect(meta.searchRequests).toHaveLength(1);
  });

  describe("a scheduled check of a stored trip runs the same investigation (#10 with #7)", () => {
    it("reserves what the page's check reserves, reads the stored report through reports_near_route, and gives back the answer's kind alone", async () => {
      const store = new MemoryReportStore();
      const flooded = storedReport(NO_ADVISORY);
      await seedReport(store, flooded);
      const meta = fakeMeta({
        search: [searchReply(closures)],
        turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("go_another_way", [flooded.id, "detour"]))],
      });
      const { admits, settles, budget } = watched();
      const { checkTrip } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store, museOn());

      const result = await checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: Date.now() + 60_000 });

      expect(result).toEqual({ ok: true, kind: "go_another_way" });
      expect(admits).toEqual([COMMUTE_RESERVE_MICROS + investigationReserveMicros({ kind: "search" })]);
      expect(settles).toEqual([true]);
      const toolOutput = JSON.parse((meta.requests[1].input as { output: string }[])[0].output);
      expect(toolOutput.reports.map((r: { id: string }) => r.id)).toEqual([flooded.id]);
      expect(meta.searchRequests).toHaveLength(1);
    });

    it("one whose web search and model never answer ends by the caller's deadline, settle included, as the page's check would: out of time for a way around", async () => {
      const store = new MemoryReportStore();
      await seedReport(store, storedReport(NO_ADVISORY));
      fakeMeta({ search: [hangs], turns: [hangs] });
      const { settles, budget } = watched();
      // The check's own deadline is far off: only the caller's can end it in time.
      const timing: CommuteTiming = { deadlineMs: 10_000, routeWorstMs: 300, storeCallMs: 200, modelRoomMs: 200 };
      const { checkTrip } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store, museOn(), timing);

      const started = Date.now();
      const result = await checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: started + 1_500 });

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(result).toEqual({ ok: false, status: 503 });
      expect(settles).toEqual([false]);
    }, 15_000);
  });

  describe("a stored voice report reaches the investigation as a photo report does (#9 with #7)", () => {
    /** Words a speaker might say; the claim keeps them, but the page never shows a claim's own place. */
    const SPOKEN = "sa may Cuenco duol sa simbahan";
    const KNEE_DEEP = { place: SPOKEN, depth: "knee_or_deeper", passable: "not_said" } as const;

    it("reports_near_route reads it as a voice report, and Muse Spark's pick of it is shown in Lusong's words, never the speaker's", async () => {
      const store = new MemoryReportStore();
      const voice = storedVoice(NO_ADVISORY, KNEE_DEEP);
      await seedReport(store, voice);
      const meta = fakeMeta({
        search: [searchReply(closures)],
        turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("go_another_way", [voice.id, "detour"]))],
      });
      const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, museOn());

      const res = await handler(real());
      const text = await res.text();

      expect(res.status).toBe(200);
      const body = JSON.parse(text);
      expect(body.answer.kind).toBe("go_another_way");
      const toolOutput = JSON.parse((meta.requests[1].input as { output: string }[])[0].output);
      expect(toolOutput.reports).toEqual([expect.objectContaining({ id: voice.id, kind: "voice", says: "knee_deep_or_deeper", role: "block" })]);
      expect(body.muse.pick).toEqual({
        shown: true,
        label: "Muse Spark picked this evidence",
        sentences: ["A voice report 5 min ago on Governor M. Cuenco Avenue says the water is knee-deep or deeper.", "Nothing reported blocks the other way."],
        note: null,
      });
      expect(text).not.toContain(SPOKEN);
    });

    it("a voice report off both judged routes is no more pickable than a photo there: its pick is not shown and the report isn't sent", async () => {
      const store = new MemoryReportStore();
      const flooded = storedReport(NO_ADVISORY);
      const offRoute = { ...storedVoice(NO_ADVISORY, KNEE_DEEP), at: { lat: 10.2447, lon: 123.8494 }, place: "Tabunok Public Market" };
      await seedReport(store, flooded);
      await seedReport(store, offRoute);
      fakeMeta({
        search: [searchReply(closures)],
        turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("go_another_way", [flooded.id, offRoute.id, "detour"]))],
      });
      const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, museOn());

      const res = await handler(real());
      const text = await res.text();

      expect(res.status).toBe(200);
      const body = JSON.parse(text);
      expect(body.reports.map((r: { id: string }) => r.id)).toEqual([flooded.id]);
      expect(body.muse.pick.shown).toBe(false);
      expect(text).not.toContain("Tabunok Public Market");
      expect(text).not.toContain(offRoute.id);
      expect(text).not.toContain(SPOKEN);
    });

    it("an unsure voice report on the way is neutral evidence Muse Spark may pick: it blocks nothing, and is described as saying nothing Lusong could read", async () => {
      const store = new MemoryReportStore();
      const unsure = storedVoice(NO_ADVISORY, { place: null, depth: "not_said", passable: "not_said" });
      await seedReport(store, unsure);
      fakeMeta({
        search: [searchReply(closures)],
        turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("no_one_knows", [unsure.id]))],
      });
      const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, museOn());

      const body = await (await handler(real())).json();

      expect(body.answer.kind).toBe("no_one_knows");
      expect(body.reports).toEqual([expect.objectContaining({ id: unsure.id, role: "neutral", passability: "A voice report that doesn't say whether vehicles can pass" })]);
      expect(body.muse.pick.sentences).toEqual(["A voice report 5 min ago on Governor M. Cuenco Avenue says nothing Lusong could read about the water."]);
    });
  });

  describe("a stored report off both judged routes never reaches the rider, even when Muse Spark picks its id (review 🔴C-3)", () => {
    /** Tabunok, Talisay: kilometres from Banilad → IT Park and from its way around. */
    const OFF_ROUTE_PLACE = "Tabunok Public Market";
    it.each([
      ["its id alone", (on: string, off: string) => [off]],
      ["its id among on-route evidence", (on: string, off: string) => [on, off, "detour"]],
    ])("%s", async (_name, picked) => {
      const store = new MemoryReportStore();
      const flooded = storedReport(NO_ADVISORY);
      const offRoute = storedReport(NO_ADVISORY, { at: { lat: 10.2447, lon: 123.8494 }, place: OFF_ROUTE_PLACE });
      await seedReport(store, flooded);
      await seedReport(store, offRoute);
      fakeMeta({
        search: [searchReply(closures)],
        turns: [callsReply("resp_1", [{ name: "reports_near_route", args: { route: "plain" } }]), textReply("resp_2", pickOf("go_another_way", picked(flooded.id, offRoute.id)))],
      });
      const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, museOn());

      const res = await handler(real());
      const text = await res.text();

      expect(res.status).toBe(200);
      const body = JSON.parse(text);
      expect(body.answer.kind).toBe("go_another_way");
      expect(body.reports.map((r: { id: string }) => r.id)).toEqual([flooded.id]);
      expect(body.muse.pick.shown).toBe(false);
      expect(text).not.toContain(OFF_ROUTE_PLACE);
      expect(text).not.toContain(offRoute.id);
    });
  });

  describe("a counted report on a judged way around the page doesn't show is still pickable, and is sent with its route (review 🔴C-4)", () => {
    /** A spot on the saved Banilad → IT Park detour, about 670 m off the plain route. */
    const SECOND_SPOT = { lat: 10.337802, lon: 123.904674 };
    const SECOND_PLACE = "Second reported spot";
    /** The saved detour with every point within 200 m of SECOND_SPOT moved 0.001° east (about 110 m): a second, distinct way around. */
    const DERIVED_DETOUR_CLEAR_OF_SECOND_SPOT = derivedReply(DETOUR_RECORDS[0].reply, (l) =>
      l.map((p) => (distanceM(p, SECOND_SPOT) < 200 ? { lat: p.lat, lon: p.lon + 0.001 } : p)),
    );
    const lineOf = (reply: string): Point[] => decodePolyline6(JSON.parse(reply).trip.legs[0].shape);

    it("the rules' way around is blocked at a spot only it passes, Muse Spark's way around is shown, and a pick of that spot's report is shown in Lusong's words", async () => {
      const offM = (line: Point[]) => placeOnRoute(SECOND_SPOT, line).offM;
      expect(offM(lineOf(ROUTES["10.346,123.911"]))).toBeGreaterThan(ROUTE_CORRIDOR_M);
      expect(offM(lineOf(DETOUR_RECORDS[0].reply))).toBeLessThanOrEqual(ROUTE_CORRIDOR_M);
      expect(offM(lineOf(DERIVED_DETOUR_CLEAR_OF_SECOND_SPOT))).toBeGreaterThan(ROUTE_CORRIDOR_M);

      const store = new MemoryReportStore();
      const flooded = storedReport(NO_ADVISORY);
      const second = storedReport(NO_ADVISORY, { at: SECOND_SPOT, place: SECOND_PLACE });
      await seedReport(store, flooded);
      await seedReport(store, second);
      fakeMeta({
        search: [searchReply(closures)],
        turns: [
          callsReply("resp_1", [{ name: "route_around", args: { spots: [SECOND_SPOT] } }]),
          textReply("resp_2", pickOf("go_another_way", [second.id, "muse-1"])),
        ],
      });
      // The rules' request excludes the flooded spot alone and gets the saved detour; Muse Spark's excludes both spots.
      const opts: Options = { detourReplyFor: (sent) => (sent.exclude_polygons.length === 2 ? DERIVED_DETOUR_CLEAR_OF_SECOND_SPOT : undefined) };
      const { handler } = handlerAt(NO_ADVISORY, opts, new MemorySlotStore(), openBudget(), store, museOn());

      const res = await handler(real());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.answer.kind).toBe("go_another_way");
      expect(body.detour).toMatchObject({ routeId: "muse-1", proposedBy: "muse_spark" });
      expect(body.muse.pick).toEqual({
        shown: true,
        label: "Muse Spark picked this evidence",
        sentences: [expect.stringMatching(new RegExp(`^A report 40 min ago on ${SECOND_PLACE} reads `)), "Nothing reported blocks the way Muse Spark suggested."],
        note: null,
      });
      const sent = Object.fromEntries(body.reports.map((r: { id: string }) => [r.id, r]));
      expect(Object.keys(sent).sort()).toEqual([flooded.id, second.id].sort());
      expect(sent[flooded.id]).toMatchObject({ onRoute: true, onDetour: false, routes: ["plain"] });
      expect(sent[second.id]).toMatchObject({ place: SECOND_PLACE, counts: true, role: "block", onRoute: false, onDetour: false, routes: ["detour"] });
    });
  });

  it("when Muse Spark fails on a real check, the rules' answer and the stored report stand and the page says the explanation is unavailable", async () => {
    const store = new MemoryReportStore();
    const flooded = storedReport(NO_ADVISORY);
    await seedReport(store, flooded);
    fakeMeta({ search: [searchReply(closures)], turns: [new Response("{}", { status: 500 }), new Response("{}", { status: 500 })] });
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, museOn());

    const body = await (await handler(real())).json();

    expect(body.answer.kind).toBe("go_another_way");
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual([flooded.id]);
    expect(body.muse.pick).toEqual({ shown: false, label: "Muse Spark picked this evidence", sentences: [], note: PICK_UNAVAILABLE });
  });

  it("with Muse Spark off a real check reserves 1 µ$, calls no model, and says the explanation is unavailable", async () => {
    const meta = fakeMeta({});
    const { admits, budget } = watched();
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget);

    const body = await (await handler(real())).json();

    expect(admits).toEqual([COMMUTE_RESERVE_MICROS]);
    expect(meta.fetchMock).not.toHaveBeenCalled();
    expect(body.muse.pick.note).toBe(PICK_UNAVAILABLE);
    expect(body.muse.web.line).toBe("Web search skipped: Muse Spark is off.");
  });

  it("a real check whose report store can't be read asks neither Valhalla nor Meta, settles, and gives its web search back", async () => {
    const store = new MemoryReportStore();
    store.recent = async () => {
      throw new Error("Upstash HTTP 500");
    };
    const meta = fakeMeta({});
    const kv = new MemoryKvStore();
    const searchBudget = oneSearch();
    const { settles, budget } = watched();
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store, museOn(kv, searchBudget));

    const res = await handler(real());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/reports/);
    expect(meta.fetchMock).not.toHaveBeenCalled();
    expect(valhallaCalls()).toHaveLength(0);
    expect(settles).toEqual([false]);
    expect(await planWebSearch(kv, NO_ADVISORY, searchBudget)).toMatchObject({ kind: "search" });
  });

  describe("a real check that stalls returns by the deadline with its reservation settled", () => {
    const timing: CommuteTiming = { deadlineMs: 1_500, routeWorstMs: 500, storeCallMs: 200, modelRoomMs: 300 };
    const limit = timing.deadlineMs + timing.storeCallMs;

    it("a report store that never answers: no answer, Valhalla and Meta never asked, the web search given back", async () => {
      const store = new MemoryReportStore();
      store.recent = () => new Promise(() => {});
      const meta = fakeMeta({});
      const kv = new MemoryKvStore();
      const searchBudget = oneSearch();
      const { settles, budget } = watched();
      const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), budget, store, museOn(kv, searchBudget), timing);

      const started = Date.now();
      const res = await handler(real());

      expect(Date.now() - started).toBeLessThan(limit);
      expect(res.status).toBe(503);
      expect((await res.json()).answer).toBeUndefined();
      expect(valhallaCalls()).toHaveLength(0);
      expect(meta.fetchMock).not.toHaveBeenCalled();
      expect(settles).toEqual([false]);
      expect(await planWebSearch(kv, NO_ADVISORY, searchBudget)).toMatchObject({ kind: "search" });
    }, 10_000);

    it("a routing server that never answers, with a web search that never answers: no answer, out of time", async () => {
      const store = new MemoryReportStore();
      await seedReport(store, storedReport(NO_ADVISORY));
      const meta = fakeMeta({ search: [hangs] });
      const { settles, budget } = watched();
      const { handler } = handlerAt(NO_ADVISORY, { plainHangs: true }, new MemorySlotStore(), budget, store, museOn(), timing);

      const started = Date.now();
      const res = await handler(real());

      expect(Date.now() - started).toBeLessThan(limit);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.answer).toBeUndefined();
      expect(body.routing).toBe("out_of_time");
      expect(settles).toEqual([false]);
      expect(meta.searchRequests).toHaveLength(1);
    }, 10_000);

    it("a Valhalla slot store that never answers: no answer, out of time, and Valhalla never asked", async () => {
      const slots: SlotStore = { claim: () => new Promise(() => {}) };
      const meta = fakeMeta({ search: [hangs] });
      const { settles, budget } = watched();
      const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, slots, budget, new MemoryReportStore(), museOn(), timing);

      const started = Date.now();
      const res = await handler(real());

      expect(Date.now() - started).toBeLessThan(limit);
      expect(res.status).toBe(503);
      expect((await res.json()).routing).toBe("out_of_time");
      expect(valhallaCalls()).toHaveLength(0);
      expect(settles).toEqual([false]);
      expect(meta.searchRequests).toHaveLength(1);
    }, 10_000);
  });
});

describe("the web search runs under the check's one deadline (review 🔴C-1, 🔴C-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  process.env.MODEL_API_KEY = "test-key";

  const timing: CommuteTiming = { deadlineMs: 1_500, routeWorstMs: 300, storeCallMs: 200, modelRoomMs: 200 };
  const limit = timing.deadlineMs + timing.storeCallMs;
  const closures = JSON.stringify({ closures: [{ place: "Colon St", lat: null, lon: null, url: "https://example.ph/colon", date: null, kind: "flooded" }] });
  const OPS = ["get", "set", "setIfAbsent", "deleteIfEquals", "compareAndSet"] as const;
  type Op = (typeof OPS)[number];

  /**
   * The shared store, with chosen operations that never answer from their nth call (0-based), or that answer only after
   * a delay. `calls` counts every call each operation was asked, answered or not.
   */
  function slowKv(opts: { stallFrom?: Partial<Record<Op, number>>; delayMs?: Partial<Record<Op, number>> }) {
    const inner = new MemoryKvStore();
    const calls: Record<Op, number> = { get: 0, set: 0, setIfAbsent: 0, deleteIfEquals: 0, compareAndSet: 0 };
    const landed: Op[] = [];
    const store = {} as Record<Op, (...args: unknown[]) => Promise<unknown>>;
    for (const op of OPS) {
      store[op] = async (...args) => {
        const n = calls[op]++;
        const from = opts.stallFrom?.[op];
        if (from !== undefined && n >= from) return new Promise(() => {});
        const delay = opts.delayMs?.[op];
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const result = await (inner[op] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
        landed.push(op);
        return result;
      };
    }
    return { kv: store as unknown as KvStore, inner, calls, landed };
  }

  /** A search budget whose admission or settle never answers, or answers only after a delay; settles are recorded. */
  function slowSearchBudget(opts: { admit?: "stalls" | number; settle?: "stalls" }) {
    const inner = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 100, ipLimit: 1 });
    const settles: boolean[] = [];
    const budget: Budget = {
      admit: async (ip, at, reserve) => {
        if (opts.admit === "stalls") return new Promise(() => {});
        if (typeof opts.admit === "number") await new Promise((resolve) => setTimeout(resolve, opts.admit as number));
        return inner.admit(ip, at, reserve);
      },
      settle: (a, u, ok) => {
        settles.push(ok);
        return opts.settle === "stalls" ? new Promise(() => {}) : inner.settle(a, u, ok);
      },
    };
    return { budget, settles };
  }

  function mainBudget() {
    const admits: number[] = [];
    const settles: boolean[] = [];
    const inner = openBudget();
    const budget: Budget = {
      admit: (ip, at, reserve) => (admits.push(reserve!), inner.admit(ip, at, reserve)),
      settle: (a, u, ok) => (settles.push(ok), inner.settle(a, u, ok)),
    };
    return { budget, admits, settles };
  }

  function checkWith(kv: KvStore, searchBudget: Budget) {
    const main = mainBudget();
    const meta = fakeMeta({ search: [searchReply(closures)], turns: [textReply("resp_1", JSON.stringify({ answer: "go", evidence: ["plain"] }))] });
    const muse: MuseDeps = { enabled: true, searchStore: () => kv, searchBudget: () => searchBudget };
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), main.budget, new MemoryReportStore(), muse, timing);
    return { handler, meta, ...main };
  }

  async function timed(handler: (r: Request) => Promise<Response>) {
    const started = Date.now();
    const res = await handler(demo("banilad-itpark", "none"));
    return { res, elapsed: Date.now() - started };
  }

  describe("planning that stalls: the check ends by the deadline, reserving nothing and asking no one", () => {
    it.each([
      ["the cache read never answers", () => slowKv({ stallFrom: { get: 0 } }), () => slowSearchBudget({})],
      ["the lease is never granted", () => slowKv({ stallFrom: { setIfAbsent: 0 } }), () => slowSearchBudget({})],
      ["the search budget never admits", () => slowKv({}), () => slowSearchBudget({ admit: "stalls" })],
    ] as const)("%s", async (_name, kvOf, searchBudgetOf) => {
      const { kv } = kvOf();
      const { handler, meta, admits, settles } = checkWith(kv, searchBudgetOf().budget);

      const { res, elapsed } = await timed(handler);

      expect(elapsed).toBeLessThan(limit);
      expect(res.status).toBe(503);
      expect(admits).toEqual([]);
      expect(settles).toEqual([]);
      expect(meta.fetchMock).not.toHaveBeenCalled();
    }, 10_000);
  });

  it("a lease granted after the deadline is given back, never held", async () => {
    const { kv, inner, landed } = slowKv({ delayMs: { setIfAbsent: timing.deadlineMs + 100 } });
    const { handler, admits } = checkWith(kv, slowSearchBudget({}).budget);

    const { res, elapsed } = await timed(handler);

    expect(elapsed).toBeLessThan(limit);
    expect(res.status).toBe(503);
    expect(admits).toEqual([]);
    await vi.waitFor(() => expect(landed).toContain("setIfAbsent"), { timeout: 2_000 });
    await vi.waitFor(async () => expect(await inner.get(WEB_SEARCH_LEASE_KEY)).toBeNull(), { timeout: 2_000 });
  }, 10_000);

  it("a search reservation granted after the deadline is settled as failed and its lease given back", async () => {
    const { kv, inner } = slowKv({});
    const search = slowSearchBudget({ admit: timing.deadlineMs + 100 });
    const { handler, admits } = checkWith(kv, search.budget);

    const { res, elapsed } = await timed(handler);

    expect(elapsed).toBeLessThan(limit);
    expect(res.status).toBe(503);
    expect(admits).toEqual([]);
    await vi.waitFor(() => expect(search.settles).toEqual([false]), { timeout: 2_000 });
    expect(await inner.get(WEB_SEARCH_LEASE_KEY)).toBeNull();
  }, 10_000);

  describe("a search that ran, then stalls storing or giving back: the check answers by the deadline and settles", () => {
    // Planning reads the cache twice (before and after the lease), so the third read is the one before the write.
    it.each([
      ["its search reservation's settle never answers", () => slowKv({}), () => slowSearchBudget({ settle: "stalls" })],
      ["the cache read before the write never answers", () => slowKv({ stallFrom: { get: 2 } }), () => slowSearchBudget({})],
      ["the cache write never answers", () => slowKv({ stallFrom: { compareAndSet: 0 } }), () => slowSearchBudget({})],
      ["giving back the lease never answers", () => slowKv({ stallFrom: { deleteIfEquals: 0 } }), () => slowSearchBudget({})],
    ] as const)("%s", async (_name, kvOf, searchBudgetOf) => {
      const { kv } = kvOf();
      const { handler, meta, admits, settles } = checkWith(kv, searchBudgetOf().budget);

      const { res, elapsed } = await timed(handler);

      expect(elapsed).toBeLessThan(limit);
      expect(meta.searchRequests).toHaveLength(1);
      expect(res.status).toBe(200);
      expect((await res.json()).muse.web.findings.map((f: { place: string }) => f.place)).toEqual(["Colon St"]);
      expect(admits).toHaveLength(1);
      expect(settles).toEqual([true]);
    }, 10_000);

    it("past the deadline the search isn't stored, and its lease is still given back", async () => {
      const { kv, inner, calls } = slowKv({});
      const { handler } = checkWith(kv, slowSearchBudget({ settle: "stalls" }).budget);

      const { res, elapsed } = await timed(handler);

      expect(elapsed).toBeLessThan(limit);
      expect(res.status).toBe(200);
      await vi.waitFor(async () => expect(await inner.get(WEB_SEARCH_LEASE_KEY)).toBeNull(), { timeout: 2_000 });
      expect(calls.compareAndSet).toBe(0);
      expect(calls.get).toBe(2);
    }, 10_000);
  });
});

describe("a scheduled check of a stored trip (#10's watcher)", () => {
  function scheduledAt(now: Date, budget: Budget, reports: ReportStore = new MemoryReportStore()) {
    const net = network();
    const gate = makeValhallaGate(new MemorySlotStore());
    return makeCommuteCheck({ fetch: net.fetch, now: () => now, gate: () => gate, budget: () => budget, reports: () => reports, muse: MUSE_OFF });
  }

  it("reaches admission with no address, so it counts against the daily cap only", async () => {
    const budget = openBudget();
    const admit = vi.spyOn(budget, "admit");
    const { checkTrip } = scheduledAt(NO_ADVISORY, budget);
    expect(await checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: Date.now() + 20_000 })).toEqual({ ok: true, kind: "go" });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0][0]).toBeNull();
    expect(admit.mock.calls[0][2]).toBe(COMMUTE_RESERVE_MICROS);
  });

  it("runs when every address's limit is used up", async () => {
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 1 });
    const check = scheduledAt(NO_ADVISORY, budget);
    expect((await check.POST(real())).status).toBe(200);
    expect((await check.POST(real())).status).toBe(429);
    const noAddress = () => new Request("http://localhost/api/commute", { method: "POST", body: JSON.stringify({ mode: "real", from: BANILAD, to: IT_PARK }) });
    expect((await check.POST(noAddress())).status).toBe(200);
    expect((await check.POST(noAddress())).status).toBe(429);
    expect(await check.checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: Date.now() + 20_000 })).toEqual({ ok: true, kind: "go" });
  });

  it("gives no answer when the daily cap refuses it", async () => {
    const budget = openBudget();
    // An open reservation of the whole $10 day: nothing is left for a check.
    expect((await budget.admit("192.0.2.9", NO_ADVISORY, 10_000_000)).ok).toBe(true);
    const check = scheduledAt(NO_ADVISORY, budget);
    expect((await check.POST(real())).status).toBe(503);
    expect(await check.checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: Date.now() + 20_000 })).toEqual({ ok: false, status: 503 });
  });

  it("gives no answer when the report store can't be read", async () => {
    const reports = new MemoryReportStore();
    reports.recent = async () => {
      throw new Error("store down");
    };
    const { checkTrip } = scheduledAt(NO_ADVISORY, openBudget(), reports);
    expect(await checkTrip({ from: BANILAD, to: IT_PARK }, { deadline: Date.now() + 20_000 })).toEqual({ ok: false, status: 503 });
  });

  it("refuses a stored trip outside Metro Cebu without asking admission", async () => {
    const budget = openBudget();
    const admit = vi.spyOn(budget, "admit");
    const { checkTrip } = scheduledAt(NO_ADVISORY, budget);
    expect(await checkTrip({ from: BANILAD, to: { lat: 35.68, lon: 139.76 } }, { deadline: Date.now() + 20_000 })).toEqual({ ok: false, status: 400 });
    expect(admit).not.toHaveBeenCalled();
  });
});
