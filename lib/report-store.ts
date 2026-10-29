import { REPORT_LIFETIME_MS, type Point, type Report } from "./answer";
import type { Verdict } from "./verdict";

/**
 * Records outlive the 3 h a report counts by this much, so a commute check that started just before a report's
 * last moment still finds it. The answer rules and `recent` stop counting it at 3 h whatever the store holds.
 */
export const REPORT_TTL_MARGIN_MS = 10 * 60_000;
export const REPORT_TTL_MS = REPORT_LIFETIME_MS + REPORT_TTL_MARGIN_MS;

/** A photo being read holds its hash this long; longer than the report route's 120 s limit, so a read that died
 *  mid-way frees the photo for a resend without waiting out the 3 h. */
export const PHOTO_CLAIM_MS = 150_000;

/** What Lusong keeps of a photo report. Never the photo or any of its bytes: only their SHA-256, to spot a resend. */
export interface StoredReport {
  id: string;
  kind: "photo";
  at: Point;
  /** OSM way from one Valhalla /locate; null when it failed or two ways tie. */
  wayId: number | null;
  /** The street /locate named, if any. */
  place: string | null;
  receivedAt: string;
  /** EXIF DateTimeOriginal read as PHT, or null when the photo carried none. */
  capturedAt: string | null;
  verdict: Verdict;
  photoHash: string;
}

export type PhotoClaim = { state: "claimed" } | { state: "in_flight" } | { state: "duplicate"; report: StoredReport };

export interface ReportStore {
  /** Atomic: takes the photo's hash for one read, or says a read is under way, or hands back the report it made. */
  claimPhoto(hash: string): Promise<PhotoClaim>;
  /** Frees an unfinished claim. A hash that already names a saved report is left alone. */
  releasePhoto(hash: string): Promise<void>;
  /** Writes the record, the index entry and the hash with one expiry, REPORT_TTL_MS. */
  save(report: StoredReport): Promise<void>;
  /** Reports received under REPORT_LIFETIME_MS before `now`. Throws when the store can't be read. */
  recent(now: Date): Promise<StoredReport[]>;
}

/** The answer rules' view of a stored report. */
export function toReport(stored: StoredReport): Report {
  return {
    id: stored.id,
    at: stored.at,
    wayId: stored.wayId,
    receivedAt: new Date(stored.receivedAt),
    place: stored.place ?? "a reported spot",
    reading: { source: "photo", verdict: stored.verdict, capturedAt: stored.capturedAt ? new Date(stored.capturedAt) : null },
  };
}

function isStoredReport(value: unknown): value is StoredReport {
  const r = value as StoredReport;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    r.kind === "photo" &&
    Number.isFinite(r.at?.lat) &&
    Number.isFinite(r.at?.lon) &&
    (r.wayId === null || Number.isSafeInteger(r.wayId)) &&
    (r.place === null || typeof r.place === "string") &&
    !Number.isNaN(Date.parse(r.receivedAt)) &&
    (r.capturedAt === null || !Number.isNaN(Date.parse(r.capturedAt))) &&
    typeof r.verdict?.kind === "string" &&
    typeof r.photoHash === "string"
  );
}

function counting(reports: StoredReport[], now: Date): StoredReport[] {
  const since = now.getTime() - REPORT_LIFETIME_MS;
  return reports
    .filter((r) => {
      const at = Date.parse(r.receivedAt);
      return at > since && at <= now.getTime();
    })
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

const PENDING = "pending";

/** For local development and tests only: each server instance would keep its own reports. */
export class MemoryReportStore implements ReportStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly prefix: string;
  private values = new Map<string, { value: string; expiresAt: number }>();
  private index = { ids: new Set<string>(), expiresAt: 0 };

  constructor(opts: { now?: () => number; ttlMs?: number; prefix?: string } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? REPORT_TTL_MS;
    this.prefix = opts.prefix ?? "lusong";
  }

  private get(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private set(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Every live key, as Upstash would hold it: for tests that check what is stored. */
  keys(): string[] {
    const live = [...this.values.keys()].filter((k) => this.get(k) !== null);
    return this.index.ids.size > 0 && this.index.expiresAt > this.now() ? [...live, `${this.prefix}:reports`] : live;
  }

  /** Every live value, for tests that check nothing else is stored. */
  dump(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const key of this.keys()) out[key] = key === `${this.prefix}:reports` ? [...this.index.ids] : this.get(key)!;
    return out;
  }

  async claimPhoto(hash: string): Promise<PhotoClaim> {
    const key = `${this.prefix}:report-photo:${hash}`;
    const held = this.get(key);
    if (held === null) {
      this.set(key, PENDING, PHOTO_CLAIM_MS);
      return { state: "claimed" };
    }
    if (held === PENDING) return { state: "in_flight" };
    const record = this.get(`${this.prefix}:report:${held}`);
    return record === null ? { state: "in_flight" } : { state: "duplicate", report: JSON.parse(record) };
  }

  async releasePhoto(hash: string) {
    const key = `${this.prefix}:report-photo:${hash}`;
    if (this.get(key) === PENDING) this.values.delete(key);
  }

  async save(report: StoredReport) {
    this.set(`${this.prefix}:report:${report.id}`, JSON.stringify(report), this.ttlMs);
    this.set(`${this.prefix}:report-photo:${report.photoHash}`, report.id, this.ttlMs);
    if (this.index.expiresAt <= this.now()) this.index.ids.clear();
    for (const id of this.index.ids) if (this.get(`${this.prefix}:report:${id}`) === null) this.index.ids.delete(id);
    this.index.ids.add(report.id);
    this.index.expiresAt = this.now() + this.ttlMs;
  }

  async recent(now: Date) {
    if (this.index.expiresAt <= this.now()) return [];
    const records = [...this.index.ids].map((id) => this.get(`${this.prefix}:report:${id}`)).filter((r) => r !== null);
    return counting(records.map((r) => JSON.parse(r)), now);
  }
}

/** KEYS: the hash, then the record prefix. Returns 'claimed', 'in_flight', or the saved record. */
const CLAIM_SCRIPT = `
local held = redis.call('GET', KEYS[1])
if not held then
  redis.call('SET', KEYS[1], 'pending', 'PX', ARGV[1])
  return 'claimed'
end
if held == 'pending' then return 'in_flight' end
local record = redis.call('GET', KEYS[2] .. held)
if not record then return 'in_flight' end
return record
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == 'pending' then redis.call('DEL', KEYS[1]) end
return 1
`;

/** KEYS: record, hash, index. The index expires with its newest record; older entries are pruned as records lapse. */
const SAVE_SCRIPT = `
local ttl, id, receivedMs, cutoffMs = ARGV[2], ARGV[3], ARGV[4], ARGV[5]
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
redis.call('SET', KEYS[2], id, 'PX', ttl)
redis.call('ZADD', KEYS[3], receivedMs, id)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. cutoffMs)
redis.call('PEXPIRE', KEYS[3], ttl)
return 1
`;

/** KEYS: index, then the record prefix. Returns the live records received after ARGV[1] ms. */
const RECENT_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '+inf')
local out = {}
for _, id in ipairs(ids) do
  local record = redis.call('GET', KEYS[2] .. id)
  if record then table.insert(out, record) end
end
return out
`;

/** Upstash's REST API, one EVAL per operation, in the same database as the budget (lib/budget.ts). */
export class UpstashReportStore implements ReportStore {
  private readonly ttlMs: number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? REPORT_TTL_MS;
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

  private parse(record: unknown): StoredReport {
    const value = typeof record === "string" ? JSON.parse(record) : null;
    if (!isStoredReport(value)) throw new Error("malformed report record");
    return value;
  }

  async claimPhoto(hash: string): Promise<PhotoClaim> {
    const result = await this.evalScript(
      CLAIM_SCRIPT,
      [`${this.prefix}:report-photo:${hash}`, `${this.prefix}:report:`],
      [PHOTO_CLAIM_MS],
    );
    if (result === "claimed" || result === "in_flight") return { state: result };
    return { state: "duplicate", report: this.parse(result) };
  }

  async releasePhoto(hash: string) {
    await this.evalScript(RELEASE_SCRIPT, [`${this.prefix}:report-photo:${hash}`], []);
  }

  async save(report: StoredReport) {
    await this.evalScript(
      SAVE_SCRIPT,
      [`${this.prefix}:report:${report.id}`, `${this.prefix}:report-photo:${report.photoHash}`, `${this.prefix}:reports`],
      [JSON.stringify(report), this.ttlMs, report.id, Date.parse(report.receivedAt), Date.now() - this.ttlMs],
    );
  }

  async recent(now: Date) {
    const result = await this.evalScript(
      RECENT_SCRIPT,
      [`${this.prefix}:reports`, `${this.prefix}:report:`],
      [now.getTime() - REPORT_LIFETIME_MS],
    );
    if (!Array.isArray(result)) throw new Error("unexpected report read");
    return counting(result.map((r) => this.parse(r)), now);
  }
}

const sharedMemoryStore = (() => {
  let store: MemoryReportStore | null = null;
  return () => (store ??= new MemoryReportStore());
})();

/** The same database and switches as the budget (lib/budget.ts); the memory store is never chosen when deployed. */
export function reportStoreFromEnv(env: Record<string, string | undefined> = process.env): ReportStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashReportStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashReportStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
