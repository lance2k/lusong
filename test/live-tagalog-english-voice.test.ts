import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { costMicros, createBudget, MemoryBudgetStore, type Budget, type MeteredUsage } from "../lib/budget";
import { MemoryReportStore } from "../lib/report-store";
import { makeVoiceReportHandler, VOICE_RESERVE_MICROS } from "../lib/voice-report-handler";

/**
 * Tagalog and English notes through the whole voice handler with real Meta (Voice Transcribe, then Muse Spark on the
 * words), a memory store and a memory budget: nothing reaches production. The notes are synthetic speech (Gemini TTS)
 * written as the page's 16 kHz mono WAV, read from LUSONG_TLEN_AUDIO/<id>.wav; they are not in the repo. Each note is
 * sent LUSONG_LIVE_DRAWS times (default 2), each draw with a fresh store so the second isn't answered as a duplicate.
 * Runs only with LUSONG_LIVE=1; results go to LUSONG_LIVE_OUT as JSON, since vitest hides passing output.
 */
const OUT = process.env.LUSONG_LIVE_OUT ?? "live-tagalog-english-voice.json";
const DRAWS = Number(process.env.LUSONG_LIVE_DRAWS ?? 2);
if (!Number.isInteger(DRAWS) || DRAWS < 1) throw new Error("LUSONG_LIVE_DRAWS must be a whole number of at least 1");

const NOTES = [
  {
    id: "tl1",
    language: "tl",
    street: "España",
    pin: { lat: 14.6096, lon: 120.9894 },
    text: "Baha hanggang tuhod dito sa España Boulevard, malapit sa UST. Hindi madaanan ng maliliit na sasakyan.",
    expect: { depth: "knee_or_deeper", passable: "no" },
  },
  {
    id: "tl2",
    language: "tl",
    street: "Taft",
    pin: { lat: 14.5636, lon: 120.9946 },
    text: "Gutter-deep lang ang baha dito sa Taft Avenue, malapit sa Vito Cruz. Nakakadaan pa ang mga kotse at motor.",
    expect: { depth: "below_knee", passable: "yes" },
  },
  {
    id: "en1",
    language: "en",
    street: "Aurora",
    pin: { lat: 14.6195, lon: 121.053 },
    text: "Water is waist-deep on Aurora Boulevard near Cubao. Cars can't pass.",
    expect: { depth: "knee_or_deeper", passable: "no" },
  },
  {
    id: "en2",
    language: "en",
    street: "Commonwealth",
    pin: { lat: 14.6536, lon: 121.053 },
    text: "Flood is only gutter-deep on Commonwealth Avenue near Philcoa. All vehicles can still pass.",
    expect: { depth: "below_knee", passable: "yes" },
  },
] as const;

function post(audio: Uint8Array, note: (typeof NOTES)[number]): Request {
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(audio)], "note.wav", { type: "audio/wav" }));
  form.set("lat", String(note.pin.lat));
  form.set("lon", String(note.pin.lon));
  form.set("language", note.language);
  return new Request("http://localhost/api/report/voice", { method: "POST", body: form, headers: { "x-forwarded-for": "192.0.2.1" } });
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

interface MetaCall {
  path: string;
  model: string | null;
  status: number;
  ms: number;
  replyKeys: string[];
  transcript?: unknown;
  audioDurationMs?: unknown;
  content?: unknown;
  usage?: unknown;
}

/** Every request to api.meta.ai, recorded on the way back: the endpoint, the model asked for, and the reply. Never headers. */
function recordMeta(calls: MetaCall[]): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.meta.ai/")) return real(input, init);
    let model: string | null = null;
    if (typeof init?.body === "string") model = (JSON.parse(init.body) as { model?: string }).model ?? null;
    else if (init?.body instanceof FormData) {
      const settings = init.body.get("request");
      if (settings instanceof Blob) model = (JSON.parse(await settings.text()) as { model?: string }).model ?? null;
    }
    const started = Date.now();
    const res = await real(input, init);
    const reply = (await res
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    const choices = reply?.choices as { message?: { content?: string } }[] | undefined;
    calls.push({
      path: new URL(url).pathname,
      model,
      status: res.status,
      ms: Date.now() - started,
      replyKeys: reply ? Object.keys(reply) : [],
      transcript: reply?.transcript,
      audioDurationMs: reply?.audioDurationMs,
      content: choices?.[0]?.message?.content,
      usage: reply?.usage,
    });
    return res;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

it.skipIf(process.env.LUSONG_LIVE !== "1")(
  "live: two Tagalog and two English synthetic notes, each sent twice",
  async () => {
    const results: Record<string, unknown>[] = [];
    for (const note of NOTES) {
      const audio = new Uint8Array(readFileSync(join(process.env.LUSONG_TLEN_AUDIO!, `${note.id}.wav`)));
      for (let draw = 1; draw <= DRAWS; draw++) {
        const store = new MemoryReportStore();
        const settled: { usage: MeteredUsage; micros: number }[] = [];
        const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: (2 * VOICE_RESERVE_MICROS) / 1e6, ipLimit: 10 });
        const metered: Budget = {
          admit: (...a) => budget.admit(...a),
          settle: async (admission, usage, succeeded) => {
            settled.push({ usage, micros: costMicros(usage) });
            await budget.settle(admission, usage, succeeded);
          },
        };
        const handler = makeVoiceReportHandler({
          budget: () => metered,
          store: () => store,
          gate: () => ({ acquire: async () => "ok" }),
          // No street lookup: the report keeps the pin alone.
          fetch: (async () => Response.json([])) as unknown as typeof fetch,
        });
        const calls: MetaCall[] = [];
        const restore = recordMeta(calls);
        const started = Date.now();
        let res: Response;
        try {
          res = await handler(post(audio, note));
        } finally {
          restore();
        }
        const ms = Date.now() - started;
        const body = await res.json();
        const stored = await store.recent(new Date());
        const claim = (stored[0] as { claim?: { place: string | null; depth: string; passable: string } } | undefined)?.claim ?? null;
        const match =
          claim !== null &&
          claim.place !== null &&
          fold(claim.place).includes(fold(note.street)) &&
          claim.depth === note.expect.depth &&
          claim.passable === note.expect.passable;
        results.push({
          note: note.id,
          language: note.language,
          draw,
          said: note.text,
          status: res.status,
          ms,
          route: calls.map((c) => `${c.path} ${c.model}`),
          calls,
          claim,
          expect: { place: note.street, ...note.expect },
          match,
          metered: settled[0] ?? null,
          body,
        });
        writeFileSync(OUT, JSON.stringify({ reserveMicros: VOICE_RESERVE_MICROS, results }, null, 2));
      }
    }
    // The run itself must have worked; whether each claim matched is the measurement, read from LUSONG_LIVE_OUT.
    expect(results).toHaveLength(NOTES.length * DRAWS);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect((r.body as { duplicate: boolean; stored: unknown }).duplicate).toBe(false);
      expect((r.body as { stored: unknown }).stored).toBe(true);
      expect(r.route).toEqual(["/v1/asr/transcribe muse-voice-transcribe-1.0", "/v1/chat/completions muse-spark-1.3"]);
      expect(r.metered).not.toBeNull();
    }
  },
  600_000,
);
