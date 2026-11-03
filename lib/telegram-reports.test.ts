import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChannel } from "../test/fake-channel";
import { telegramStores, type TelegramStoreOptions } from "../test/telegram-stores";
import { MemoryBlobStore } from "./blob-store";
import { createBudget, MemoryBudgetStore, RESERVE_MICROS, type Budget } from "./budget";
import { MemoryReportStore } from "./report-store";
import type { Timing } from "./report-handler";
import type { ValhallaGate } from "./router";
import { TelegramFileApi } from "./telegram-files";
import { makeTelegramReports, TELEGRAM_REPLIES, type TelegramReportDeps } from "./telegram-reports";
import { MemoryTelegramStore, type TelegramStore } from "./telegram-store";
import { VOICE_RESERVE_MICROS } from "./voice-report-handler";
import { makeTelegramWebhook } from "./watch-handler";
import { MemoryWatchStore } from "./watch-store";

const SECRET = "hook-secret_1";
const TOKEN = "123456:test-token";
const NOW = new Date("2026-11-03T01:00:00Z");
const T = NOW.getTime() / 1000;
const PIN = { lat: 10.338566, lon: 123.911461 };
const CHAT = 4242;
const LOCATE = JSON.parse(readFileSync("test/fixtures/valhalla/locate-sample-pins.json", "utf8"));
const PHOTO = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));
const OTHER_PHOTO = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-2.jpg"));
const note = (name: string) => new Uint8Array(readFileSync(`test/fixtures/telegram/${name}`));
const CLAIM = { place: "Cuenco Avenue", depth: "knee_or_deeper", passable: "no" };

/** Timings small enough that a test can wait out a deadline: the same chain as production, in tenths of seconds. */
const FAST_PHOTO: Timing = { budgetMs: 0, storeCallMs: 100, responseMs: 50, minReadMs: 300, locateMinMs: 10 };
const FAST = { budgetMs: 2_000, replyReserveMs: 100, photoTiming: FAST_PHOTO, voiceTiming: FAST_PHOTO };

type Reply = (init: RequestInit) => Response | Promise<Response>;
const hangs: Reply = (init) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

/** Meta faked at fetch: SAM answers empty, Muse Spark with `spark`, Voice Transcribe with Tagalog words. */
function stubMeta(spark: Reply = () => sparkJson({ is_flooded_street: true, caveats: "", readings: [] })) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const upstash = process.env.LUSONG_TEST_UPSTASH_URL;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (upstash && String(url).startsWith(upstash)) return realFetch(url, init);
      if (!String(url).startsWith("https://api.meta.ai/")) throw new TypeError("fetch failed");
      calls.push(String(url).replace("https://api.meta.ai/v1", ""));
      if (url.endsWith("/asr/transcribe")) return Response.json({ sessionId: "s", transcript: "Baha dito sa Cuenco Avenue, hanggang tuhod.", audioDurationMs: 3_000, turns: [] });
      if (url.endsWith("/chat/completions")) return spark(init);
      return Response.json({ status: "completed", output: [{ status: "completed", content: [{ type: "output_text", text: "" }] }], usage: { images_processed: 1 } });
    }),
  );
  return calls;
}
const sparkJson = (content: object) =>
  Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 600, completion_tokens: 200 } });
const voiceClaim = (claim: object): Reply => () => sparkJson({ heard_as: "flood_report", ...claim });

interface FakeFile {
  bytes: Uint8Array;
  /** What getFile says the size is, when it isn't the truth. */
  statedSize?: number;
  /** The download never finishes: it ends only when the caller's own deadline aborts it. */
  hang?: boolean;
}

/** Telegram's getFile and file URLs, answered here; every request is recorded without the token. */
function fileServer(files: Record<string, FakeFile>) {
  const requests: string[] = [];
  const doFetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u === `https://api.telegram.org/bot${TOKEN}/getFile`) {
      const { file_id } = JSON.parse(String(init.body));
      requests.push(`getFile ${file_id}`);
      const file = files[file_id];
      if (!file) return Response.json({ ok: false, description: "Bad Request: invalid file_id" }, { status: 400 });
      return Response.json({ ok: true, result: { file_id, file_unique_id: "u", file_size: file.statedSize ?? file.bytes.length, file_path: `media/${file_id}` } });
    }
    const prefix = `https://api.telegram.org/file/bot${TOKEN}/media/`;
    if (!u.startsWith(prefix)) throw new TypeError("fetch failed");
    const id = u.slice(prefix.length);
    requests.push(`download ${id}`);
    const file = files[id];
    if (file.hang) return hangs(init);
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= file.bytes.length) return controller.close();
          controller.enqueue(file.bytes.slice(sent, sent + 64 * 1024));
          sent += 64 * 1024;
        },
      }),
    );
  });
  return { fetch: doFetch as unknown as typeof fetch, requests };
}

const open: ValhallaGate = { acquire: async () => "ok" };
const valhalla = () => vi.fn(async () => Response.json([LOCATE[0]])) as unknown as typeof fetch;

/** The webhook as deployed, with a fake chat, a fake Telegram file server, memory stores and a memory budget. */
function bot(
  opts: {
    store?: TelegramStore;
    files?: Record<string, FakeFile>;
    budget?: Budget;
    channel?: FakeChannel;
    fast?: boolean;
    reports?: Partial<TelegramReportDeps["reports"]>;
  } = {},
) {
  const channel = opts.channel ?? new FakeChannel();
  const store = opts.store ?? new MemoryTelegramStore();
  const reportStore = new MemoryReportStore();
  const budget = opts.budget ?? createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
  const server = fileServer(opts.files ?? { photo: { bytes: PHOTO }, other: { bytes: OTHER_PHOTO }, voice: { bytes: note("tone-3s.ogg") } });
  const fast = opts.fast ? FAST : {};
  const reports = makeTelegramReports({
    store,
    channel,
    files: new TelegramFileApi(TOKEN, server.fetch),
    reports: { gate: () => open, budget: () => budget, store: () => reportStore, fetch: valhalla(), ...fast, ...opts.reports },
    now: () => NOW,
    ...(opts.fast ? { budgetMs: FAST.budgetMs, replyReserveMs: FAST.replyReserveMs } : {}),
  });
  const hook = makeTelegramWebhook({ secret: () => SECRET, store: () => new MemoryWatchStore(), channel: () => channel, reports: () => reports });
  const send = (update: object) =>
    hook(
      new Request("http://localhost/api/watch/telegram", {
        method: "POST",
        body: JSON.stringify(update),
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      }),
    );
  const replies = () => channel.sent.map((m) => m.text);
  return { send, channel, replies, reportStore, budget, server, store };
}

let nextId = 1_000;
const PRIVATE = { id: CHAT, type: "private" };
function update(fields: object, opts: { chat?: object; date?: number; id?: number } = {}) {
  const chat = opts.chat ?? PRIVATE;
  return { update_id: opts.id ?? nextId++, message: { message_id: nextId, date: opts.date ?? T, chat, from: { id: CHAT, is_bot: false, first_name: "R" }, ...fields } };
}
/** Telegram's sizes of one photo: a thumbnail, the one Lusong takes, and one over 1600 px. */
const photo = (fileId = "photo", opts: { date?: number; chat?: object; id?: number; extra?: object } = {}) =>
  update(
    {
      photo: [
        { file_id: `${fileId}-thumb`, file_unique_id: "t", width: 90, height: 68, file_size: 1_200 },
        { file_id: fileId, file_unique_id: "m", width: 1280, height: 960, file_size: 517_000 },
        { file_id: `${fileId}-big`, file_unique_id: "b", width: 2560, height: 1920, file_size: 2_100_000 },
      ],
      ...opts.extra,
    },
    opts,
  );
const location = (opts: { date?: number; at?: { lat: number; lon: number }; id?: number; extra?: object; chat?: object } = {}) =>
  update({ location: { latitude: (opts.at ?? PIN).lat, longitude: (opts.at ?? PIN).lon }, ...opts.extra }, opts);
const voice = (opts: { fileId?: string; duration?: number; fileSize?: number; date?: number; id?: number } = {}) =>
  update({ voice: { file_id: opts.fileId ?? "voice", file_unique_id: "v", duration: opts.duration ?? 3, mime_type: "audio/ogg", file_size: opts.fileSize ?? 6_528 } }, opts);
const text = (t: string) => update({ text: t });

beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(telegramStores)("a photo report through Telegram, on the %s", (_name, make) => {
  it("photo then location within 2 minutes: one report stored and one reply, the prompt and the result sent apart (S6P-8)", async () => {
    const calls = stubMeta();
    const { store } = make();
    const b = bot({ store });
    expect((await b.send(photo())).status).toBe(200);
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.photoWaiting]);
    expect(calls).toEqual([]);
    expect((await b.send(location({ date: T + 60 }))).status).toBe(200);

    const [report] = await b.reportStore.recent(NOW);
    expect(report).toMatchObject({ kind: "photo", at: PIN, place: "Governor M. Cuenco Avenue", capturedAt: null, receivedAt: NOW.toISOString() });
    expect(calls.length).toBeGreaterThan(0);
    expect(b.replies()).toHaveLength(2);
    expect(b.replies()[1]).toBe(
      [
        "Lusong read your photo, at the location you sent, on Governor M. Cuenco Avenue.",
        "Depth: no flood water seen.",
        "No flood water in the photo.",
        "Your photo carries no time it was taken, so Lusong can't tell it is recent: others will see it, but it can't mark the spot clear.",
      ].join("\n"),
    );
    expect(b.channel.sent.every((m) => m.chatId === String(CHAT))).toBe(true);
  });

  it("location then photo: the same", async () => {
    stubMeta();
    const b = bot({ store: make().store });
    await b.send(location());
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.locationWaiting]);
    await b.send(photo("photo", { date: T + 30 }));
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
    expect(b.replies()[1]).toMatch(/^Lusong read your photo/);
  });

  it("downloads the largest size at most 1600 px, never the bigger one", async () => {
    stubMeta();
    const b = bot({ store: make().store });
    await b.send(photo());
    await b.send(location());
    expect(b.server.requests).toEqual(["getFile photo", "download photo"]);
  });

  it("a location 121 s after the photo is refused: nothing read, nothing stored, and it asks for the other half", async () => {
    const calls = stubMeta();
    const b = bot({ store: make().store });
    await b.send(photo());
    await b.send(location({ date: T + 121 }));
    expect(calls).toEqual([]);
    expect(b.server.requests).toEqual([]);
    expect(await b.reportStore.recent(NOW)).toEqual([]);
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.photoWaiting, TELEGRAM_REPLIES.locationWaiting]);
  });

  it("the same update twice is worked on once", async () => {
    const calls = stubMeta();
    const b = bot({ store: make().store });
    await b.send(photo());
    const loc = location();
    await b.send(loc);
    const callsAfterFirst = calls.length;
    expect((await b.send(loc)).status).toBe(200);
    expect(calls).toHaveLength(callsAfterFirst);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
    expect(b.replies()).toHaveLength(2);
  });

  it("two photos racing for one location make exactly one report (S6P-1)", async () => {
    const calls = stubMeta();
    const b = bot({ store: make().store });
    await b.send(location());
    const [r1, r2] = await Promise.all([b.send(photo("photo")), b.send(photo("other"))]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
    expect(b.server.requests.filter((r) => r.startsWith("download"))).toHaveLength(1);
    expect(calls.filter((c) => c === "/chat/completions").length).toBeLessThanOrEqual(1);
    expect(b.replies().filter((t) => t.startsWith("Lusong read your photo"))).toHaveLength(1);
    expect(b.replies().filter((t) => t === TELEGRAM_REPLIES.photoWaiting)).toHaveLength(1);
  });

  it("failure right after claiming the update: 500, and the redelivery makes the one report (S6P-2)", async () => {
    const calls = stubMeta();
    const under = make();
    const realPair = under.store.pair.bind(under.store);
    let failures = 1;
    under.store.pair = async (...args) => {
      if (args[1].side === "media" && failures-- > 0) throw new Error("store down");
      return realPair(...args);
    };
    const b = bot({ store: under.store });
    await b.send(location());
    const ph = photo();
    expect((await b.send(ph)).status).toBe(500);
    expect(calls).toEqual([]);
    expect((await b.send(ph)).status).toBe(200);
    const once = calls.length;
    expect(once).toBeGreaterThan(0);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
    expect((await b.send(ph)).status).toBe(200);
    expect(calls).toHaveLength(once);
  });

  it("the pairing landing and its answer lost: 500, and the redelivery does nothing, since the pairing marked the update (S6P-2)", async () => {
    const calls = stubMeta();
    const under = make();
    const realPair = under.store.pair.bind(under.store);
    let failures = 1;
    under.store.pair = async (...args) => {
      const result = await realPair(...args);
      if (args[1].side === "media" && failures-- > 0) throw new Error("connection dropped after the script ran");
      return result;
    };
    const b = bot({ store: under.store });
    await b.send(location());
    const ph = photo();
    expect((await b.send(ph)).status).toBe(500);
    expect((await b.send(ph)).status).toBe(200);
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.locationWaiting]);
    expect(calls).toEqual([]);
    expect(b.server.requests).toEqual([]);
    expect(await b.reportStore.recent(NOW)).toEqual([]);
  });

  it("dying mid-read before the update is finished: once its hold lapses, a redelivery doesn't pair with a newer location or read again (S6P-2)", async () => {
    const calls = stubMeta();
    const under = make({ processingMs: 300 } satisfies TelegramStoreOptions);
    const finish = under.store.finishUpdate.bind(under.store);
    // The worker dies after its Meta read: it never marks the update finished.
    under.store.finishUpdate = async (id) => {
      if (calls.length === 0) await finish(id);
    };
    const b = bot({ store: under.store });
    await b.send(location());
    const ph = photo();
    await b.send(ph);
    const paid = calls.length;
    expect(paid).toBeGreaterThan(0);
    under.store.finishUpdate = finish;

    await b.send(location({ date: T + 100 }));
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.locationWaiting);
    await under.wait(400);
    expect((await b.send(ph)).status).toBe(200);
    expect(calls).toHaveLength(paid);
    expect(b.server.requests.filter((r) => r.startsWith("download"))).toHaveLength(1);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
  });

  it("a store failure after pairing replies that it couldn't read it; redeliveries, even after the hold lapses, repeat nothing (S6P-2)", async () => {
    const calls = stubMeta();
    const under = make({ processingMs: 300 } satisfies TelegramStoreOptions);
    const reportStore = new MemoryReportStore();
    reportStore.claimPhoto = async () => {
      throw new Error("report store down");
    };
    const b = bot({ store: under.store, reports: { store: () => reportStore } });
    await b.send(location());
    const ph = photo();
    expect((await b.send(ph)).status).toBe(200);
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.storeDown);
    await b.send(ph);
    await under.wait(400);
    await b.send(ph);
    expect(calls).toEqual([]);
    expect(b.server.requests.filter((r) => r.startsWith("download"))).toHaveLength(1);
    expect(b.replies()).toHaveLength(2);
  });

  it("dying after the save and before the reply: a redelivery after the hold lapses reads and saves nothing again (S6P-2)", async () => {
    const calls = stubMeta();
    const under = make({ processingMs: 300 } satisfies TelegramStoreOptions);
    const channel = new FakeChannel();
    const b = bot({ store: under.store, channel });
    await b.send(location());
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("function killed");
    };
    const ph = photo();
    await expect(b.send(ph)).rejects.toThrow("function killed");
    channel.send = send;
    const paid = calls.length;
    expect(paid).toBeGreaterThan(0);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);

    await b.send(ph);
    await under.wait(400);
    await b.send(ph);
    expect(calls).toHaveLength(paid);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
  });

  it("a reply Telegram rejects or leaves unanswered doesn't bring the report back (S6P-8)", async () => {
    const calls = stubMeta();
    const channel = new FakeChannel();
    const b = bot({ store: make().store, channel });
    await b.send(location());
    channel.next = [{ ok: false, rejected: false }];
    const ph = photo();
    expect((await b.send(ph)).status).toBe(200);
    const paid = calls.length;
    channel.next = [{ ok: false, rejected: true, permanent: false }];
    expect((await b.send(ph)).status).toBe(200);
    expect(calls).toHaveLength(paid);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
  });
});

describe("photo reports that are refused before any paid read", () => {
  it("a venue is refused, even though Telegram also sets its location", async () => {
    const calls = stubMeta();
    const b = bot();
    await b.send(photo());
    await b.send(location({ extra: { venue: { location: { latitude: PIN.lat, longitude: PIN.lon }, title: "Ayala Center", address: "Cebu" } } }));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.photoWaiting, TELEGRAM_REPLIES.venue]);
    expect(calls).toEqual([]);
    expect(await b.reportStore.recent(NOW)).toEqual([]);
  });

  it("a forwarded photo is refused", async () => {
    const calls = stubMeta();
    const b = bot();
    await b.send(location());
    await b.send(photo("photo", { extra: { forward_origin: { type: "user", date: T - 50, sender_user: { id: 1 } } } }));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.locationWaiting, TELEGRAM_REPLIES.forwarded]);
    expect(calls).toEqual([]);
    expect(b.server.requests).toEqual([]);
  });

  it("a group chat is ignored: no reply, nothing kept", async () => {
    const calls = stubMeta();
    const store = new MemoryTelegramStore();
    const b = bot({ store });
    const group = { id: -100123, type: "group", title: "Commuters" };
    expect((await b.send(location({ chat: group }))).status).toBe(200);
    expect((await b.send(photo("photo", { chat: group }))).status).toBe(200);
    expect(b.replies()).toEqual([]);
    expect(calls).toEqual([]);
    expect(store.dump()).toEqual({});
  });

  it("a message more than 10 minutes old is refused as stale", async () => {
    stubMeta();
    const b = bot();
    await b.send(photo("photo", { date: T - 601 }));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.stale]);
  });

  it("a location outside the trip area is refused", async () => {
    stubMeta();
    const b = bot();
    await b.send(location({ at: { lat: 14.6, lon: 120.98 } }));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.outside]);
  });

  it("a photo over 3 MB is refused before any Meta call, stated or as it arrives", async () => {
    const calls = stubMeta();
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    const b = bot({ files: { stated: { bytes: PHOTO, statedSize: big.length }, liar: { bytes: big, statedSize: 500_000 } } });
    await b.send(location());
    await b.send(photo("stated"));
    await b.send(location());
    await b.send(photo("liar"));
    expect(b.replies().filter((t) => t === TELEGRAM_REPLIES.photoTooLarge)).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  it("a photo with no size of at most 1600 px is refused before download", async () => {
    stubMeta();
    const b = bot();
    await b.send(update({ photo: [{ file_id: "huge", file_unique_id: "h", width: 2560, height: 1920, file_size: 2_000_000 }] }));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.photoTooLarge]);
    expect(b.server.requests).toEqual([]);
  });

  it("the 11th report from a chat in a UTC day is refused with the limit message; another chat still reports", async () => {
    const calls = stubMeta();
    const budget = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 10, ipLimit: 10 });
    for (let i = 0; i < 10; i++) expect((await budget.admit(`tg:${CHAT}`, NOW, RESERVE_MICROS)).ok).toBe(true);
    const b = bot({ budget });
    await b.send(location());
    await b.send(photo());
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.chatLimit);
    expect(calls).toEqual([]);
    expect(await b.reportStore.recent(NOW)).toEqual([]);

    const other = { id: 777, type: "private" };
    await b.send(location({ chat: other }));
    await b.send(photo("photo", { chat: other }));
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
  });

  it("a slow download leaves no paid call: the report gives up before admission (S6P-3)", async () => {
    const calls = stubMeta();
    const admitted: string[] = [];
    const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
    const budget: Budget = { admit: async (ip, now, r) => (admitted.push(String(ip)), real.admit(ip, now, r)), settle: real.settle };
    const b = bot({ fast: true, budget, files: { photo: { bytes: PHOTO, hang: true } } });
    await b.send(location());
    await b.send(photo());
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.outOfTime);
    expect(admitted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an admission that lands near the deadline is refused before Meta, and its reservation refunded (S6P-3)", async () => {
    const calls = stubMeta();
    const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
    const settled: boolean[] = [];
    const budget: Budget = {
      admit: async (...args) => (await new Promise((r) => setTimeout(r, 1_400)), real.admit(...args)),
      settle: async (admission, usage, ok) => (settled.push(ok), real.settle(admission, usage, ok)),
    };
    const b = bot({ fast: true, budget });
    await b.send(location());
    await b.send(photo());
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.outOfTime);
    expect(calls).toEqual([]);
    await vi.waitFor(() => expect(settled).toEqual([true]));
  });

  it("never publishes a photo, even with plate detection trusted and a photo store set (S6P-7)", async () => {
    stubMeta();
    const photos = new MemoryBlobStore();
    const put = vi.spyOn(photos, "put");
    const reserved: number[] = [];
    const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
    const budget: Budget = { admit: async (ip, now, r) => (reserved.push(r!), real.admit(ip, now, r)), settle: real.settle };
    const b = bot({ budget, reports: { photos: () => photos, plateDetectionTrusted: true } });
    await b.send(location());
    await b.send(photo());
    const [report] = await b.reportStore.recent(NOW);
    expect(report).toBeDefined();
    expect(report).not.toHaveProperty("photoUrl");
    expect(put).not.toHaveBeenCalled();
    expect(reserved).toEqual([RESERVE_MICROS]);
  });
});

describe("a voice report through Telegram", () => {
  it("with no language chosen it asks for one and keeps nothing; after /tagalog it is transcribed and stored", async () => {
    const calls = stubMeta(voiceClaim(CLAIM));
    const store = new MemoryTelegramStore();
    const b = bot({ store });
    await b.send(location());
    await b.send(voice());
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.locationWaiting, TELEGRAM_REPLIES.askLanguage]);
    expect(calls).toEqual([]);
    expect(b.server.requests).toEqual([]);

    await b.send(text("/tagalog"));
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.languageSet("tl"));
    await b.send(voice());
    expect(calls).toEqual(["/asr/transcribe", "/chat/completions"]);
    const [report] = await b.reportStore.recent(NOW);
    expect(report).toMatchObject({ kind: "voice", at: PIN, claim: CLAIM });
    expect(b.replies().at(-1)).toBe(
      [
        "Lusong heard your voice note, at the location you sent, on Governor M. Cuenco Avenue.",
        "Lusong heard that the water is knee-deep or deeper and vehicles can't pass.",
        "Others checking a trip through here will count this spot as not passable for the next 3 h, unless a newer photo of the same road shows it clear.",
      ].join("\n"),
    );
    // The transcript never reaches the chat: only fixed sentences and the street Valhalla named.
    expect(b.replies().join("\n")).not.toContain("hanggang");
  });

  it("a language command is an update like any other: a redelivered one doesn't undo a newer choice, a forwarded one changes nothing", async () => {
    stubMeta();
    const store = new MemoryTelegramStore();
    const b = bot({ store });
    const tagalog = text("/tagalog");
    await b.send(tagalog);
    await b.send(text("/english"));
    await b.send(tagalog);
    expect(await store.language(String(CHAT))).toBe("en");
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.languageSet("tl"), TELEGRAM_REPLIES.languageSet("en")]);
    await b.send(update({ text: "/bisaya", forward_origin: { type: "user", date: T, sender_user: { id: 1 } } }));
    expect(await store.language(String(CHAT))).toBe("en");
    expect(b.replies().at(-1)).toBe(TELEGRAM_REPLIES.forwarded);
  });

  it("a voice note saying the road is clear never clears it", async () => {
    stubMeta(voiceClaim({ place: "Talamban", depth: "dry", passable: "yes" }));
    const store = new MemoryTelegramStore();
    await store.setLanguage(String(CHAT), "en");
    const b = bot({ store });
    await b.send(voice());
    await b.send(location());
    expect(b.replies().at(-1)).toContain("a voice report can't mark a street clear");
  });

  it("a Bisaya choice reads the audio with Muse Spark, without transcribing", async () => {
    const calls = stubMeta(() => sparkJson({ heard_as: "flood_report", transcript: "Baha diri, hangtod tuhod.", ...CLAIM }));
    const store = new MemoryTelegramStore();
    const b = bot({ store });
    await b.send(text("/bisaya"));
    await b.send(voice());
    await b.send(location());
    expect(calls).toEqual(["/chat/completions"]);
    expect(await b.reportStore.recent(NOW)).toHaveLength(1);
  });

  it.each([
    ["a stated duration over 30 s", { duration: 31 }],
    ["a stated size over 512 KB", { fileSize: 512 * 1024 + 1 }],
  ])("%s is refused before download", async (_what, fields) => {
    const calls = stubMeta(voiceClaim(CLAIM));
    const store = new MemoryTelegramStore();
    await store.setLanguage(String(CHAT), "tl");
    const b = bot({ store });
    await b.send(voice(fields));
    expect(b.replies()).toEqual([TELEGRAM_REPLIES.voiceTooLong]);
    expect(b.server.requests).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["malformed OGG", { bytes: new Uint8Array(6_000).map((_, i) => (i * 31) % 251) }, TELEGRAM_REPLIES.couldntRead],
    ["a file larger than 512 KB that said it was small", { bytes: new Uint8Array(600 * 1024), statedSize: 6_000 }, TELEGRAM_REPLIES.voiceTooLong],
    ["40 s of audio in a note whose message said 5 s", { bytes: note("tone-40s.ogg") }, TELEGRAM_REPLIES.voiceTooLong],
    ["a note too short to hold a report", { bytes: note("tone-0.3s.ogg") }, TELEGRAM_REPLIES.voiceTooShort],
    ["30.25 s of audio, under the decoder's stop but over 30 s", { bytes: note("tone-30.25s.ogg") }, TELEGRAM_REPLIES.voiceTooLong],
  ])("%s never reaches Meta (S6P-4)", async (_what, file, reply) => {
    const calls = stubMeta(voiceClaim(CLAIM));
    const store = new MemoryTelegramStore();
    await store.setLanguage(String(CHAT), "tl");
    const admitted: unknown[] = [];
    const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
    const budget: Budget = { admit: async (...a) => (admitted.push(a[0]), real.admit(...a)), settle: real.settle };
    const b = bot({ store, budget, files: { voice: file } });
    await b.send(voice({ duration: 5 }));
    await b.send(location());
    expect(b.replies().at(-1)).toBe(reply);
    expect(calls).toEqual([]);
    expect(admitted).toEqual([]);
    expect(await b.reportStore.recent(NOW)).toEqual([]);
  });

  it("reserves the voice route's worst case against the chat's limit", async () => {
    stubMeta(voiceClaim(CLAIM));
    const store = new MemoryTelegramStore();
    await store.setLanguage(String(CHAT), "tl");
    const admits: [unknown, unknown][] = [];
    const real = createBudget({ store: new MemoryBudgetStore(), budgetUsd: 1, ipLimit: 10 });
    const budget: Budget = { admit: async (ip, now, r) => (admits.push([ip, r]), real.admit(ip, now, r)), settle: real.settle };
    const b = bot({ store, budget });
    await b.send(voice());
    await b.send(location());
    expect(admits).toEqual([[`tg:${CHAT}`, VOICE_RESERVE_MICROS]]);
  });
});

describe("the webhook around reports", () => {
  it("still refuses a call without the secret, and keeps /start and other text as before", async () => {
    stubMeta();
    const channel = new FakeChannel();
    const store = new MemoryTelegramStore();
    const reports = makeTelegramReports({ store, channel, files: new TelegramFileApi(TOKEN, fileServer({}).fetch), reports: { gate: () => open } });
    const hook = makeTelegramWebhook({ secret: () => SECRET, store: () => new MemoryWatchStore(), channel: () => channel, reports: () => reports });
    const unsigned = new Request("http://localhost/api/watch/telegram", { method: "POST", body: JSON.stringify(photo()) });
    expect((await hook(unsigned)).status).toBe(401);
    const signed = (u: object) =>
      new Request("http://localhost/api/watch/telegram", { method: "POST", body: JSON.stringify(u), headers: { "x-telegram-bot-api-secret-token": SECRET } });
    expect((await hook(signed(text("hello")))).status).toBe(200);
    expect((await hook(signed(text("/start")))).status).toBe(200);
    expect(channel.sent.map((m) => m.text)).toEqual(["Open Lusong, switch on the watcher for your trip, and follow its Telegram link."]);
    expect(store.dump()).toEqual({});
  });

  it("an edited message (a live location moving) is ignored", async () => {
    stubMeta();
    const b = bot();
    expect((await b.send({ update_id: 5, edited_message: location().message })).status).toBe(200);
    expect(b.replies()).toEqual([]);
  });

  it("a store that can't take the update id is a 500, so Telegram sends it again", async () => {
    stubMeta();
    const store = new MemoryTelegramStore();
    store.claimUpdate = async () => {
      throw new Error("store down");
    };
    expect((await bot({ store }).send(photo())).status).toBe(500);
  });
});
