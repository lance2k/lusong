import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FEED_URL } from "./advisory";
import { createBudget, MemoryBudgetStore, type Budget } from "./budget";
import { ADVISORY_CACHE_MS, COMMUTE_RESERVE_MICROS, makeCommuteHandler, ROUTE_CACHE_MS, UNREADABLE_RETRY_MS } from "./commute-handler";
import { scenariosFor, type DemoTripId } from "./samples";
import { cutEnd, cutStart, derivedReply } from "../test/valhalla-derived";
import { CAP_EDITS, CV_GFA5, FEED, feedWith, SAVED } from "../test/pagasa-fixtures";
import { makeValhallaGate, MemorySlotStore, VALHALLA_URL, type SlotStore } from "./router";
import { MemoryReportStore, UpstashReportStore, type ReportStore, type StoredPhotoReport } from "./report-store";
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
  /** Hold the plain route's reply this long; a detour that "hangs" answers only when its own timeout aborts it. */
  plainDelayMs?: number;
  detourHangs?: boolean;
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
      if (opts.valhalla === "down") throw new TypeError("fetch failed");
      const sent = JSON.parse(String(init!.body));
      const from = `${sent.locations[0].lat},${sent.locations[0].lon}`;
      if (!sent.exclude_polygons) {
        if (opts.plainDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.plainDelayMs));
        return new Response(opts.plainReply ?? ROUTES[from], { status: 200 });
      }
      if (opts.detourHangs) {
        const signal = init!.signal!;
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
      if (opts.detour === "down") throw new TypeError("fetch failed");
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
  timing?: Parameters<typeof makeCommuteHandler>[0]["timing"],
) {
  const net = network(opts);
  const gate = makeValhallaGate(store);
  const handler = makeCommuteHandler({ fetch: net.fetch, now: () => now, gate: () => gate, budget: () => budget, reports: () => reports, timing });
  return { handler, ...net };
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
    photoHash: "a".repeat(64),
    ...overrides,
  };
}

describe("a real commute check (#6)", () => {
  it("a real commute check uses a stored real report and never a sample", async () => {
    const store = new MemoryReportStore();
    const flooded = storedReport(NO_ADVISORY);
    await store.save(flooded);
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
    await store.save(far);
    await store.save(near);
    const { handler } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store);
    const body = await (await handler(real())).json();
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual([near.id]);
    expect(JSON.stringify(body)).not.toContain("123.9147");
  });

  it("a demo check never uses a real report, and never reads the store", async () => {
    const store = new MemoryReportStore();
    await store.save(storedReport(NO_ADVISORY));
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
    await store.save(storedReport(new Date(), { receivedAt: new Date(Date.now() - 40 * 60_000).toISOString() }));
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

describe("one deadline for the whole commute check (route maxDuration 60 s)", () => {
  /** Scaled down from 50 s, 5 s and 2 s so the test runs in seconds. */
  const timing = { budgetMs: 2_500, storeCallMs: 200, responseMs: 100 };

  it("a slow plain route, then a detour that never answers: no answer, within the budget", async () => {
    const store = new MemoryReportStore();
    await store.save(storedReport(NO_ADVISORY));
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, { plainDelayMs: 1_200, detourHangs: true }, new MemorySlotStore(), openBudget(), store, timing);
    const started = Date.now();
    const res = await handler(real());
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.answer).toBeUndefined();
    expect(body.routing).toBe("out_of_time");
    expect(valhallaCalls()).toHaveLength(2);
  }, 30_000);

  it("a demo check's detour that never answers is cut off the same way", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { plainDelayMs: 1_200, detourHangs: true }, new MemorySlotStore(), openBudget(), new MemoryReportStore(), timing);
    const started = Date.now();
    const res = await handler(demo("banilad-itpark", "flooded"));
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
  }, 30_000);

  it("a report store that never answers: no answer, within the budget, and Valhalla isn't asked", async () => {
    const store = new MemoryReportStore();
    store.recent = () => new Promise(() => {});
    const { handler, valhallaCalls } = handlerAt(NO_ADVISORY, {}, new MemorySlotStore(), openBudget(), store, timing);
    const started = Date.now();
    const res = await handler(real());
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(res.status).toBe(503);
    expect((await res.json()).answer).toBeUndefined();
    expect(valhallaCalls()).toHaveLength(0);
  }, 10_000);

  it("the real budget leaves the route's 60 s limit room for the settle and the response", async () => {
    const { COMMUTE_TIMING } = await import("./commute-handler");
    // The route module imports through the "@/" alias, which vitest doesn't resolve, so its limit is read from source.
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/commute/route.ts", "utf8"))?.[1]);
    expect(maxDuration).toBe(60);
    expect(COMMUTE_TIMING.budgetMs).toBeLessThan(maxDuration * 1_000);
    expect(COMMUTE_TIMING.storeCallMs).toBeGreaterThanOrEqual(5_000);
  });
});
