import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Point } from "../lib/answer";
import { boxAround } from "../lib/detour";
import { USER_AGENT } from "../lib/advisory";
import { fetchRoute, makeValhallaGate, MemorySlotStore, VALHALLA_CLIENT_ID, VALHALLA_URL } from "../lib/router";
import { DEMO_TRIPS, SAMPLE_SPECS, type DemoTripId } from "../lib/samples";

const PROBES: Record<string, { trip: DemoTripId; around: Point; file: string }> = {
  /** The Mabolo "flooded" scenario's detour: the box around its one counting blocker. */
  "mabolo-flooded": {
    trip: "mabolo-cbp",
    around: SAMPLE_SPECS.find((s) => s.id === "sample-quiapo-2024-waders")!.at,
    file: "mabolo-cbp-excluded",
  },
  /** A box around IT Park itself, so no route can reach it: Valhalla's real "no route" reply. */
  "no-route": { trip: "banilad-itpark", around: DEMO_TRIPS["banilad-itpark"].to, file: "banilad-itpark-destination-excluded" },
};

/**
 * Records one Valhalla /route reply with one box excluded, through the shared gate and the named User-Agent and client
 * id. Runs only with LUSONG_LIVE=1 and LUSONG_PROBE=detour:<name>; the request and the raw reply go to
 * test/fixtures/valhalla/<file>.request.json and <file>.json.
 */
const name = process.env.LUSONG_PROBE?.startsWith("detour:") ? process.env.LUSONG_PROBE.slice("detour:".length) : "";
it.skipIf(process.env.LUSONG_LIVE !== "1" || !(name in PROBES))("probe: Valhalla route with one blocked spot excluded", async () => {
  const probe = PROBES[name];
  const trip = DEMO_TRIPS[probe.trip];
  const recording: typeof fetch = async (url, init) => {
    writeFileSync(`test/fixtures/valhalla/${probe.file}.request.json`, JSON.stringify(JSON.parse(String(init!.body)), null, 1));
    const res = await fetch(url, init);
    writeFileSync(`test/fixtures/valhalla/${probe.file}.json`, await res.clone().text());
    console.log(`probe ${name}: HTTP ${res.status} at ${new Date().toISOString()}`);
    return res;
  };
  const result = await fetchRoute(
    { from: trip.from, to: trip.to, excludePolygons: [boxAround(probe.around)] },
    { fetch: recording, gate: makeValhallaGate(new MemorySlotStore()) },
  );
  console.log(`probe ${name}:`, JSON.stringify(result.ok ? { lengthKm: result.route.lengthKm, timeMin: result.route.timeMin, streets: result.route.streets } : result));
  expect(result.ok || result.reason === "no_route").toBe(true);
}, 30_000);

/** The Banilad "flooded" sample's pin, the probe's route midpoint: its OSM way and street from Valhalla /locate. */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_PROBE !== "detour-pin")("probe: Valhalla /locate for the Banilad detour pin", async () => {
  const body = { locations: [{ lat: 10.335398, lon: 123.910908 }], costing: "motorcycle", verbose: true };
  expect(await makeValhallaGate(new MemorySlotStore()).acquire()).toBe("ok");
  const res = await fetch(`${VALHALLA_URL}/locate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "X-Client-Id": VALHALLA_CLIENT_ID },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  writeFileSync("test/fixtures/valhalla/locate-detour-pin.request.json", JSON.stringify(body, null, 1));
  writeFileSync("test/fixtures/valhalla/locate-detour-pin.json", await res.text());
  expect(res.status).toBe(200);
}, 30_000);
