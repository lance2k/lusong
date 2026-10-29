import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FEED_URL } from "./advisory";
import { createBudget, MemoryBudgetStore, type Budget } from "./budget";
import { ADVISORY_CACHE_MS, COMMUTE_RESERVE_MICROS, makeCommuteHandler, ROUTE_CACHE_MS } from "./commute-handler";
import { makeValhallaGate, MemorySlotStore, VALHALLA_URL, type SlotStore } from "./router";

const read = (path: string) => readFileSync(path, "utf8");
const FEED = read("test/fixtures/pagasa/feed-2026-10-29.xml");
const CV_GFA5_URL = "https://publicalert.pagasa.dost.gov.ph/output/gfa/f1232c02-5d52-4786-90aa-46865ab991a4.cap";
const CV_GFA5 = read("test/fixtures/pagasa/central-visayas-gfa-2026-10-25T1727.cap");
const ROUTES: Record<string, string> = {
  "10.346,123.911": read("test/fixtures/valhalla/banilad-itpark-plain.json"),
  "10.3143,123.9147": read("test/fixtures/valhalla/mabolo-cbp-plain.json"),
};

/** 20:00 PHT on 2026-10-25: the Central Visayas advisory sent at 17:27 is active. */
const ADVISORY_ACTIVE = new Date("2026-10-25T20:00:00+08:00");
/** Noon on 2026-10-29: no GFA entry in the feed's last 24 h, so no advisory. */
const NO_ADVISORY = new Date("2026-10-29T12:00:00+08:00");

type Options = { valhalla?: "ok" | "down"; feed?: "ok" | "down" };

/** PAGASA and Valhalla faked at fetch with their saved records; any other CAP link fails as a dropped connection. */
function network(opts: Options = {}) {
  const calls: { url: string; at: number; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, at: performance.now(), body: init?.body ? String(init.body) : undefined });
    if (u === FEED_URL) {
      if (opts.feed === "down") throw new TypeError("fetch failed");
      return new Response(FEED);
    }
    if (u === CV_GFA5_URL) return new Response(CV_GFA5);
    if (u === `${VALHALLA_URL}/route`) {
      if (opts.valhalla === "down") throw new TypeError("fetch failed");
      const from = JSON.parse(String(init!.body)).locations[0];
      return new Response(ROUTES[`${from.lat},${from.lon}`], { status: 200 });
    }
    throw new TypeError("fetch failed");
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls, valhallaCalls: () => calls.filter((c) => c.url.startsWith(VALHALLA_URL)) };
}

const openBudget = () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 100 });

function handlerAt(now: Date, opts: Options = {}, store: SlotStore = new MemorySlotStore(), budget: Budget = openBudget()) {
  const net = network(opts);
  const gate = makeValhallaGate(store);
  const handler = makeCommuteHandler({ fetch: net.fetch, now: () => now, gate: () => gate, budget: () => budget });
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
    { trip: "banilad-itpark", scenario: "flooded", now: NO_ADVISORY, rain: false, answer: "wait" },
    { trip: "banilad-itpark", scenario: "flooded", now: ADVISORY_ACTIVE, rain: false, answer: "wait" },
    { trip: "banilad-itpark", scenario: "unclear", now: NO_ADVISORY, rain: false, answer: "no_one_knows" },
    { trip: "mabolo-cbp", scenario: "none", now: NO_ADVISORY, rain: false, answer: "go" },
    { trip: "mabolo-cbp", scenario: "none", now: NO_ADVISORY, rain: true, answer: "no_one_knows" },
    { trip: "mabolo-cbp", scenario: "flooded", now: ADVISORY_ACTIVE, rain: true, answer: "wait" },
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
    expect(body.answer.kind).toBe("wait");
    expect(body.answer.reason).toContain("M.J. Cuenco Avenue at H. Joaquino Street, Mabolo");
    expect(body.answer.thin).toBe("This answer rests on one report.");
  });

  it("an unreadable advisory feed is said so on the page and counts as active", async () => {
    const { handler } = handlerAt(NO_ADVISORY, { feed: "down" });
    const body = await (await handler(demo("banilad-itpark", "none"))).json();
    expect(body.advisory.state).toBe("unreadable");
    expect(body.advisory.note).toBe("Lusong couldn't read PAGASA's flood advisory feed, so it counts an advisory as active.");
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
    await handler(demo("banilad-itpark", "flooded"));
    expect(net.valhallaCalls()).toHaveLength(1);
    expect(ROUTE_CACHE_MS).toBe(10 * 60_000);
    now = new Date(NO_ADVISORY.getTime() + ROUTE_CACHE_MS);
    await handler(demo("banilad-itpark", "none"));
    expect(net.valhallaCalls()).toHaveLength(2);
  });

  it("reuses a readable PAGASA reading for 5 minutes, but asks again after an unreadable one", async () => {
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

    const down = network({ feed: "down" });
    const flaky = makeCommuteHandler({ fetch: down.fetch, now: () => NO_ADVISORY, gate: () => gate, budget: openBudget });
    await flaky(demo("banilad-itpark", "none"));
    await flaky(demo("banilad-itpark", "none"));
    expect(down.calls.filter((c) => c.url === FEED_URL)).toHaveLength(2);
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

  it("only demo checks are taken: anything else is refused before any request, so samples never reach a real check", async () => {
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
      for (const trip of ["banilad-itpark", "mabolo-cbp"]) {
        for (const scenario of ["none", "flooded", "unclear"]) {
          for (const rain of [false, true]) {
            const text = await (await handlerAt(now).handler(demo(trip, scenario, rain))).text();
            expect(text.toLowerCase()).not.toContain("passable to all types of vehicles");
            expect(text).not.toMatch(/\bPATV\b/);
          }
        }
      }
    }
  });
});
