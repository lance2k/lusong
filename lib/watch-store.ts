import { randomUUID } from "node:crypto";
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
  /**
   * An answer whose message was handed to Telegram and not yet recorded as sent. It counts as sent, so a message whose
   * delivery is uncertain is never sent twice; the cost is that one may be missed, and the page still shows the answer.
   */
  sending: SentAnswer | null;
  /** Epoch ms of the last run claimed; 0 for never. */
  checkedAt: number;
  /** Set when a switch-off has begun (S4P-2): no send is claimed for it from then on. */
  stopping?: true;
}

export type NewWatcher = Pick<WatchRecord, "id" | "gen" | "trip" | "window">;

export interface SentAnswer {
  kind: AnswerKind;
  day: string;
}

/**
 * An alert send's durable claim (S4P-1): `value` is the `attempt:<ms>` written before the send, `tries` the confirmed
 * rejections before it. Refused: "gone" (switched off, stopping or switched on again), "done" (sent, ambiguous, given up,
 * or an attempt whose outcome is unknown), "soon" (a retry not yet due, or this chat had an alert under a second ago).
 */
export type AlertClaim = { claimed: true; value: string; tries: number } | { claimed: false; why: "gone" | "done" | "soon" };

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
  /**
   * Before a send: records the answer about to go, if the generation still matches. False means don't send. Atomic: an
   * answer still marked as sending from an earlier send is first recorded as the last sent, since its delivery is
   * uncertain, so dropping the new one falls back to it rather than to an older answer.
   */
  markSending(id: string, gen: string, answer: SentAnswer): Promise<boolean>;
  /** When the message wasn't sent (refused, or called off before sending): the next check may send it again. */
  dropSending(id: string, gen: string): Promise<void>;
  /** Records the answer just sent and clears the one marked as sending, if the generation still matches. */
  commit(id: string, gen: string, last: SentAnswer): Promise<boolean>;
  /**
   * `SET NX PX`: the watcher's send lease, held by a tick from its last check that the watcher is on until its send is
   * done, and by a switch-off while it deletes the watcher. A token when taken, null when someone else holds it.
   */
  takeSendLease(id: string, ttlMs: number): Promise<string | null>;
  /** Frees the lease only if `token` still holds it, so a late release can't free someone else's. */
  releaseSendLease(id: string, token: string): Promise<void>;
  /** Deletes the trip, chat binding, history, send lease, route line, alert history and any outstanding code. */
  remove(id: string): Promise<void>;
  /** The first step of a switch-off (S4P-2): from now on no send is claimed for it. False when it is gone. */
  markStopping(id: string): Promise<boolean>;
  /** The line of the trip's last checked route (S4P-6), kept as long as the watcher, if the generation still matches. */
  saveRoute(id: string, gen: string, line: readonly Point[]): Promise<boolean>;
  /** Each watcher's stored route line, or null, in one read. */
  routes(ids: readonly string[]): Promise<(Point[] | null)[]>;
  /** The delivery state of each `<alertId>@<version>` for this watcher, in one read (S4P-9). */
  alertStates(id: string, members: readonly string[]): Promise<(string | null)[]>;
  /** alertStates for several watchers in one read (S4D-1): one store call for a whole batch. */
  alertStatesMany(entries: readonly { id: string; members: readonly string[] }[]): Promise<(string | null)[][]>;
  /**
   * Atomic, before an alert send (S4P-1): the watcher still exists with this generation and isn't stopping, the alert
   * version was never claimed or is a retry whose time has come, and the chat had no alert in the last `chatGapMs`.
   * Then writes `attempt:<nowMs>` for it.
   */
  claimAlert(id: string, gen: string, member: string, nowMs: number, chatGapMs: number): Promise<AlertClaim>;
  /** After the send: replaces the claim with `next` (null deletes it), only while the claim is still what is stored. */
  settleAlert(id: string, member: string, claimed: string, next: string | null): Promise<boolean>;
}

type Fields = Record<string, string>;

function fromFields(id: string, f: Fields): WatchRecord | null {
  try {
    const trip = JSON.parse(f.trip) as WatchTrip;
    const startMin = Number(f.start);
    const endMin = Number(f.end);
    if (![trip.from.lat, trip.from.lon, trip.to.lat, trip.to.lon, startMin, endMin].every(Number.isFinite)) return null;
    const lastKind = ANSWER_KINDS.find((k) => k === f.lastKind) ?? null;
    const [sendingKind, sendingDay] = (f.sending ?? "").split("|");
    const sendingAs = ANSWER_KINDS.find((k) => k === sendingKind);
    return {
      id,
      gen: f.gen,
      trip: { from: { lat: trip.from.lat, lon: trip.from.lon }, to: { lat: trip.to.lat, lon: trip.to.lon } },
      window: { startMin, endMin },
      chatId: f.chat || null,
      lastKind,
      lastDay: f.lastDay || null,
      sending: sendingAs && sendingDay ? { kind: sendingAs, day: sendingDay } : null,
      checkedAt: Number(f.checkedAt) || 0,
      ...(f.stopping ? { stopping: true as const } : {}),
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
  /** A watcher's route line and alert history live and expire with its record, as their own keys do on Upstash. */
  private records = new Map<string, { fields: Fields; expiresAt: number; route?: Point[]; alerts?: Map<string, string> }>();
  private codes = new Map<string, { id: string; expiresAt: number }>();
  private index = { ids: new Set<string>(), expiresAt: 0 };
  private leases = new Map<string, { token: string; expiresAt: number }>();

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
    for (const [id, entry] of this.records) {
      if (!this.live(id)) continue;
      out[`lusong:watch:w:${id}`] = entry.expiresAt - t;
      if (entry.route) out[`lusong:watch:route:v1:${id}`] = entry.expiresAt - t;
      if (entry.alerts?.size) out[`lusong:alert-sent:v1:${id}`] = entry.expiresAt - t;
    }
    for (const [code, entry] of this.codes) if (this.liveCode(code)) out[`lusong:watch-code:${code}`] = entry.expiresAt - t;
    if (this.index.expiresAt > t && this.index.ids.size > 0) out["lusong:watch:index"] = this.index.expiresAt - t;
    for (const [id, lease] of this.leases) if (lease.expiresAt > t) out[`lusong:watch:lease:${id}`] = lease.expiresAt - t;
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

  async markSending(id: string, gen: string, answer: SentAnswer) {
    const fields = this.live(id);
    if (!fields || fields.gen !== gen || fields.stopping) return false;
    const uncertain = fromFields(id, fields)?.sending;
    if (uncertain) {
      fields.lastKind = uncertain.kind;
      fields.lastDay = uncertain.day;
    }
    fields.sending = `${answer.kind}|${answer.day}`;
    return true;
  }

  async dropSending(id: string, gen: string) {
    const fields = this.live(id);
    if (fields?.gen === gen) delete fields.sending;
  }

  async commit(id: string, gen: string, last: SentAnswer) {
    const fields = this.live(id);
    if (!fields || fields.gen !== gen) return false;
    fields.lastKind = last.kind;
    fields.lastDay = last.day;
    delete fields.sending;
    return true;
  }

  async takeSendLease(id: string, ttlMs: number) {
    if ((this.leases.get(id)?.expiresAt ?? 0) > this.now()) return null;
    const token = randomUUID();
    this.leases.set(id, { token, expiresAt: this.now() + ttlMs });
    return token;
  }

  async releaseSendLease(id: string, token: string) {
    if (this.leases.get(id)?.token === token) this.leases.delete(id);
  }

  async remove(id: string) {
    const fields = this.live(id);
    if (fields?.code) this.codes.delete(fields.code);
    this.records.delete(id);
    this.index.ids.delete(id);
    this.leases.delete(id);
  }

  async markStopping(id: string) {
    const fields = this.live(id);
    if (!fields) return false;
    fields.stopping = "1";
    return true;
  }

  async saveRoute(id: string, gen: string, line: readonly Point[]) {
    const entry = this.live(id)?.gen === gen ? this.records.get(id) : undefined;
    if (!entry) return false;
    entry.route = line.map((p) => ({ lat: p.lat, lon: p.lon }));
    return true;
  }

  async routes(ids: readonly string[]) {
    return ids.map((id) => (this.live(id) ? (this.records.get(id)!.route ?? null) : null));
  }

  async alertStates(id: string, members: readonly string[]) {
    const alerts = this.live(id) ? this.records.get(id)!.alerts : undefined;
    return members.map((m) => alerts?.get(m) ?? null);
  }

  async alertStatesMany(entries: readonly { id: string; members: readonly string[] }[]) {
    return Promise.all(entries.map((e) => this.alertStates(e.id, e.members)));
  }

  async claimAlert(id: string, gen: string, member: string, nowMs: number, chatGapMs: number): Promise<AlertClaim> {
    const fields = this.live(id);
    if (!fields || fields.gen !== gen || fields.stopping) return { claimed: false, why: "gone" };
    const entry = this.records.get(id)!;
    const alerts = (entry.alerts ??= new Map());
    const verdict = claimVerdict(alerts.get(member) ?? null, Number(fields.alertAt ?? 0), nowMs, chatGapMs);
    if (!verdict.claimed) return verdict;
    alerts.set(member, verdict.value);
    fields.alertAt = String(nowMs);
    return verdict;
  }

  async settleAlert(id: string, member: string, claimed: string, next: string | null) {
    const alerts = this.live(id) ? this.records.get(id)!.alerts : undefined;
    if (!alerts || alerts.get(member) !== claimed) return false;
    if (next === null) alerts.delete(member);
    else alerts.set(member, next);
    return true;
  }
}

/** The claim rule both stores apply, in claimAlert's one step. */
function claimVerdict(state: string | null, lastAlertAt: number, nowMs: number, chatGapMs: number): AlertClaim {
  let tries = 0;
  if (state !== null) {
    const retry = /^retry:(\d+):(\d+)$/.exec(state);
    if (!retry) return { claimed: false, why: "done" };
    if (Number(retry[2]) > nowMs) return { claimed: false, why: "soon" };
    tries = Number(retry[1]);
  }
  if (nowMs - lastAlertAt < chatGapMs) return { claimed: false, why: "soon" };
  return { claimed: true, value: `attempt:${nowMs}`, tries };
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

/** KEYS: record, index, route line, alert history. */
const REFRESH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[3], ARGV[1])
redis.call('PEXPIRE', KEYS[4], ARGV[1])
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

/** An answer still marked as sending becomes the last sent before the new one is marked; see WatchStore.markSending. */
const MARK_SENDING_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 0 end
if redis.call('HEXISTS', KEYS[1], 'stopping') == 1 then return 0 end
local uncertain = redis.call('HGET', KEYS[1], 'sending')
if uncertain then
  local kind, day = string.match(uncertain, '^([^|]+)|(.+)$')
  if kind then redis.call('HSET', KEYS[1], 'lastKind', kind, 'lastDay', day) end
end
redis.call('HSET', KEYS[1], 'sending', ARGV[2])
return 1
`;

const DROP_SENDING_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') == ARGV[1] then redis.call('HDEL', KEYS[1], 'sending') end
return 1
`;

const COMMIT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'lastKind', ARGV[2], 'lastDay', ARGV[3])
redis.call('HDEL', KEYS[1], 'sending')
return 1
`;

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
`;

/** KEYS: record, index, code prefix, lease, route line, alert history. */
const REMOVE_SCRIPT = `
local code = redis.call('HGET', KEYS[1], 'code')
if code then redis.call('DEL', KEYS[3] .. code) end
redis.call('DEL', KEYS[1], KEYS[4], KEYS[5], KEYS[6])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

const MARK_STOPPING_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'stopping', '1')
return 1
`;

/** KEYS: record, route line. Kept as long as the record has left. */
const SAVE_ROUTE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
return 1
`;

/** KEYS: record, alert history. ARGV: gen, member, now ms, chat gap ms. The same rule as claimVerdict. */
const CLAIM_ALERT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'gen') ~= ARGV[1] then return 'gone' end
if redis.call('HEXISTS', KEYS[1], 'stopping') == 1 then return 'gone' end
local now = tonumber(ARGV[3])
local tries = 0
local state = redis.call('HGET', KEYS[2], ARGV[2])
if state then
  local n, notBefore = string.match(state, '^retry:(%d+):(%d+)$')
  if not n then return 'done' end
  if tonumber(notBefore) > now then return 'soon' end
  tries = tonumber(n)
end
if now - tonumber(redis.call('HGET', KEYS[1], 'alertAt') or '0') < tonumber(ARGV[4]) then return 'soon' end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 'gone' end
redis.call('HSET', KEYS[2], ARGV[2], 'attempt:' .. ARGV[3])
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('HSET', KEYS[1], 'alertAt', ARGV[3])
return 'claimed:' .. tries
`;

/** KEYS: alert history. ARGV: member, claim, next ('' deletes). */
const SETTLE_ALERT_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1
`;

function pairs(flat: unknown[]): Fields {
  const out: Fields = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
}

/** Upstash's REST API, one EVAL per operation, in the same database as the budget (lib/budget.ts). */
/** One HMGET per key; ARGV is each key's member count followed by its members. */
const ALERT_STATES_MANY_SCRIPT = `
local out = {}
local at = 1
for i, key in ipairs(KEYS) do
  local n = tonumber(ARGV[at])
  at = at + 1
  if n == 0 then
    out[i] = {}
  else
    out[i] = redis.call('HMGET', key, unpack(ARGV, at, at + n - 1))
  end
  at = at + n
end
return out
`;

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
  private lease(id: string) {
    return `${this.prefix}:watch:lease:${id}`;
  }
  private get codePrefix() {
    return `${this.prefix}:watch-code:`;
  }
  private route(id: string) {
    return `${this.prefix}:watch:route:v1:${id}`;
  }
  private alertsSent(id: string) {
    return `${this.prefix}:alert-sent:v1:${id}`;
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
    return (await this.evalScript(REFRESH_SCRIPT, [this.record(id), this.index, this.route(id), this.alertsSent(id)], [this.ttlMs])) === 1;
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

  async markSending(id: string, gen: string, answer: SentAnswer) {
    return (await this.evalScript(MARK_SENDING_SCRIPT, [this.record(id)], [gen, `${answer.kind}|${answer.day}`])) === 1;
  }

  async dropSending(id: string, gen: string) {
    await this.evalScript(DROP_SENDING_SCRIPT, [this.record(id)], [gen]);
  }

  async commit(id: string, gen: string, last: SentAnswer) {
    return (await this.evalScript(COMMIT_SCRIPT, [this.record(id)], [gen, last.kind, last.day])) === 1;
  }

  async takeSendLease(id: string, ttlMs: number) {
    const token = randomUUID();
    const result = await this.evalScript("return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])", [this.lease(id)], [token, ttlMs]);
    return result === "OK" ? token : null;
  }

  async releaseSendLease(id: string, token: string) {
    await this.evalScript(RELEASE_LEASE_SCRIPT, [this.lease(id)], [token]);
  }

  async remove(id: string) {
    await this.evalScript(REMOVE_SCRIPT, [this.record(id), this.index, this.codePrefix, this.lease(id), this.route(id), this.alertsSent(id)], [id]);
  }

  async markStopping(id: string) {
    return (await this.evalScript(MARK_STOPPING_SCRIPT, [this.record(id)], [])) === 1;
  }

  async saveRoute(id: string, gen: string, line: readonly Point[]) {
    const json = JSON.stringify(line.map((p) => [p.lat, p.lon]));
    return (await this.evalScript(SAVE_ROUTE_SCRIPT, [this.record(id), this.route(id)], [gen, json])) === 1;
  }

  async routes(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const result = await this.evalScript("return redis.call('MGET', unpack(KEYS))", ids.map((id) => this.route(id)), []);
    if (!Array.isArray(result) || result.length !== ids.length) throw new Error("unexpected route read");
    return result.map((value) => (typeof value === "string" ? lineFrom(value) : null));
  }

  async alertStates(id: string, members: readonly string[]) {
    if (members.length === 0) return [];
    const result = await this.evalScript("return redis.call('HMGET', KEYS[1], unpack(ARGV))", [this.alertsSent(id)], [...members]);
    if (!Array.isArray(result) || result.length !== members.length) throw new Error("unexpected alert state read");
    return result.map((value) => (typeof value === "string" ? value : null));
  }

  async alertStatesMany(entries: readonly { id: string; members: readonly string[] }[]) {
    if (entries.length === 0) return [];
    const result = await this.evalScript(
      ALERT_STATES_MANY_SCRIPT,
      entries.map((e) => this.alertsSent(e.id)),
      entries.flatMap((e) => [e.members.length, ...e.members]),
    );
    if (!Array.isArray(result) || result.length !== entries.length) throw new Error("unexpected alert state read");
    return entries.map((e, i) => {
      const row = result[i];
      if (e.members.length === 0) return [];
      if (!Array.isArray(row) || row.length !== e.members.length) throw new Error("unexpected alert state read");
      return row.map((value) => (typeof value === "string" ? value : null));
    });
  }

  async claimAlert(id: string, gen: string, member: string, nowMs: number, chatGapMs: number): Promise<AlertClaim> {
    const result = await this.evalScript(CLAIM_ALERT_SCRIPT, [this.record(id), this.alertsSent(id)], [gen, member, nowMs, chatGapMs]);
    const claimed = typeof result === "string" ? /^claimed:(\d+)$/.exec(result) : null;
    if (claimed) return { claimed: true, value: `attempt:${nowMs}`, tries: Number(claimed[1]) };
    if (result === "gone" || result === "done" || result === "soon") return { claimed: false, why: result };
    throw new Error(`unexpected alert claim result ${JSON.stringify(result)}`);
  }

  async settleAlert(id: string, member: string, claimed: string, next: string | null) {
    return (await this.evalScript(SETTLE_ALERT_SCRIPT, [this.alertsSent(id)], [member, claimed, next ?? ""])) === 1;
  }
}

function lineFrom(json: string): Point[] | null {
  try {
    const pairs = JSON.parse(json) as unknown;
    if (!Array.isArray(pairs)) return null;
    const line = pairs.map((p) => (Array.isArray(p) ? { lat: Number(p[0]), lon: Number(p[1]) } : { lat: NaN, lon: NaN }));
    return line.length >= 2 && line.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)) ? line : null;
  } catch {
    return null;
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
