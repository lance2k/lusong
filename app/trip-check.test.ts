import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEED_URL } from "../lib/advisory";
import { createBudget, MemoryBudgetStore } from "../lib/budget";
import { makeCommuteHandler } from "../lib/commute-handler";
import { MemoryReportStore, type StoredReport } from "../lib/report-store";
import { makeValhallaGate, MemorySlotStore, VALHALLA_URL } from "../lib/router";
import { FEED, SAVED } from "../test/pagasa-fixtures";
import { checkRequest } from "./trip";

const PLAIN = readFileSync("test/fixtures/valhalla/banilad-itpark-plain.json", "utf8");
const EXCLUDED = readFileSync("test/fixtures/valhalla/banilad-itpark-excluded.json", "utf8");
/** Noon on 2026-10-29: no GFA entry in the saved feed's last 24 h. */
const NO_ADVISORY = new Date("2026-10-29T12:00:00+08:00");
const TRIP = { home: { lat: 10.346, lon: 123.911 }, work: { lat: 10.3307, lon: 123.9058 } };

/** PAGASA and Valhalla faked at fetch with their saved records; nothing leaves the test. */
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u === FEED_URL) return new Response(FEED);
  if (u in SAVED) return new Response(SAVED[u]);
  if (u === `${VALHALLA_URL}/route`) return new Response(JSON.parse(String(init!.body)).exclude_polygons ? EXCLUDED : PLAIN);
  throw new TypeError("fetch failed");
}) as typeof fetch;

function handlerWith(store: MemoryReportStore) {
  const gate = makeValhallaGate(new MemorySlotStore());
  const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 100 });
  return makeCommuteHandler({ fetch: fakeFetch, now: () => NO_ADVISORY, gate: () => gate, budget: () => budget, reports: () => store });
}

const post = (body: unknown) =>
  new Request("http://localhost/api/commute", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
  });

/** A real NPLV photo report on the trip's plain route, so the check reads the store and asks for a detour. */
const flooded = (): StoredReport => ({
  id: randomUUID(),
  kind: "photo",
  at: { lat: 10.335398, lon: 123.910908 },
  wayId: null,
  place: "Governor M. Cuenco Avenue",
  receivedAt: new Date(NO_ADVISORY.getTime() - 40 * 60_000).toISOString(),
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
  photoHash: "b".repeat(64),
});

describe("checking your own trip", () => {
  it("the page sends the trip only as a real check's start and end, with the rain tap", () => {
    expect(checkRequest(TRIP, true)).toEqual({ mode: "real", from: TRIP.home, to: TRIP.work, rainingHere: true });
  });

  it("after the page's check of a saved trip, the report store holds nothing about the trip", async () => {
    const store = new MemoryReportStore({ now: () => NO_ADVISORY.getTime() });
    await store.save(flooded());
    const before = store.dump();
    const res = await handlerWith(store)(post(checkRequest(TRIP, false)));
    expect(res.status).toBe(200);
    expect((await res.json()).answer.kind).toBe("go_another_way");
    const after = store.dump();
    expect(after).toEqual(before);
    for (const coordinate of ["10.346", "123.911", "10.3307", "123.9058"]) expect(JSON.stringify(after)).not.toContain(coordinate);
  });
});

describe("what the map draws", () => {
  it("the answer carries the route's and the detour's lines, and each report's spot for its pin", async () => {
    const store = new MemoryReportStore({ now: () => NO_ADVISORY.getTime() });
    const report = flooded();
    await store.save(report);
    const body = await (await handlerWith(store)(post(checkRequest(TRIP, false)))).json();
    expect(body.route.line.length).toBeGreaterThan(1);
    expect(body.detour.line.length).toBeGreaterThan(1);
    expect(body.reports).toEqual([expect.objectContaining({ id: report.id, at: { lat: 10.335398, lon: 123.910908 }, age: expect.any(String) })]);
  });
});
