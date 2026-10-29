import type { Point } from "./answer";
import type { Meter } from "./meta";
import { respond } from "./spark-responses";

/**
 * Muse Spark's built-in web search for road closures in Metro Cebu today. "Road closures in Cebu today" isn't trip
 * specific, so one search serves every check for WEB_SEARCH_CACHE_MS, through a store every instance shares.
 * One probe search (2026-10-30, 1 draw) took 23 s, ran 11 search actions and 90,257 input tokens, and ran out of its
 * 3,000 output tokens before answering: about $0.15.
 */

export const WEB_SEARCH_KEY = "lusong:muse:road-closures";
export const WEB_SEARCH_CACHE_MS = 30 * 60_000;
/** A failed search is not retried for this long, so a failing search isn't paid for on every check. */
export const WEB_SEARCH_FAILED_CACHE_MS = 5 * 60_000;
/** Above the probe's 3,000, which ran out before any answer. Not yet measured. */
export const SEARCH_MAX_OUTPUT_TOKENS = 4_000;
/** The probe took 23 s at 3,000 output tokens (1 draw). */
export const SEARCH_ATTEMPT_MS = 35_000;
export const MAX_WEB_FINDINGS = 8;

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

export interface WebFinding {
  id: string;
  place: string;
  /** Null when the model gave no location, or one outside Metro Cebu: shown, never placed on a route. */
  at: Point | null;
  url: string;
  /** YYYY-MM-DD as the source dates it, or null when undated. */
  sourceDate: string | null;
  summary: string;
}

export type WebEvidence =
  | { state: "searched"; searchedAt: string; findings: WebFinding[] }
  | { state: "failed" | "not_run"; why: string; searchedAt: string | null; findings: WebFinding[] };

/** `GET` and `SET … PX`: the same Upstash database as the budget, keys under `lusong:`. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export class MemoryKvStore implements KvStore {
  private values = new Map<string, { value: string; until: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  async get(key: string) {
    const entry = this.values.get(key);
    return entry && entry.until > this.clock() ? entry.value : null;
  }

  async set(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, until: this.clock() + ttlMs });
  }
}

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
}

export type WebPlan = { kind: "cached"; evidence: WebEvidence } | { kind: "search" } | { kind: "off"; why: string };

interface Stored {
  expiresAt: number;
  evidence: WebEvidence;
}

function readStored(text: string): Stored | null {
  try {
    const stored = JSON.parse(text) as Stored;
    const e = stored?.evidence;
    if (typeof stored.expiresAt !== "number" || !e || !Array.isArray(e.findings) || !["searched", "failed"].includes(e.state)) return null;
    return stored;
  } catch {
    return null;
  }
}

/** Decided before admission, since a search changes what the check must reserve. */
export async function planWebSearch(store: KvStore | null, now: Date): Promise<WebPlan> {
  if (!store) return { kind: "off", why: "no shared store" };
  let text: string | null;
  try {
    text = await store.get(WEB_SEARCH_KEY);
  } catch {
    return { kind: "off", why: "store unreachable" };
  }
  const stored = text === null ? null : readStored(text);
  if (!stored || stored.expiresAt <= now.getTime()) return { kind: "search" };
  return { kind: "cached", evidence: stored.evidence };
}

function phtDay(t: Date): string {
  return new Date(t.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function searchPrompt(now: Date): string {
  return [
    `Search the web for roads in Metro Cebu, Philippines, reported closed or not passable because of flooding today, ${phtDay(now)} (Philippine time).`,
    "Make at most three searches and open at most two pages, then answer with only a JSON object:",
    '{"closures":[{"place":"road or area name","lat":number or null,"lon":number or null,"url":"the page that reports it",' +
      '"date":"YYYY-MM-DD the page gives for it, or null","summary":"one short sentence"}]}.',
    "Use an empty list if you find none. Give lat and lon only when the page or a well-known landmark places it.",
  ].join(" ");
}

function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === value ? value : null;
}

/** The findings in the reply's JSON object, or null when there is none to read. */
function findingsIn(text: string): WebFinding[] | null {
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
    const place = plainText(item.place, 120);
    const url = httpUrl(item.url);
    if (!place || !url) return;
    const at = inMetroCebu({ lat: item.lat, lon: item.lon }) ? { lat: item.lat as number, lon: item.lon as number } : null;
    findings.push({ id: `web-${i}`, place, at, url, sourceDate: isoDay(item.date), summary: plainText(item.summary, 280) });
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
  try {
    const reply = await respond({
      input: searchPrompt(deps.now),
      tools: [{ type: "web_search" }],
      maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
      attemptTimeoutMs: SEARCH_ATTEMPT_MS,
      deadline: deps.deadline,
      meter: deps.meter,
    });
    const findings = reply.status === "completed" ? findingsIn(reply.answerText) : null;
    if (reply.status !== "completed") evidence = failed("search cut off");
    else if (findings === null) evidence = failed("unreadable reply");
    else evidence = { state: "searched", searchedAt, findings };
  } catch {
    evidence = failed("search failed");
  }
  const ttl = evidence.state === "searched" ? WEB_SEARCH_CACHE_MS : WEB_SEARCH_FAILED_CACHE_MS;
  try {
    await deps.store?.set(WEB_SEARCH_KEY, JSON.stringify({ expiresAt: deps.now.getTime() + ttl, evidence } satisfies Stored), ttl);
  } catch (err) {
    console.error("couldn't store the web search:", err instanceof Error ? err.message : err);
  }
  return evidence;
}
