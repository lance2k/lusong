import type { AnswerKind, Point } from "./answer";
import type { WatchWindow } from "./watch-window";

/** A watcher nobody has opened Lusong about for this long deletes itself: its trip, chat and history. */
export const WATCH_TTL_MS = 30 * 24 * 60 * 60_000;
/** A Telegram link code is good for this long, and for one use. */
export const LINK_CODE_TTL_MS = 15 * 60_000;
/** Live watchers at once. Each one in its window costs the shared routing server a request every 10 minutes. */
export const MAX_WATCHERS = 100;

const ANSWER_KINDS: readonly AnswerKind[] = ["go", "go_another_way", "wait", "no_one_knows"];

export interface WatchTrip {
  from: Point;
  to: Point;
}

/** What Lusong keeps for a watcher while it is on. `id` is a hash of the phone's watcher token, never the token. */
export interface WatchRecord {
  id: string;
  /** Changes with every switch-on, so a run that outlives a switch-off can't write or send for the next one. */
  gen: string;
  trip: WatchTrip;
  window: WatchWindow;
  /** The Telegram chat it messages; null until the rider follows the link. */
  chatId: string | null;
  /** The answer in the last message sent, and the PHT day it was sent. */
  lastKind: AnswerKind | null;
  lastDay: string | null;
  /** Epoch ms of the last run claimed; 0 for never. */
  checkedAt: number;
}

export type NewWatcher = Pick<WatchRecord, "id" | "gen" | "trip" | "window">;

export interface WatchStore {
  /** Saves the watcher and its first link code, unless MAX_WATCHERS are already live. */
  create(watcher: NewWatcher, code: string): Promise<"created" | "full">;
  get(id: string): Promise<WatchRecord | null>;
  /** Restarts the watcher's 30 days. False when it is gone. */
  refresh(id: string): Promise<boolean>;
  /** Replaces the outstanding link code. False when the watcher is gone. */
  newCode(id: string, code: string): Promise<boolean>;
  /** Atomic and once only: binds the chat to the code's watcher and spends the code. Null when it is unknown, used or expired. */
  redeem(code: string, chatId: string): Promise<WatchRecord | null>;
  /** Every live watcher; index entries whose watcher expired are dropped. */
  list(): Promise<WatchRecord[]>;
  /** Atomic: marks a run at `nowMs` if the generation matches and the last run was at least `minGapMs` earlier. */
  claimRun(id: string, gen: string, nowMs: number, minGapMs: number): Promise<boolean>;
  isCurrent(id: string, gen: string): Promise<boolean>;
  /** Records the answer just sent, if the generation still matches. */
  commit(id: string, gen: string, last: { kind: AnswerKind; day: string }): Promise<boolean>;
  /** Deletes the trip, chat binding, history and any outstanding code. */
  remove(id: string): Promise<void>;
}

type Fields = Record<string, string>;

function fromFields(id: string, f: Fields): WatchRecord | null {
  try {
    const trip = JSON.parse(f.trip) as WatchTrip;
    const startMin = Number(f.start);
    const endMin = Number(f.end);
    if (![trip.from.lat, trip.from.lon, trip.to.lat, trip.to.lon, startMin, endMin].every(Number.isFinite)) return null;
    const lastKind = ANSWER_KINDS.find((k) => k === f.lastKind) ?? null;
    return {
      id,
      gen: f.gen,
      trip: { from: { lat: trip.from.lat, lon: trip.from.lon }, to: { lat: trip.to.lat, lon: trip.to.lon } },
      window: { startMin, endMin },
      chatId: f.chat || null,
      lastKind,
      lastDay: f.lastDay || null,
      checkedAt: Number(f.checkedAt) || 0,
    };
  } catch {
    return null;
  }
}

function newFields(w: NewWatcher, code: string): Fields {
  return { gen: w.gen, trip: JSON.stringify(w.trip), start: String(w.window.startMin), end: String(w.window.endMin), code, checkedAt: "0" };
}

interface StoreOptions {
  ttlMs?: number;
  codeTtlMs?: number;
  maxWatchers?: number;
}

/** For local development and tests only: each server instance would keep its own watchers. */
export class MemoryWatchStore implements WatchStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly codeTtlMs: number;
  private readonly maxWatchers: number;
  private records = new Map<string, { fields: Fields; expiresAt: number }>();
  private codes = new Map<string, { id: string; expiresAt: number }>();
  private index = { ids: new Set<string>(), expiresAt: 0 };

  constructor(opts: StoreOptions & { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? WATCH_TTL_MS;
    this.codeTtlMs = opts.codeTtlMs ?? LINK_CODE_TTL_MS;
    this.maxWatchers = opts.maxWatchers ?? MAX_WATCHERS;
  }

  private live(id: string): Fields | null {
    const entry = this.records.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.records.delete(id);
      return null;
    }
    return entry.fields;
  }

  private liveCode(code: string): string | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.codes.delete(code);
      return null;
    }
    return entry.id;
  }

  private liveIndex(): Set<string> {
    if (this.index.expiresAt <= this.now()) this.index.ids.clear();
    for (const id of this.index.ids) if (!this.live(id)) this.index.ids.delete(id);
    return this.index.ids;
  }

  /** Every live key as Upstash would name it, with its time to live in ms: for tests that check what is stored. */
  ttls(): Record<string, number> {
    const out: Record<string, number> = {};
    const t = this.now();
    for (const [id, entry] of this.records) if (this.live(id)) out[`lusong:watch:w:${id}`] = entry.expiresAt - t;
    for (const [code, entry] of this.codes) if (this.liveCode(code)) out[`lusong:watch-code:${code}`] = entry.expiresAt - t;
    if (this.index.expiresAt > t && this.index.ids.size > 0) out["lusong:watch:index"] = this.index.expiresAt - t;
    return out;
  }

  async create(w: NewWatcher, code: string) {
    const ids = this.liveIndex();
    if (ids.size >= this.maxWatchers) return "full" as const;
    this.records.set(w.id, { fields: newFields(w, code), expiresAt: this.now() + this.ttlMs });
    ids.add(w.id);
    this.index.expiresAt = this.now() + this.ttlMs;
    this.codes.set(code, { id: w.id, expiresAt: this.now() + this.codeTtlMs });
    return "created" as const;
  }

  async get(id: string) {
    const fields = this.live(id);
    return fields ? fromFields(id, fields) : null;
  }

  async refresh(id: string) {
    const entry = this.live(id) && this.records.get(id);
    if (!entry) return false;
    entry.expiresAt = this.now() + this.ttlMs;
    this.index.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  async newCode(id: string, code: string) {
    const fields = this.live(id);
    if (!fields) return false;
    if (fields.code) this.codes.delete(fields.code);
    fields.code = code;
    this.codes.set(code, { id, expiresAt: this.now() + this.codeTtlMs });
    return true;
  }

  async redeem(code: string, chatId: string) {
    const id = this.liveCode(code);
    if (id === null) return null;
    this.codes.delete(code);
    const fields = this.live(id);
    if (!fields || fields.code !== code) return null;
    fields.chat = chatId;
    delete fields.code;
    return fromFields(id, fields);
  }

  async list() {
    return [...this.liveIndex()].map((id) => fromFields(id, this.live(id)!)).filter((w) => w !== null);
  }

  async claimRun(id: string, gen: string, nowMs: number, minGapMs: number) {
    const fields = this.live(id);
    if (!fields || fields.gen !== gen || nowMs - Number(fields.checkedAt) < minGapMs) return false;
    fields.checkedAt = String(nowMs);
    return true;
  }

  async isCurrent(id: string, gen: string) {
    return this.live(id)?.gen === gen;
  }

  async commit(id: string, gen: string, last: { kind: AnswerKind; day: string }) {
    const fields = this.live(id);
    if (!fields || fields.gen !== gen) return false;
    fields.lastKind = last.kind;
    fields.lastDay = last.day;
    return true;
  }

  async remove(id: string) {
    const fields = this.live(id);
    if (fields?.code) this.codes.delete(fields.code);
    this.records.delete(id);
    this.index.ids.delete(id);
  }
}

/** KEYS: record, index, code. ARGV: id, record prefix, max, ttl, code ttl, code, then the fields as name, value pairs. */
const CREATE_SCRIPT = `
local live = 0
for _, m in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if redis.call('EXISTS', ARGV[2] .. m) == 1 then live = live + 1 else redis.call('SREM', KEYS[2], m) end
end
if live >= tonumber(ARGV[3]) then return 'full' end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 7))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[5])
return 'created'
`;

/** KEYS: record, index. */
const REFRESH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[1])
return 1
`;

/** KEYS: record, code prefix. ARGV: id, code, code ttl. */
const NEW_CODE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local old = redis.call('HGET', KEYS[1], 'code')
if old then redis.call('DEL', KEYS[2] .. old) end
redis.call('HSET', KEYS[1], 'code', ARGV[2])
redis.call('SET', KEYS[2] .. ARGV[2], ARGV[1], 'PX', ARGV[3])
return 1
`;

/** KEYS: code, record prefix. ARGV: code, chat. Returns the id, then the record's fields as name, value pairs. */
const REDEEM_SCRIPT = `
local id = redis.call('GET', KEYS[1])
if not id then return false end
redis.call('DEL', KEYS[1])
local record = KEYS[2] .. id
if redis.call('HGET', record, 'code') ~= ARGV[1] then return false end
redis.call('HSET', record, 'chat', ARGV[2])
redis.call('HDEL', record, 'code')
local out = { id }
for _, v in ipairs(redis.call('HGETALL', record)) do table.insert(out, v) end
return out
`;

/** KEYS: index, record prefix. Returns { id, fields... } for each live watcher. */
const LIST_SCRIPT = `
local out = {}
for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local fields = redis.call('HGETALL', KEYS[2] .. m)
  if #fields == 0 then
    redis.call('SREM', KEYS[1], m)
  else
    local row = { m }
    for _, v in ipairs(fields) do table.insert(row, v) end
    table.insert(out, row)
  end
end
return out
`;

/** A missing record's HGET is false, never equal to a generation, so none of these recreates a deleted watcher. */
const CLAIM_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) - tonumber(redis.call('HGET', KEYS[1], 'checkedAt') or '0') < tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], 'checkedAt', ARGV[2])
return 1
`;

const CURRENT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') == ARGV[1] then return 1 end
return 0
`;

const COMMIT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'lastKind', ARGV[2], 'lastDay', ARGV[3])
return 1
`;

/** KEYS: record, index, code prefix. */
const REMOVE_SCRIPT = `
local code = redis.call('HGET', KEYS[1], 'code')
if code then redis.call('DEL', KEYS[3] .. code) end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

function pairs(flat: unknown[]): Fields {
  const out: Fields = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
}

/** Upstash's REST API, one EVAL per operation, in the same database as the budget (lib/budget.ts). */
export class UpstashWatchStore implements WatchStore {
  private readonly ttlMs: number;
  private readonly codeTtlMs: number;
  private readonly maxWatchers: number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
    opts: StoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? WATCH_TTL_MS;
    this.codeTtlMs = opts.codeTtlMs ?? LINK_CODE_TTL_MS;
    this.maxWatchers = opts.maxWatchers ?? MAX_WATCHERS;
  }

  private record(id: string) {
    return `${this.prefix}:watch:w:${id}`;
  }
  private get index() {
    return `${this.prefix}:watch:index`;
  }
  private get codePrefix() {
    return `${this.prefix}:watch-code:`;
  }

  private async evalScript(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args.map(String)]),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  async create(w: NewWatcher, code: string) {
    const fields = Object.entries(newFields(w, code)).flat();
    const result = await this.evalScript(
      CREATE_SCRIPT,
      [this.record(w.id), this.index, this.codePrefix + code],
      [w.id, this.record(""), this.maxWatchers, this.ttlMs, this.codeTtlMs, code, ...fields],
    );
    if (result === "created" || result === "full") return result;
    throw new Error(`unexpected create result ${JSON.stringify(result)}`);
  }

  async get(id: string) {
    const result = await this.evalScript("return redis.call('HGETALL', KEYS[1])", [this.record(id)], []);
    if (!Array.isArray(result)) throw new Error("unexpected watcher read");
    return result.length === 0 ? null : fromFields(id, pairs(result));
  }

  async refresh(id: string) {
    return (await this.evalScript(REFRESH_SCRIPT, [this.record(id), this.index], [this.ttlMs])) === 1;
  }

  async newCode(id: string, code: string) {
    return (await this.evalScript(NEW_CODE_SCRIPT, [this.record(id), this.codePrefix], [id, code, this.codeTtlMs])) === 1;
  }

  async redeem(code: string, chatId: string) {
    const result = await this.evalScript(REDEEM_SCRIPT, [this.codePrefix + code, this.record("")], [code, chatId]);
    if (!Array.isArray(result)) return null;
    const [id, ...flat] = result;
    return fromFields(String(id), pairs(flat));
  }

  async list() {
    const result = await this.evalScript(LIST_SCRIPT, [this.index, this.record("")], []);
    if (!Array.isArray(result)) throw new Error("unexpected watcher list");
    return result
      .map((row) => (Array.isArray(row) && row.length > 0 ? fromFields(String(row[0]), pairs(row.slice(1))) : null))
      .filter((w) => w !== null);
  }

  async claimRun(id: string, gen: string, nowMs: number, minGapMs: number) {
    return (await this.evalScript(CLAIM_SCRIPT, [this.record(id)], [gen, nowMs, minGapMs])) === 1;
  }

  async isCurrent(id: string, gen: string) {
    return (await this.evalScript(CURRENT_SCRIPT, [this.record(id)], [gen])) === 1;
  }

  async commit(id: string, gen: string, last: { kind: AnswerKind; day: string }) {
    return (await this.evalScript(COMMIT_SCRIPT, [this.record(id)], [gen, last.kind, last.day])) === 1;
  }

  async remove(id: string) {
    await this.evalScript(REMOVE_SCRIPT, [this.record(id), this.index, this.codePrefix], [id]);
  }
}

const sharedMemoryStore = (() => {
  let store: MemoryWatchStore | null = null;
  return () => (store ??= new MemoryWatchStore());
})();

/** The same database and switches as the budget (lib/budget.ts); the memory store is never chosen when deployed. */
export function watchStoreFromEnv(env: Record<string, string | undefined> = process.env): WatchStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashWatchStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashWatchStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
