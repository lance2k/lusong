import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costMicros, createBudget, MemoryBudgetStore, type Budget } from "./budget";
import { MemoryReportStore, UpstashReportStore, type ReportStore } from "./report-store";
import type { ValhallaGate } from "./router";
import { VOICE_CLAIM_INPUT_TOKEN_BOUND, VOICE_CLAIM_MAX_COMPLETION_TOKENS } from "./voice-claim";
import { makeVoiceReportHandler, VOICE_RESERVE_MICROS as V, type VoiceTiming } from "./voice-report-handler";
import { encodeWav, VOICE_SAMPLE_RATE } from "./wav";

const LOCATE = JSON.parse(readFileSync("test/fixtures/valhalla/locate-sample-pins.json", "utf8"));
/** The first sample pin, on Governor M. Cuenco Avenue, Apas (way 1116002958). */
const PIN = { lat: 10.338566, lon: 123.911461 };
const NOW = new Date("2026-10-30T01:00:00Z");
const TAGALOG = "Baha dito sa Cuenco Avenue, hanggang tuhod na, hindi na madaanan ng motor.";
const CLAIM = { place: "Cuenco Avenue", depth: "knee_or_deeper", passable: "no" };

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";

/** `seconds` of a 440 Hz tone, as the page would encode it; `pitch` makes two notes differ. */
function note(seconds = 5, pitch = 440): Uint8Array<ArrayBuffer> {
  const samples = Float32Array.from({ length: VOICE_SAMPLE_RATE * seconds }, (_, i) => 0.3 * Math.sin((2 * Math.PI * pitch * i) / VOICE_SAMPLE_RATE));
  return encodeWav(samples, VOICE_SAMPLE_RATE);
}

function post(opts: { audio?: Uint8Array; lat?: unknown; lon?: unknown; language?: string; ip?: string } = {}): Request {
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(opts.audio ?? note())], "note.wav", { type: "audio/wav" }));
  form.set("lat", String(opts.lat ?? PIN.lat));
  form.set("lon", String(opts.lon ?? PIN.lon));
  if (opts.language) form.set("language", opts.language);
  return new Request("http://localhost/api/report/voice", { method: "POST", body: form, headers: { "x-forwarded-for": opts.ip ?? "192.0.2.1" } });
}

type Reply = (init: RequestInit) => Response | Promise<Response>;
const transcribed = (transcript: string): Reply => () => Response.json({ sessionId: "s", transcript, audioDurationMs: 5_000, turns: [] });
const claimed = (claim: object): Reply => () =>
  Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(claim) } }], usage: { prompt_tokens: 600, completion_tokens: 200 } });
/** A reply that never comes: the call ends only when its own timeout aborts it. */
const hangs: Reply = (init) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

/** Meta's Voice Transcribe and Muse Spark faked at fetch; the Upstash stand-in still gets real requests. */
function stubMeta(replies: { transcribe?: Reply; spark?: Reply } = {}) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (upstashUrl && String(url).startsWith(upstashUrl)) return realFetch(url, init);
      if (!String(url).startsWith("https://api.meta.ai/")) throw new TypeError("fetch failed");
      calls.push(String(url).replace("https://api.meta.ai/v1", ""));
      if (url.endsWith("/asr/transcribe")) return (replies.transcribe ?? transcribed(TAGALOG))(init);
      return (replies.spark ?? claimed(CLAIM))(init);
    }),
  );
  return calls;
}

const valhalla = () => vi.fn(async () => Response.json([LOCATE[0]])) as unknown as typeof fetch;
const open: ValhallaGate = { acquire: async () => "ok" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real budget on a memory ledger, with every admission and settle recorded. */
function meteredBudget(budgetMicros = 10 * V) {
  const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: budgetMicros / 1e6, ipLimit: 10 });
  const admits: number[] = [];
  const settles: { succeeded: boolean; seconds: number }[] = [];
  const budget: Budget = {
    admit: async (ip, now, reserve) => (admits.push(reserve!), real.admit(ip, now, reserve)),
    settle: async (admission, usage, succeeded) => (settles.push({ succeeded, seconds: usage.transcribeSeconds }), real.settle(admission, usage, succeeded)),
  };
  return { budget, admits, settles, real };
}

function handlerWith(opts: { store?: ReportStore | null; budget?: Budget; timing?: VoiceTiming; fetch?: typeof fetch } = {}) {
  const store = opts.store === undefined ? new MemoryReportStore() : opts.store;
  return makeVoiceReportHandler({
    budget: () => opts.budget ?? meteredBudget().budget,
    store: () => store,
    gate: () => open,
    fetch: opts.fetch ?? valhalla(),
    now: () => NOW,
    timing: opts.timing,
  });
}

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const stores: [string, () => ReportStore][] = [
  ["memory store", () => new MemoryReportStore()],
  ...(upstashUrl
    ? [["Upstash store", () => new UpstashReportStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [string, () => ReportStore]]
    : []),
];

describe.each(stores)("a Tagalog voice note on the %s, with Meta's API faked", (_name, makeStore) => {
  it("becomes a stored voice report with its claim and pin, and keeps no audio and no transcript", async () => {
    const calls = stubMeta();
    const store = makeStore();
    const res = await handlerWith({ store })(post());
    expect(res.status).toBe(200);
    expect(calls).toEqual(["/asr/transcribe", "/chat/completions"]);

    const [record] = await store.recent(NOW);
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: "voice",
      at: PIN,
      wayId: 1116002958,
      place: "Governor M. Cuenco Avenue",
      receivedAt: "2026-10-30T01:00:00.000Z",
      claim: CLAIM,
      audioHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(record)).not.toContain("hanggang");
  });
});

describe("what is stored and what the reporter is shown", () => {
  it("the memory store holds the record, the audio's hash and the index: nothing of the note itself", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    await handlerWith({ store })(post());
    const everything = store.dump();
    const [record] = await store.recent(NOW);
    expect(Object.keys(everything).sort()).toEqual([`lusong:report-voice:${(record as { audioHash: string }).audioHash}`, `lusong:report:${record.id}`, "lusong:reports"].sort());
    expect(JSON.stringify(everything)).not.toMatch(/hanggang|madaanan|RIFF/);
    // The note is 160 KB; what the store holds is the record, the id twice and the hash.
    expect(JSON.stringify(everything).length).toBeLessThan(1_000);
  });

  it("the response carries fixed sentences from the claim and the spoken place, never the transcript", async () => {
    stubMeta();
    const res = await handlerWith()(post());
    const body = await res.json();
    expect(body).toEqual({
      duplicate: false,
      stored: true,
      report: {
        id: expect.any(String),
        kind: "voice",
        place: "Governor M. Cuenco Avenue",
        saidPlace: "Cuenco Avenue",
        received: "30 Oct, 9:00 a.m. PHT",
        heard: "Lusong heard that the water is knee-deep or deeper and vehicles can't pass.",
        role: "block",
        counts: true,
        effect: expect.stringContaining("as not passable for the next 3 h"),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/hanggang|madaanan|Baha/);
  });

  it("a note saying the street is passable is stored, and the reporter is told it can't mark the street clear", async () => {
    stubMeta({ spark: claimed({ place: "", depth: "below_knee", passable: "yes" }) });
    const body = await (await handlerWith()(post())).json();
    expect(body.report).toMatchObject({ role: "neutral", saidPlace: null, heard: "Lusong heard that the water is below the knee and vehicles can pass." });
    expect(body.report.effect).toBe("Others will see this report, but a voice report can't mark a street clear: only a recent photo can.");
  });

  it("Voice Transcribe is asked for Tagalog and English", async () => {
    const sent: RequestInit[] = [];
    stubMeta({ transcribe: (init) => (sent.push(init), transcribed(TAGALOG)(init)) });
    await handlerWith()(post());
    const settings = JSON.parse(await ((sent[0].body as FormData).get("request") as Blob).text());
    expect(settings.languageBias).toEqual(["Tagalog", "English"]);
  });
});

describe("the same note sent again within 3 h", () => {
  it("is one report, transcribed and paid for once", async () => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const { budget, admits } = meteredBudget();
    const handler = handlerWith({ store, budget });
    const first = await (await handler(post())).json();
    const again = await (await handler(post())).json();
    expect(again).toMatchObject({ duplicate: true, stored: true, report: { id: first.report.id } });
    expect(calls).toHaveLength(2);
    expect(admits).toHaveLength(1);
    expect(await store.recent(NOW)).toHaveLength(1);
  });

  it("a different note is a new report", async () => {
    stubMeta();
    const store = new MemoryReportStore();
    const handler = handlerWith({ store });
    await handler(post());
    await handler(post({ audio: note(5, 300) }));
    expect(await store.recent(NOW)).toHaveLength(2);
  });
});

describe("refused before anything is spent: no reservation, no Meta call, nothing claimed", () => {
  /** A WAV whose header says 16 kHz mono 16-bit but is changed at one byte offset. */
  function edited(at: number, value: number, bytes: Uint8Array<ArrayBuffer> = note()): Uint8Array {
    const copy = new Uint8Array(bytes);
    new DataView(copy.buffer).setUint32(at, value, true);
    return copy;
  }
  /** encodeWav cuts at 30 s, so a longer note is written by hand: a 1 s note's header over `seconds` of silence. */
  function longNote(seconds: number): Uint8Array<ArrayBuffer> {
    const pcm = new Uint8Array(Math.round(seconds * VOICE_SAMPLE_RATE) * 2);
    const head = note(1).slice(0, 44);
    const out = new Uint8Array(44 + pcm.length);
    out.set(head);
    new DataView(out.buffer).setUint32(4, 36 + pcm.length, true);
    new DataView(out.buffer).setUint32(40, pcm.length, true);
    return out;
  }

  it.each([
    ["a 30.05 s note, small enough in bytes, read from its header", () => longNote(30.05), 413],
    ["a 31 s note, too large in bytes", () => longNote(31), 413],
    ["a note whose header says 1 s over 31 s of audio", () => edited(40, 32_000, longNote(31)), 413],
    ["a note at 44.1 kHz", () => edited(24, 44_100), 415],
    ["a stereo note", () => {
      const b = new Uint8Array(note());
      new DataView(b.buffer).setUint16(22, 2, true);
      return b;
    }, 415],
    ["a header that says 1 s over 5 s of audio", () => edited(40, 32_000), 400],
    ["a file that is not a WAV", () => new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg")).slice(0, 50_000), 400],
    ["a note under half a second", () => note(0.25), 400],
  ])("%s", async (_why, audio, status) => {
    const calls = stubMeta();
    const store = new MemoryReportStore();
    const { budget, admits } = meteredBudget();
    const res = await handlerWith({ store, budget })(post({ audio: audio() }));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(admits).toEqual([]);
    expect(calls).toEqual([]);
    expect(store.dump()).toEqual({});
  });

  it("an upload larger than 30 s of audio can be is refused from its declared length, before it is read", async () => {
    const calls = stubMeta();
    const { budget, admits } = meteredBudget();
    const big = new Request("http://localhost/api/report/voice", {
      method: "POST",
      body: new Uint8Array(10),
      headers: { "content-length": String(5 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" },
    });
    expect((await handlerWith({ budget })(big)).status).toBe(413);
    expect(admits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["no location", { lat: "", lon: "" }],
    ["a location in Metro Manila, outside Metro Cebu", { lat: 14.5547, lon: 121.0244 }],
  ])("%s", async (_why, pin) => {
    const calls = stubMeta();
    const { budget, admits } = meteredBudget();
    expect((await handlerWith({ budget })(post(pin))).status).toBe(400);
    expect(admits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a Bisaya note: refused while Bisaya is out, until the clip probe", async () => {
    const calls = stubMeta();
    const { budget, admits } = meteredBudget();
    const res = await handlerWith({ budget })(post({ language: "ceb" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Tagalog or English");
    expect(admits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("no report store: refused, nothing reserved", async () => {
    const calls = stubMeta();
    const { budget, admits } = meteredBudget();
    expect((await handlerWith({ store: null, budget })(post())).status).toBe(503);
    expect(admits).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("spend goes through the shared admission, as its own operation", () => {
  it("reserves a positive whole number of µ$ that covers every attempt of both calls at their caps", () => {
    expect(Number.isSafeInteger(V)).toBe(true);
    expect(V).toBeGreaterThan(0);
    const everyAttempt = {
      samImages: 0,
      museInputTokens: 2 * VOICE_CLAIM_INPUT_TOKEN_BOUND,
      museOutputTokens: 2 * VOICE_CLAIM_MAX_COMPLETION_TOKENS,
      transcribeSeconds: 2 * 30,
      complete: true,
    };
    expect(costMicros(everyAttempt)).toBeLessThanOrEqual(V);
  });

  it("one admission with that reservation, settled once with the audio's seconds; the whole reservation is kept until a live probe", async () => {
    stubMeta();
    const { budget, admits, settles, real } = meteredBudget(2 * V);
    expect((await handlerWith({ budget })(post())).status).toBe(200);
    expect(admits).toEqual([V]);
    expect(settles).toEqual([{ succeeded: true, seconds: 5 }]);
    // The transcribe count is never complete, so nothing was refunded: one more reservation fits, a second doesn't.
    expect((await real.admit("192.0.2.8", NOW, V)).ok).toBe(true);
    expect((await real.admit("192.0.2.9", NOW, V)).ok).toBe(false);
  });

  it("over the per-address daily limit, is refused with the shared message, and nothing is transcribed", async () => {
    const calls = stubMeta();
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: (10 * V) / 1e6, ipLimit: 1 });
    const handler = handlerWith({ budget });
    expect((await handler(post())).status).toBe(200);
    const refused = await handler(post({ audio: note(5, 300) }));
    expect(refused.status).toBe(429);
    expect((await refused.json()).reason).toBe("ip");
    expect(calls).toHaveLength(2);
  });

  it("a note with no words in it: no claim is read, the reporter is told, the note can be sent again", async () => {
    const calls = stubMeta({ transcribe: transcribed("  ") });
    const store = new MemoryReportStore();
    const { budget, settles } = meteredBudget();
    const res = await handlerWith({ store, budget })(post());
    expect(res.status).toBe(422);
    expect(calls).toEqual(["/asr/transcribe"]);
    expect(settles).toHaveLength(1);
    expect(await store.recent(NOW)).toEqual([]);
    expect(store.dump()).toEqual({});
  });

  it("a claim Muse Spark couldn't read: 502, settled as failed, nothing stored, the note can be sent again", async () => {
    stubMeta({ spark: claimed({ place: "", depth: "waist", passable: "no" }) });
    const store = new MemoryReportStore();
    const { budget, settles } = meteredBudget();
    const res = await handlerWith({ store, budget })(post());
    expect(res.status).toBe(502);
    expect(settles).toEqual([{ succeeded: false, seconds: 5 }]);
    expect(await store.recent(NOW)).toEqual([]);
    stubMeta();
    expect((await handlerWith({ store, budget })(post())).status).toBe(200);
  });
});

describe("one deadline for the whole request (route maxDuration 120 s)", () => {
  /** Scaled down from 110 s, so the test runs in seconds; the handler logic is the same. */
  const timing: VoiceTiming = { budgetMs: 3_000, storeCallMs: 150, responseMs: 150, minReadMs: 400, locateMinMs: 300 };

  it("a transcribe that never answers: an error inside the limit, the reservation settled, the claim freed", async () => {
    stubMeta({ transcribe: hangs });
    const store = new MemoryReportStore();
    const { budget, settles } = meteredBudget();
    const started = Date.now();
    const res = await handlerWith({ store, budget, timing })(post());
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(res.status).toBe(502);
    expect(settles).toEqual([{ succeeded: false, seconds: 0 }]);
    expect(await store.recent(NOW)).toEqual([]);
    stubMeta();
    expect((await handlerWith({ store, budget })(post())).status).toBe(200);
  });

  it("a slow transcribe leaves Muse Spark its turn, and a Spark call that never answers is cut off inside the limit", async () => {
    const calls = stubMeta({ transcribe: async (init) => (await sleep(1_500), transcribed(TAGALOG)(init)), spark: hangs });
    const { budget, settles } = meteredBudget();
    const started = Date.now();
    const res = await handlerWith({ budget, timing })(post());
    expect(Date.now() - started).toBeLessThan(timing.budgetMs);
    expect(res.status).toBe(502);
    expect(calls).toEqual(["/asr/transcribe", "/chat/completions"]);
    expect(settles).toEqual([{ succeeded: false, seconds: 5 }]);
  });

  it("the real budget leaves the route's 120 s limit room past the reserve for saving and settling", async () => {
    const { VOICE_TIMING } = await import("./voice-report-handler");
    // The route module imports through the "@/" alias, which vitest doesn't resolve, so its limit is read from source.
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync("app/api/report/voice/route.ts", "utf8"))?.[1]);
    expect(maxDuration).toBe(120);
    expect(VOICE_TIMING.budgetMs).toBeLessThan(maxDuration * 1_000);
    expect(VOICE_TIMING.storeCallMs).toBeGreaterThanOrEqual(5_000);
  });
});
