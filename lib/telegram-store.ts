import { createHash } from "node:crypto";
import { VOICE_LANGUAGES, type VoiceLanguage } from "./voice-language";

/** A photo or voice note and a location pair only when Telegram dated them at most this far apart. */
export const PAIR_WINDOW_S = 120;
/** The half waiting for its other half is kept this long, then forgotten. */
export const PENDING_TTL_MS = 120_000;
/** An update being worked on holds its id this long: longer than the webhook route's 120 s limit. */
export const UPDATE_PROCESSING_MS = 150_000;
/** An update that was handled is remembered this long, so a redelivery does nothing. */
export const UPDATE_DONE_MS = 24 * 60 * 60_000;
export const LANGUAGE_TTL_MS = 30 * 24 * 60 * 60_000;

/** What the store keeps of a photo or voice note: Telegram's file id and what its message said, never the media. */
export type MediaHalf =
  | { side: "media"; kind: "photo"; fileId: string; date: number }
  | { side: "media"; kind: "voice"; fileId: string; date: number; durationS: number; fileSize: number | null; language: VoiceLanguage };
export interface LocationHalf {
  side: "location";
  lat: number;
  lon: number;
  date: number;
}
export type Half = MediaHalf | LocationHalf;

export type Pairing = { paired: true; media: MediaHalf; location: LocationHalf } | { paired: false };

/** Chat ids are hashed before they name a key, so a read of the store doesn't list who wrote to the bot. */
export const chatKey = (chatId: string) => createHash("sha256").update(chatId).digest("hex");

export interface TelegramStore {
  /** `SET NX`: true when this call took the update to work on, false when it is being worked on or was handled. */
  claimUpdate(updateId: number): Promise<boolean>;
  /** Gives the update back while it is still being worked on, so a redelivery can take it. */
  releaseUpdate(updateId: number): Promise<void>;
  /** Marks the update handled for UPDATE_DONE_MS. */
  finishUpdate(updateId: number): Promise<void>;
  /**
   * Atomic, one call per arrival: if the chat's waiting half is the other side and dated within PAIR_WINDOW_S, it is
   * taken and both are returned; otherwise this half waits in its place (the latest wins). Only one arrival can take
   * a waiting half.
   */
  pair(chat: string, half: Half): Promise<Pairing>;
  setLanguage(chat: string, language: VoiceLanguage): Promise<void>;
  language(chat: string): Promise<VoiceLanguage | null>;
}

const encodeHalf = (half: Half) => `${half.side}|${half.date}|${JSON.stringify(half)}`;

function decodeHalf(value: string): Half | null {
  const json = value.split("|").slice(2).join("|");
  try {
    return JSON.parse(json) as Half;
  } catch {
    return null;
  }
}

function paired(arrival: Half, waiting: Half): Pairing {
  return arrival.side === "media"
    ? { paired: true, media: arrival, location: waiting as LocationHalf }
    : { paired: true, media: waiting as MediaHalf, location: arrival };
}

const languageFrom = (value: unknown): VoiceLanguage | null => VOICE_LANGUAGES.find((l) => l.value === value)?.value ?? null;

interface Ttls {
  pendingTtlMs?: number;
  processingMs?: number;
}

/** For local development and tests only: each server instance would keep its own. */
export class MemoryTelegramStore implements TelegramStore {
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly processingMs: number;
  private readonly keys = new Map<string, { value: string; expiresAt: number }>();

  constructor(opts: Ttls & { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.pendingTtlMs = opts.pendingTtlMs ?? PENDING_TTL_MS;
    this.processingMs = opts.processingMs ?? UPDATE_PROCESSING_MS;
  }

  private get(key: string): string | null {
    const entry = this.keys.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.keys.delete(key);
      return null;
    }
    return entry.value;
  }

  private set(key: string, value: string, ttlMs: number) {
    this.keys.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Every live key as Upstash would name it, with its value: for tests that check what is kept. */
  dump(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of [...this.keys.keys()]) {
      const value = this.get(key);
      if (value !== null) out[`lusong:tg:${key}`] = value;
    }
    return out;
  }

  async claimUpdate(updateId: number) {
    if (this.get(`update:${updateId}`) !== null) return false;
    this.set(`update:${updateId}`, "processing", this.processingMs);
    return true;
  }

  async releaseUpdate(updateId: number) {
    if (this.get(`update:${updateId}`) === "processing") this.keys.delete(`update:${updateId}`);
  }

  async finishUpdate(updateId: number) {
    this.set(`update:${updateId}`, "done", UPDATE_DONE_MS);
  }

  async pair(chat: string, half: Half): Promise<Pairing> {
    const key = `pending:${chatKey(chat)}`;
    const current = this.get(key);
    const waiting = current === null ? null : decodeHalf(current);
    if (waiting && waiting.side !== half.side && Math.abs(waiting.date - half.date) <= PAIR_WINDOW_S) {
      this.keys.delete(key);
      return paired(half, waiting);
    }
    this.set(key, encodeHalf(half), this.pendingTtlMs);
    return { paired: false };
  }

  async setLanguage(chat: string, language: VoiceLanguage) {
    this.set(`lang:${chatKey(chat)}`, language, LANGUAGE_TTL_MS);
  }

  async language(chat: string) {
    return languageFrom(this.get(`lang:${chatKey(chat)}`));
  }
}

/** KEYS: pending. ARGV: side, date, encoded half, window s, ttl ms. Returns the waiting half it took, or false. */
const PAIR_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local side, date = string.match(current, '^(%a+)|(%d+)|')
  if side and side ~= ARGV[1] and math.abs(tonumber(date) - tonumber(ARGV[2])) <= tonumber(ARGV[4]) then
    redis.call('DEL', KEYS[1])
    return current
  end
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[5])
return false
`;

const RELEASE_UPDATE_SCRIPT = `
if redis.call('GET', KEYS[1]) == 'processing' then redis.call('DEL', KEYS[1]) end
return 1
`;

/** Upstash's REST API, in the same database as the budget and the watchers. */
export class UpstashTelegramStore implements TelegramStore {
  private readonly pendingTtlMs: number;
  private readonly processingMs: number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
    opts: Ttls = {},
  ) {
    this.pendingTtlMs = opts.pendingTtlMs ?? PENDING_TTL_MS;
    this.processingMs = opts.processingMs ?? UPDATE_PROCESSING_MS;
  }

  private key(rest: string) {
    return `${this.prefix}:tg:${rest}`;
  }

  private async call(command: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command.map(String)),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  async claimUpdate(updateId: number) {
    return (await this.call(["SET", this.key(`update:${updateId}`), "processing", "NX", "PX", this.processingMs])) === "OK";
  }

  async releaseUpdate(updateId: number) {
    await this.call(["EVAL", RELEASE_UPDATE_SCRIPT, 1, this.key(`update:${updateId}`)]);
  }

  async finishUpdate(updateId: number) {
    await this.call(["SET", this.key(`update:${updateId}`), "done", "PX", UPDATE_DONE_MS]);
  }

  async pair(chat: string, half: Half): Promise<Pairing> {
    const taken = await this.call([
      "EVAL",
      PAIR_SCRIPT,
      1,
      this.key(`pending:${chatKey(chat)}`),
      half.side,
      half.date,
      encodeHalf(half),
      PAIR_WINDOW_S,
      this.pendingTtlMs,
    ]);
    const waiting = typeof taken === "string" ? decodeHalf(taken) : null;
    return waiting ? paired(half, waiting) : { paired: false };
  }

  async setLanguage(chat: string, language: VoiceLanguage) {
    await this.call(["SET", this.key(`lang:${chatKey(chat)}`), language, "PX", LANGUAGE_TTL_MS]);
  }

  async language(chat: string) {
    return languageFrom(await this.call(["GET", this.key(`lang:${chatKey(chat)}`)]));
  }
}

const sharedMemoryStore = (() => {
  let store: MemoryTelegramStore | null = null;
  return () => (store ??= new MemoryTelegramStore());
})();

/** The same database and switches as the watch store (lib/watch-store.ts); the memory store is never chosen when deployed. */
export function telegramStoreFromEnv(env: Record<string, string | undefined> = process.env): TelegramStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashTelegramStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashTelegramStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
