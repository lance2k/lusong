import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createBudget, MemoryBudgetStore } from "../lib/budget";
import { MemoryReportStore } from "../lib/report-store";
import { makeVoiceReportHandler, VOICE_RESERVE_MICROS } from "../lib/voice-report-handler";
import { encodeWav, VOICE_SAMPLE_RATE } from "../lib/wav";

/**
 * Bisaya notes through the whole voice handler with real Meta (Muse Spark 1.2 on the audio), a memory store and a
 * memory budget: nothing reaches production. The owner's clip is read from LUSONG_BISAYA_CLIP and is not in the repo.
 * Runs only with LUSONG_LIVE=1; results go to LUSONG_LIVE_OUT as JSON, since vitest hides passing output.
 */
const OUT = process.env.LUSONG_LIVE_OUT ?? "live-bisaya-voice.json";
/** Talamban, Cebu City. */
const PIN = { lat: 10.3705, lon: 123.9148 };

function post(audio: Uint8Array): Request {
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(audio)], "note.wav", { type: "audio/wav" }));
  form.set("lat", String(PIN.lat));
  form.set("lon", String(PIN.lon));
  form.set("language", "ceb");
  return new Request("http://localhost/api/report/voice", { method: "POST", body: form, headers: { "x-forwarded-for": "192.0.2.1" } });
}

it.skipIf(process.env.LUSONG_LIVE !== "1")(
  "live: the owner's Bisaya clip and 10 s of silence",
  async () => {
    const store = new MemoryReportStore();
    const handler = makeVoiceReportHandler({
      budget: () => createBudget({ store: new MemoryBudgetStore(), budgetUsd: (10 * VOICE_RESERVE_MICROS) / 1e6, ipLimit: 10 }),
      store: () => store,
      gate: () => ({ acquire: async () => "ok" }),
      // No street lookup: the report keeps the pin alone.
      fetch: (async () => Response.json([])) as unknown as typeof fetch,
    });
    const results: Record<string, unknown>[] = [];
    for (const [name, audio] of [
      ["owner's clip", new Uint8Array(readFileSync(process.env.LUSONG_BISAYA_CLIP!))],
      ["10 s of silence", encodeWav(new Float32Array(VOICE_SAMPLE_RATE * 10), VOICE_SAMPLE_RATE)],
    ] as const) {
      const started = Date.now();
      const res = await handler(post(audio));
      results.push({ name, status: res.status, ms: Date.now() - started, body: await res.json() });
    }
    const stored = await store.recent(new Date());
    writeFileSync(OUT, JSON.stringify({ results, stored }, null, 2));
    expect(results[0].status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ claim: { place: "Talamban", depth: "knee_or_deeper", passable: "no" } });
    expect((results[0].body as { report: { role: string } }).report.role).toBe("block");
    expect(results[1].status).toBe(422);
  },
  240_000,
);
