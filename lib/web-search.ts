import { randomUUID } from "node:crypto";
import { admit, type AdmittedRun } from "./admission";
import type { Point } from "./answer";
import {
  ATTEMPTS_PER_CALL,
  budgetStoreFromEnv,
  createBudget,
  MUSE_INPUT_MICROS_PER_TOKEN,
  MUSE_OUTPUT_MICROS_PER_TOKEN,
  WEB_SEARCH_QUERY_MICROS,
  type Budget,
} from "./budget";
import type { Meter } from "./meta";
import { respond, type SparkReply } from "./spark-responses";

/**
 * Muse Spark's built-in web search for road closures in Metro Cebu today. "Road closures in Cebu today" isn't trip
 * specific, so one search serves every check for WEB_SEARCH_CACHE_MS, through a store every instance shares.
 * One probe search (2026-10-30, 1 draw) took 23 s, ran 11 search actions and 90,257 input tokens, and ran out of its
 * 3,000 output tokens before answering: about $0.15.
 */

export const WEB_SEARCH_KEY = "lusong:muse:road-closures";
export const WEB_SEARCH_CACHE_MS = 60 * 60_000;
/** A failed search is not retried for this long, so a failing search isn't paid for on every check. */
export const WEB_SEARCH_FAILED_CACHE_MS = 5 * 60_000;
/** Above the probe's 3,000, which ran out before any answer. Not yet measured. */
export const SEARCH_MAX_OUTPUT_TOKENS = 4_000;
/** The probe took 23 s at 3,000 output tokens (1 draw). */
export const SEARCH_ATTEMPT_MS = 35_000;
export const MAX_WEB_FINDINGS = 8;

/** Held while one check searches, so checks that miss the cache at the same moment don't each pay for a search. */
export const WEB_SEARCH_LEASE_KEY = "lusong:muse:road-closures:lease";
/** Both attempts of a search, with room to store it; a search still running past this may overlap another. */
export const SEARCH_LEASE_MS = ATTEMPTS_PER_CALL * SEARCH_ATTEMPT_MS + 10_000;

/** 2.2 × the probe search's 90,257 input tokens, which ran 11 actions at a 3,000-token output cap (1 draw). */
export const SEARCH_INPUT_TOKEN_BOUND = 200_000;
/**
 * The API showed no max_tool_calls in its reply, so the number of search actions isn't capped: twice the probe's 11 are
 * reserved, every action counted as a query, and any beyond are charged when the reply's usage is settled.
 */
export const SEARCH_QUERIES_RESERVED = 22;
/** One search's worst case with its retry, in µ$: an estimate from one draw, which is why searches have their own cap. */
export const SEARCH_RESERVE_MICROS = Math.ceil(
  ATTEMPTS_PER_CALL *
    (SEARCH_INPUT_TOKEN_BOUND * MUSE_INPUT_MICROS_PER_TOKEN +
      SEARCH_MAX_OUTPUT_TOKENS * MUSE_OUTPUT_MICROS_PER_TOKEN +
      SEARCH_QUERIES_RESERVED * WEB_SEARCH_QUERY_MICROS),
);

/** Web search spend per UTC day, apart from (and inside) the daily budget. */
export const SEARCH_DAILY_BUDGET_USD = 3;
/** The search cap's ledger keys: `lusong:search:spent:<day>` and `lusong:search:res:<id>`. */
export const SEARCH_BUDGET_PREFIX = "lusong:search";

export function searchBudgetFromEnv(env: Record<string, string | undefined> = process.env): Budget {
  return createBudget({ store: budgetStoreFromEnv(env, SEARCH_BUDGET_PREFIX), budgetUsd: SEARCH_DAILY_BUDGET_USD, ipLimit: 1 });
}

/**
 * Metro Cebu, drawn generously by hand from Danao in the north to Carcar in the south and Mactan in the east (not an
 * official boundary). A location the model gives outside it is not used.
 */
export const METRO_CEBU = { south: 10.05, north: 10.6, west: 123.65, east: 124.1 } as const;

export function inMetroCebu(p: { lat: unknown; lon: unknown }): p is Point {
  return (
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    p.lat >= METRO_CEBU.south &&
    p.lat <= METRO_CEBU.north &&
    p.lon >= METRO_CEBU.west &&
    p.lon <= METRO_CEBU.east
  );
}

/** What a source says about a road, from a fixed list: the page describes it in Lusong's words, never the source's. */
export const CLOSURE_KINDS = ["closed", "flooded", "not_passable", "other_blocking"] as const;
export type ClosureKind = (typeof CLOSURE_KINDS)[number];

export interface WebFinding {
  id: string;
  /** A place name as the source gives it: checked to read as a name (placeLabel), the only words kept from the search. */
  place: string;
  /** Null when the model gave no location, or one outside Metro Cebu: shown, never placed on a route. */
  at: Point | null;
  url: string;
  /** YYYY-MM-DD as the source dates it, or null when undated. */
  sourceDate: string | null;
  kind: ClosureKind;
}

export type WebEvidence =
  | { state: "searched"; searchedAt: string; findings: WebFinding[] }
  | { state: "failed" | "not_run"; why: string; searchedAt: string | null; findings: WebFinding[] };

/** `GET`, `SET … PX` and a lease: the same Upstash database as the budget, keys under `lusong:`. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** `SET … NX PX`: true when the key was free and is now this value. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only while it still holds this value, so a lapsed lease never frees another check's. */
  deleteIfEquals(key: string, value: string): Promise<void>;
  /** Sets the key only while it still holds `expected` (null: while it is absent), in one step; true when it was set. */
  compareAndSet(key: string, expected: string | null, value: string, ttlMs: number): Promise<boolean>;
}

export class MemoryKvStore implements KvStore {
  private values = new Map<string, { value: string; until: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  private read(key: string): string | null {
    const entry = this.values.get(key);
    return entry && entry.until > this.clock() ? entry.value : null;
  }

  async get(key: string) {
    return this.read(key);
  }

  async set(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, until: this.clock() + ttlMs });
  }

  // Read and write with no await between them, as Redis's SET NX does in one step.
  async setIfAbsent(key: string, value: string, ttlMs: number) {
    if (this.read(key) !== null) return false;
    this.values.set(key, { value, until: this.clock() + ttlMs });
    return true;
  }

  async deleteIfEquals(key: string, value: string) {
    if (this.read(key) === value) this.values.delete(key);
  }

  async compareAndSet(key: string, expected: string | null, value: string, ttlMs: number) {
    if (this.read(key) !== expected) return false;
    this.values.set(key, { value, until: this.clock() + ttlMs });
    return true;
  }
}

const DELETE_IF_EQUALS = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
// An absent key reads as false in Lua, so "expect it absent" is its own argument rather than an empty string.
const COMPARE_AND_SET =
  'local current = redis.call("GET", KEYS[1]) ' +
  'if (ARGV[1] == "absent" and current == false) or (ARGV[1] == "equals" and current == ARGV[2]) then ' +
  'redis.call("SET", KEYS[1], ARGV[3], "PX", ARGV[4]) return 1 else return 0 end';

export class UpstashKvStore implements KvStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "",
  ) {}

  private async command(args: string[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  private key(key: string) {
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async get(key: string) {
    const result = await this.command(["GET", this.key(key)]);
    return typeof result === "string" ? result : null;
  }

  async set(key: string, value: string, ttlMs: number) {
    await this.command(["SET", this.key(key), value, "PX", String(ttlMs)]);
  }

  async setIfAbsent(key: string, value: string, ttlMs: number) {
    return (await this.command(["SET", this.key(key), value, "NX", "PX", String(ttlMs)])) === "OK";
  }

  async deleteIfEquals(key: string, value: string) {
    await this.command(["EVAL", DELETE_IF_EQUALS, "1", this.key(key), value]);
  }

  async compareAndSet(key: string, expected: string | null, value: string, ttlMs: number) {
    const args = expected === null ? ["absent", ""] : ["equals", expected];
    return (await this.command(["EVAL", COMPARE_AND_SET, "1", this.key(key), ...args, value, String(ttlMs)])) === 1;
  }
}

const sharedMemoryStore = (() => {
  let store: MemoryKvStore | null = null;
  return () => (store ??= new MemoryKvStore());
})();

/** The same store and switches as the budget (lib/budget.ts); none configured means no search. */
export function searchStoreFromEnv(env: Record<string, string | undefined> = process.env): KvStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashKvStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashKvStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}

/** A planned search holds its reservation against the daily search cap until it runs or is released. */
export type WebPlan =
  | { kind: "cached"; evidence: WebEvidence }
  | { kind: "search"; run: AdmittedRun; lease: Lease; startedAt: number }
  | { kind: "off"; why: string };

interface Lease {
  store: KvStore;
  token: string;
}

interface Stored {
  expiresAt: number;
  /** When its search started: a search that started earlier never replaces it. */
  startedAt: number;
  evidence: WebEvidence;
  /** The pages its search opened or cited, so a stored finding's link is checked against them as a fresh one is. */
  pages: string[];
}

function readStored(text: string): Stored | null {
  try {
    const stored = JSON.parse(text) as Stored;
    const e = stored?.evidence;
    if (typeof stored.expiresAt !== "number" || typeof stored.startedAt !== "number") return null;
    if (!e || !Array.isArray(e.findings) || !["searched", "failed"].includes(e.state)) return null;
    // A record stored under older checks is searched again rather than trusted.
    if (!Array.isArray(stored.pages) || !stored.pages.every((page) => canonicalUrl(page) === page)) return null;
    if (!e.findings.every((f) => isStoredFinding(f) && stored.pages.includes(f.url))) return null;
    return stored;
  } catch {
    return null;
  }
}

/** Decided before admission, since a search changes what the check must reserve. */
export async function planWebSearch(store: KvStore | null, now: Date, searchBudget: Budget): Promise<WebPlan> {
  if (!store) return { kind: "off", why: "no shared store" };
  const unreachable: WebPlan = { kind: "off", why: "store unreachable" };
  const fresh = async () => {
    const text = await store.get(WEB_SEARCH_KEY);
    const stored = text === null ? null : readStored(text);
    return stored && stored.expiresAt > now.getTime() ? stored : null;
  };
  try {
    const cached = await fresh();
    if (cached) return { kind: "cached", evidence: cached.evidence };
  } catch {
    return unreachable;
  }
  const lease: Lease = { store, token: randomUUID() };
  try {
    if (!(await store.setIfAbsent(WEB_SEARCH_LEASE_KEY, lease.token, SEARCH_LEASE_MS))) return { kind: "off", why: "another check is searching the web right now" };
  } catch {
    return unreachable;
  }
  // A search another check finished between the first read and the lease.
  let cached: Stored | null;
  try {
    cached = await fresh();
  } catch {
    await giveBack(lease);
    return unreachable;
  }
  if (cached) {
    await giveBack(lease);
    return { kind: "cached", evidence: cached.evidence };
  }
  const admission = await admit(searchBudget, { clientIp: null, reserveMicros: SEARCH_RESERVE_MICROS, now });
  if (!admission.ok) {
    await giveBack(lease);
    return { kind: "off", why: admission.reason === "budget" ? "today's web search budget is used up" : "the web search budget can't be read" };
  }
  return { kind: "search", run: admission.run, lease, startedAt: now.getTime() };
}

async function giveBack(lease: Lease): Promise<void> {
  try {
    await lease.store.deleteIfEquals(WEB_SEARCH_LEASE_KEY, lease.token);
  } catch (err) {
    console.error("couldn't give back the web search lease:", err instanceof Error ? err.message : err);
  }
}

/** Gives back a planned search's reservation and lease when the check is refused before it runs. */
export async function releaseWebSearch(plan: WebPlan): Promise<void> {
  if (plan.kind !== "search") return;
  await plan.run.settle(true);
  await giveBack(plan.lease);
}

const KEEP_ATTEMPTS = 3;

/**
 * Stores the result unless the stored one should stand: a search that started later, or a success still fresh when
 * this one failed. The write only lands on the value that was read, so a search that outlived its lease can't overwrite
 * one stored between its read and its write; it reads again and decides again.
 */
async function keep(store: KvStore, record: Stored, now: Date): Promise<void> {
  for (let attempt = 0; attempt < KEEP_ATTEMPTS; attempt++) {
    const text = await store.get(WEB_SEARCH_KEY);
    const current = text === null ? null : readStored(text);
    if (current && current.startedAt > record.startedAt) return;
    if (current && current.evidence.state === "searched" && current.expiresAt > now.getTime() && record.evidence.state !== "searched") return;
    if (await store.compareAndSet(WEB_SEARCH_KEY, text, JSON.stringify(record), record.expiresAt - now.getTime())) return;
  }
  console.error(`couldn't store the web search: the stored result changed under it ${KEEP_ATTEMPTS} times`);
}

function phtDay(t: Date): string {
  return new Date(t.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function searchPrompt(now: Date): string {
  return [
    `Search the web for roads in Metro Cebu, Philippines, reported closed or not passable because of flooding today, ${phtDay(now)} (Philippine time).`,
    "Make at most three searches and open at most two pages, then answer with only a JSON object:",
    '{"closures":[{"place":"road or area name","lat":number or null,"lon":number or null,"url":"the page that reports it",' +
      '"date":"YYYY-MM-DD the page gives for it, or null","kind":"closed", "flooded", "not_passable" or "other_blocking"}]}.',
    "Use an empty list if you find none. Give lat and lon only when the page or a well-known landmark places it.",
  ].join(" ");
}

function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const URL_MAX_CHARS = 500;

/**
 * An http(s) link as it is stored and compared: normalised, with no fragment, and within URL_MAX_CHARS in that form,
 * since percent-encoding can make a short Unicode link several times longer. Null for anything else.
 */
function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.href.length <= URL_MAX_CHARS ? url.href : null;
  } catch {
    return null;
  }
}

/** The pages the search tool itself opened or cited: a finding's link is the model's to write, so it must be one of these. */
function toolPages(reply: SparkReply): string[] {
  const opened = reply.webSearchActions.flatMap((a) => (a.type === "open_page" ? [a.url] : []));
  const pages = [...opened, ...reply.citedUrls].map(canonicalUrl).filter((u): u is string => u !== null);
  return [...new Set(pages)];
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === value ? value : null;
}

const PLACE_MAX_CHARS = 80;
const PLACE_MAX_WORDS = 12;
const PLACE_CHARACTERS = /^[\p{L}\p{M}\p{N} .,'’&()/-]+$/u;

/**
 * The place as a name, or null. Long names such as "Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue" pass; text
 * with sentence punctuation, past the length or ending in a full stop after a long word (not "Blvd.") does not.
 */
function placeLabel(value: unknown): string | null {
  const place = plainText(value, 200);
  if (place.length < 2 || place.length > PLACE_MAX_CHARS || !PLACE_CHARACTERS.test(place)) return null;
  const words = place.split(" ");
  if (words.length > PLACE_MAX_WORDS) return null;
  const last = words[words.length - 1];
  return last.endsWith(".") && last.length > 5 ? null : place;
}

function closureKind(value: unknown): ClosureKind | null {
  return (CLOSURE_KINDS as readonly unknown[]).includes(value) ? (value as ClosureKind) : null;
}

function isStoredFinding(f: unknown): f is WebFinding {
  if (typeof f !== "object" || f === null) return false;
  const x = f as Record<string, unknown>;
  const at = x.at as { lat: unknown; lon: unknown } | null;
  return (
    Object.keys(x).length === 6 &&
    typeof x.id === "string" &&
    placeLabel(x.place) === x.place &&
    canonicalUrl(x.url) === x.url &&
    (x.sourceDate === null || isoDay(x.sourceDate) === x.sourceDate) &&
    closureKind(x.kind) !== null &&
    (at === null || (typeof at === "object" && inMetroCebu(at)))
  );
}

/** The findings in the reply's JSON object whose link is one of `pages`, or null when there is none to read. */
function findingsIn(text: string, pages: readonly string[]): WebFinding[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { closures?: unknown } | null)?.closures;
  if (!Array.isArray(list)) return null;
  const findings: WebFinding[] = [];
  list.forEach((item: Record<string, unknown> | null, i) => {
    if (typeof item !== "object" || item === null) return;
    const place = placeLabel(item.place);
    const url = canonicalUrl(item.url);
    const kind = closureKind(item.kind);
    if (!place || !url || !pages.includes(url) || !kind) return;
    const at = inMetroCebu({ lat: item.lat, lon: item.lon }) ? { lat: item.lat as number, lon: item.lon as number } : null;
    findings.push({ id: `web-${i}`, place, at, url, sourceDate: isoDay(item.date), kind });
  });
  return findings.slice(0, MAX_WEB_FINDINGS);
}

/** Runs the plan: the stored result, no search, or the one search, stored for every check after it. */
export async function runWebSearch(
  plan: WebPlan,
  deps: { store: KvStore | null; now: Date; deadline: number; meter: Meter },
): Promise<WebEvidence> {
  if (plan.kind === "cached") return plan.evidence;
  if (plan.kind === "off") return { state: "not_run", why: plan.why, searchedAt: null, findings: [] };

  const searchedAt = deps.now.toISOString();
  const failed = (why: string): WebEvidence => ({ state: "failed", why, searchedAt, findings: [] });
  let evidence: WebEvidence;
  let pages: string[] = [];
  try {
    const reply = await respond({
      input: searchPrompt(deps.now),
      tools: [{ type: "web_search" }],
      maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
      attemptTimeoutMs: SEARCH_ATTEMPT_MS,
      deadline: deps.deadline,
      meter: plan.run.meter,
    });
    pages = toolPages(reply);
    const findings = reply.status === "completed" ? findingsIn(reply.answerText, pages) : null;
    if (reply.status !== "completed") evidence = failed("search cut off");
    else if (findings === null) evidence = failed("unreadable reply");
    else evidence = { state: "searched", searchedAt, findings };
  } catch {
    evidence = failed("search failed");
  }
  deps.meter.include(plan.run.meter);
  await plan.run.settle(true);
  const ttl = evidence.state === "searched" ? WEB_SEARCH_CACHE_MS : WEB_SEARCH_FAILED_CACHE_MS;
  try {
    if (deps.store) await keep(deps.store, { expiresAt: deps.now.getTime() + ttl, startedAt: plan.startedAt, evidence, pages }, deps.now);
  } catch (err) {
    console.error("couldn't store the web search:", err instanceof Error ? err.message : err);
  }
  await giveBack(plan.lease);
  return evidence;
}
