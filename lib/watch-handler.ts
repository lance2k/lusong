import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { admit } from "./admission";
import type { Point } from "./answer";
import type { Budget } from "./budget";
import { channelFromEnv, type Channel } from "./channel";
import { clientIp } from "./check-handler";
import { COMMUTE_RESERVE_MICROS, type ScheduledCheck } from "./commute-handler";
import { readBody } from "./deadline";
import { inMetroCebu } from "./metro-cebu";
import { LINK_CODE_TTL_MS, watchStoreFromEnv, type WatchRecord, type WatchStore, type WatchTrip } from "./watch-store";
import { runTick, switchOff, type TickSummary } from "./watch-tick";
import { hhmm, parseWindow } from "./watch-window";

/**
 * Why Telegram and an outside scheduler (checked 2026-10-30, recorded on issue #10): Messenger's standard window is
 * 24 hours and its update tags are gone, so a 6 a.m. message to someone who last wrote days ago is blocked; Vercel
 * Hobby cron runs once a day only. The scheduler calls /api/watch/tick every 10 minutes with WATCH_TICK_SECRET.
 */

/** Constant time on the digests, so neither the secret's content nor its length shows in the timing. Unset matches nothing. */
export function sameSecret(given: string | null, expected: string | undefined): boolean {
  if (!expected || given === null) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

/** The phone holds the token; the store holds only its hash, so a read of the store can't switch anyone off. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const storeId = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
/** Telegram's start parameter takes up to 64 of A-Z, a-z, 0-9, _ and - (core.telegram.org/bots/features#deep-linking). */
const newCode = () => randomBytes(24).toString("base64url");

const MAX_BODY_BYTES = 2 * 1024;
const BODY_WAIT_MS = 10_000;

function pointFrom(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return inMetroCebu({ lat, lon }) ? { lat, lon } : null;
}

type WatchRequest =
  | { action: "on"; trip: WatchTrip; window: WatchRecord["window"] }
  | { action: "status" | "link" | "off"; token: string };

function parseRequest(body: unknown): WatchRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.action === "on") {
    const from = pointFrom(b.from);
    const to = pointFrom(b.to);
    const window = parseWindow(b.window);
    return from && to && window ? { action: "on", trip: { from, to }, window } : null;
  }
  if ((b.action === "status" || b.action === "link" || b.action === "off") && typeof b.watcher === "string" && TOKEN.test(b.watcher)) {
    return { action: b.action, token: b.watcher };
  }
  return null;
}

const windowForPage = (w: WatchRecord["window"]) => ({ start: hhmm(w.startMin), end: hhmm(w.endMin) });
const NOT_SET_UP = "The watcher isn't set up yet.";
const STORE_FAILED = "Lusong couldn't reach its store, so nothing changed. Try again in a minute.";
const GONE = { error: "This watcher is off.", state: "off" };

/** POST /api/watch: switch a watcher on, ask its state, get a fresh Telegram link, or switch it off. */
export function makeWatchHandler(deps: {
  store: () => WatchStore | null;
  budget: () => Budget;
  /** The bot's username, from TELEGRAM_BOT_USERNAME; null when the watcher isn't set up. */
  botUsername: () => string | null;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const linkFor = (bot: string, code: string) => ({
    link: `https://t.me/${bot}?start=${code}`,
    linkExpiresAt: new Date(now().getTime() + LINK_CODE_TTL_MS).toISOString(),
  });

  return async function POST(request: Request): Promise<Response> {
    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: Date.now() + BODY_WAIT_MS });
    if (body === "too_large") return fail(413, "That request is too large.");
    if (body === "too_slow") return fail(408, "Lusong didn't receive the whole request in time.");
    let parsed: WatchRequest | null;
    try {
      parsed = parseRequest(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      parsed = null;
    }
    if (!parsed) return fail(400, "Send a trip in Metro Cebu with a window of up to 4 hours in one day, or a watcher to ask about.");

    const store = deps.store();
    const bot = deps.botUsername();
    if (parsed.action === "off") {
      if (!store) return fail(503, STORE_FAILED);
      try {
        // Waits for a message being sent to this watcher, so none arrives after the phone hears it is off.
        await switchOff(store, storeId(parsed.token));
      } catch (err) {
        console.error("watch store failed on switch-off:", err instanceof Error ? err.message : err);
        return fail(503, "Lusong couldn't switch the watcher off. Try again in a minute; until then it is still on.");
      }
      return Response.json({ state: "off" });
    }
    if (!store || !bot) return fail(503, NOT_SET_UP, { setup: false });

    try {
      if (parsed.action === "on") {
        // Each switch-on is one of the address's checks for the day, so one address can't fill the store.
        const admission = await admit(deps.budget(), { clientIp: clientIp(request), reserveMicros: COMMUTE_RESERVE_MICROS, now: now() });
        if (!admission.ok) return admission.response();
        await admission.run.settle(true);
        const token = newToken();
        const code = newCode();
        const created = await store.create({ id: storeId(token), gen: randomUUID(), trip: parsed.trip, window: parsed.window }, code);
        if (created === "full") return fail(409, "Lusong is watching as many trips as it can right now. Try again tomorrow.");
        return Response.json({ watcher: token, window: windowForPage(parsed.window), ...linkFor(bot, code) });
      }
      const id = storeId(parsed.token);
      if (parsed.action === "link") {
        const code = newCode();
        if (!(await store.newCode(id, code))) return Response.json(GONE, { status: 404 });
        return Response.json(linkFor(bot, code));
      }
      // Opening the page keeps the watcher another 30 days.
      const watcher = (await store.refresh(id)) ? await store.get(id) : null;
      if (!watcher) return Response.json(GONE, { status: 404 });
      return Response.json({ state: watcher.chatId ? "linked" : "waiting", window: windowForPage(watcher.window) });
    } catch (err) {
      console.error("watch store failed:", err instanceof Error ? err.message : err);
      return fail(503, STORE_FAILED);
    }
  };
}

const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;

/** UNVERIFIED beyond the docs: the Update, Message and Chat fields read here are from core.telegram.org/bots/api. */
interface TelegramUpdate {
  message?: { text?: unknown; chat?: { id?: unknown; type?: unknown } };
}

/**
 * POST /api/watch/telegram, the bot's webhook. Telegram sends TELEGRAM_WEBHOOK_SECRET in X-Telegram-Bot-Api-Secret-Token
 * (setWebhook's secret_token); every other call is refused. Any 2XX ends Telegram's retries, so only a store failure is
 * answered with an error, to have the update sent again.
 */
export function makeTelegramWebhook(deps: { secret: () => string | undefined; store: () => WatchStore | null; channel: () => Channel | null }) {
  return async function POST(request: Request): Promise<Response> {
    const secret = deps.secret();
    if (!secret) return fail(503, NOT_SET_UP);
    if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token"), secret)) return fail(401, "Unauthorized.");
    const store = deps.store();
    const channel = deps.channel();
    if (!store || !channel) return fail(503, NOT_SET_UP);

    const body = await readBody(request, { maxBytes: 64 * 1024, deadline: Date.now() + BODY_WAIT_MS });
    let update: TelegramUpdate | null = null;
    try {
      if (body instanceof Uint8Array) update = JSON.parse(new TextDecoder().decode(body)) as TelegramUpdate;
    } catch {
      update = null;
    }
    const message = update?.message;
    const chatId = message?.chat?.id;
    const start = typeof message?.text === "string" ? START.exec(message.text) : null;
    // Only private chats: a watcher's messages are about one rider's trip.
    if (!start || message?.chat?.type !== "private" || typeof chatId !== "number" || !Number.isSafeInteger(chatId)) {
      return Response.json({ ok: true });
    }
    const chat = String(chatId);
    const code = start[1];
    if (!code) {
      await channel.send(chat, "Open Lusong, switch on the watcher for your trip, and follow its Telegram link.");
      return Response.json({ ok: true });
    }
    let watcher: WatchRecord | null;
    try {
      watcher = /^[A-Za-z0-9_-]{1,64}$/.test(code) ? await store.redeem(code, chat) : null;
    } catch (err) {
      console.error("watch store failed on link:", err instanceof Error ? err.message : err);
      return fail(500, STORE_FAILED);
    }
    if (!watcher) {
      await channel.send(chat, "That link has expired or was already used. Open Lusong and press “Get a new Telegram link”.");
      return Response.json({ ok: true });
    }
    const { start: from, end: to } = windowForPage(watcher.window);
    await channel.send(
      chat,
      `Linked. Lusong will message you here between ${from} and ${to} PHT: once when the window opens, and again whenever the answer changes. To stop, switch the watcher off on Lusong's page; that deletes your trip from Lusong's server.`,
    );
    return Response.json({ ok: true });
  };
}

/**
 * POST /api/watch/tick, called by the outside scheduler with `Authorization: Bearer <WATCH_TICK_SECRET>`. Unset, it
 * refuses every call. Messages link to the page on the host the scheduler called.
 */
export function makeTickHandler(deps: { secret: () => string | undefined; tick: (pageUrl: string) => Promise<TickSummary | null> }) {
  return async function POST(request: Request): Promise<Response> {
    const secret = deps.secret();
    if (!secret) return fail(503, NOT_SET_UP);
    const auth = request.headers.get("authorization");
    const given = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (!sameSecret(given, secret)) return fail(401, "Unauthorized.");
    const summary = await deps.tick(new URL("/", request.url).toString());
    if (!summary) return fail(503, NOT_SET_UP);
    return Response.json(summary, { status: summary.ok ? 200 : 503 });
  };
}

/** The tick as deployed: the store and Telegram from the environment, and the real commute check of each trip. */
export function tickFromEnv(check: (trip: WatchTrip, opts: { deadline: number }) => Promise<ScheduledCheck>) {
  return async (pageUrl: string): Promise<TickSummary | null> => {
    const store = watchStoreFromEnv();
    const channel = channelFromEnv();
    if (!store || !channel) return null;
    return runTick({ store, channel, check, now: () => new Date(), pageUrl });
  };
}
