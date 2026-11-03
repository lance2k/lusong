import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costMicros } from "../lib/budget";
import { fold } from "../lib/built-in-places";
import { MetaApiError, Meter, OutputCapError } from "../lib/meta";
import { makePhotonGate, MemoryWaitQueue, PlaceCache, type Place } from "../lib/places";
import { MemorySlotStore } from "../lib/router";
import { TRIP_BOUND } from "../lib/trip-bound";
import { readTripText, resolveTrip, TRIP_TEXT_RESERVE_MICROS, tripTextOf } from "../lib/trip-text";

/**
 * The S5 measurement: typed trips through the real Muse Spark 1.3 call and the real Photon, one after another, each
 * end's candidates matched against the name expected. PAID: about $0.02 a text worst case (TRIP_TEXT_RESERVE_MICROS),
 * and the run stops before a text that could take the total past LUSONG_TRIP_TEXT_MAX_USD (default $0.25).
 *
 *   LUSONG_LIVE=1 [LUSONG_TRIP_TEXTS=test/fixtures/trip-text/measure-10.json] [LUSONG_LIVE_OUT=live-trip-text.json] \
 *     withenv pnpm vitest run test/live-trip-text.test.ts
 *
 * MODEL_API_KEY must be in the environment. The texts file is a JSON list of { text, from, to, leaveAt }, where from and
 * to are the names expected in a candidate's "name, area" (accents and case ignored). The output names each text by its
 * place in the list and holds only the place search's names, the matches and the usage: never the typed text or the
 * model's own strings.
 */
const FILE = process.env.LUSONG_TRIP_TEXTS ?? "test/fixtures/trip-text/measure-10.json";
const OUT = process.env.LUSONG_LIVE_OUT ?? "live-trip-text.json";
const MAX_MICROS = Math.round(Number(process.env.LUSONG_TRIP_TEXT_MAX_USD ?? "0.25") * 1e6);

interface Case {
  text: string;
  from: string;
  to: string;
  leaveAt: string | null;
}

const label = (p: Place) => (p.area ? `${p.name}, ${p.area}` : p.name);
const matches = (places: Place[], expected: string) => places.map((p) => fold(label(p)).includes(fold(expected)));

it.skipIf(process.env.LUSONG_LIVE !== "1")(
  "live: typed trips read by Muse Spark and resolved by the place search",
  async () => {
    const cases = JSON.parse(readFileSync(FILE, "utf8")) as Case[];
    expect(cases.length).toBeGreaterThan(0);
    const places = { fetch: globalThis.fetch.bind(globalThis), gate: makePhotonGate(new MemorySlotStore(), new MemoryWaitQueue()), cache: new PlaceCache(), bound: TRIP_BOUND };
    const rows: Record<string, unknown>[] = [];
    let spentMicros = 0;
    for (const [i, c] of cases.entries()) {
      if (spentMicros + TRIP_TEXT_RESERVE_MICROS > MAX_MICROS) {
        rows.push({ n: i + 1, skipped: "spend cap" });
        continue;
      }
      const text = tripTextOf(c.text);
      if (!text) {
        rows.push({ n: i + 1, skipped: "text outside 3–160 characters" });
        continue;
      }
      const meter = new Meter();
      const started = Date.now();
      const row: Record<string, unknown> = { n: i + 1, expected: { from: c.from, to: c.to, leaveAt: c.leaveAt } };
      try {
        const reading = await readTripText(text, { meter, deadline: Date.now() + 25_000 });
        row.readMs = Date.now() - started;
        row.endsRead = { from: reading.from !== null, to: reading.to !== null };
        row.leaveAt = reading.leaveAt;
        row.leaveAtMatch = reading.leaveAt === c.leaveAt;
        const reply = await resolveTrip(reading, places);
        if (reply.status === "ok") {
          row.from = reply.from.map(label);
          row.to = reply.to.map(label);
          const f = matches(reply.from, c.from);
          const t = matches(reply.to, c.to);
          row.match = { fromTop: f[0], fromAny: f.some(Boolean), toTop: t[0], toAny: t.some(Boolean) };
        } else {
          row.failed = reply.reason;
        }
      } catch (err) {
        row.error = err instanceof OutputCapError ? "output cap" : err instanceof MetaApiError ? err.message : err instanceof Error ? err.name : "error";
      }
      const usage = meter.usage();
      spentMicros += costMicros(usage);
      row.usage = { inputTokens: usage.museInputTokens, outputTokens: usage.museOutputTokens, complete: usage.complete, micros: costMicros(usage) };
      rows.push(row);
    }
    const resolved = rows.filter((r) => (r.match as { fromAny?: boolean; toAny?: boolean } | undefined)?.fromAny && (r.match as { toAny?: boolean }).toAny).length;
    const top = rows.filter((r) => (r.match as { fromTop?: boolean; toTop?: boolean } | undefined)?.fromTop && (r.match as { toTop?: boolean }).toTop).length;
    const summary = {
      texts: cases.length,
      bothEndsInCandidates: resolved,
      bothEndsFirstCandidate: top,
      leaveAtRight: rows.filter((r) => r.leaveAtMatch === true).length,
      spentMicros,
      spentUsd: spentMicros / 1e6,
      reserveMicrosPerText: TRIP_TEXT_RESERVE_MICROS,
    };
    writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  },
  600_000,
);
