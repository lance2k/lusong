import { isNationwide, type CapArea } from "./advisory-geo";
import { incompleteWhy, type AdvisorySnapshot } from "./advisory-snapshot";
import type { Point } from "./answer";
import { phtTime } from "./commute-words";

/**
 * The alert store (plan S4a, dispositions S4P-5 and S4P-9): every advisory, road closure and disaster-office post Lusong
 * can tell a rider about, kept as validated fields only. A rider's text is built from these fields by the fixed templates
 * below, never from a model's words.
 */

export const ALERTS_KEY = "lusong:alerts:v1";
/** The PAGASA snapshot generation the stored PAGASA alerts were built from: an older snapshot never rebuilds them. */
export const ALERTS_GENERATION_FIELD = "_pagasa_generation";
/** The watcher delivery last stopped at, so a cut-off run's successor starts with the watchers it didn't reach. */
export const DELIVERY_CURSOR_KEY = "lusong:alerts:cursor:v1";
const DELIVERY_CURSOR_TTL_MS = 24 * 3_600_000;
/**
 * A sweep item's first sighting, kept past the item's own pruning (S4D-6): an item found again keeps the time and expiry
 * it was first seen with, and an expired one stays expired. A sweep page older than 48 hours is refused anyway.
 */
export const SEEN_KEY_PREFIX = "lusong:alerts:seen:v1:";
export const SEEN_TTL_MS = 7 * 24 * 3_600_000;

export type AlertKind = "advisory" | "closure" | "office_post";
export type AlertOrigin = "pagasa" | "sweep";

/**
 * Where an alert applies. `areas` is PAGASA's own areas, judged by S1's rule (lib/advisory-geo.ts judgeArea: polygon,
 * or the provinces its geocode or name bounds it by). `codes` are 10-digit province PSGCs.
 */
export type AlertScope = { nationwide: true } | { areas: CapArea[] } | { point: Point; radiusM: number } | { codes: string[] };

export interface PagasaFields {
  /** PAGASA's event name, as its CAP record gives it. */
  event: string;
  /** CAP `sent`. */
  sent: string;
  /** The latest live info's `expires`. */
  expires: string;
}

export interface SweepFields {
  /** The place, as the geocoder named it. */
  place: string;
  /** The page's own publication time (S4P-7). */
  posted: string;
  /** Which of the fixed phrases describes it. */
  words: "closure" | "flood";
}

export interface Alert {
  id: string;
  version: number;
  kind: AlertKind;
  scope: AlertScope;
  sourceUrl: string;
  /** From PAGASA, or from the sweep's fixed host map (S4P-7), never from a model. */
  sourceOrg: string;
  eventAt: string;
  expiresAt: string;
  severity: "warn" | "block";
  origin: AlertOrigin;
  fields: PagasaFields | SweepFields;
}

export const memberOf = (alert: Pick<Alert, "id" | "version">) => `${alert.id}@${alert.version}`;

/** Text PAGASA wrote, kept to one plain line of bounded length before it goes into a template. */
export function plainLine(text: string, max: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * PAGASA's live products as alerts (S4P-5): the snapshot already applies each Update's and Cancel's references, so the
 * set is rebuilt from what is live and nothing here reads a reference itself. A product is nationwide when any area
 * names the whole country.
 */
export function pagasaAlerts(snapshot: AdvisorySnapshot, now: Date): Alert[] {
  return snapshot.products.flatMap((product) => {
    const infos = product.infos.filter((i) => Date.parse(i.expires) > now.getTime());
    if (infos.length === 0) return [];
    const areas = infos.flatMap((i) => i.areas);
    const expires = infos.map((i) => i.expires).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const alert: Alert = {
      id: `pagasa:${product.id}`,
      version: 1,
      kind: "advisory",
      scope: areas.some(isNationwide) ? { nationwide: true } : { areas },
      sourceUrl: product.link,
      sourceOrg: "PAGASA",
      eventAt: new Date(Date.parse(product.sent)).toISOString(),
      expiresAt: new Date(Date.parse(expires)).toISOString(),
      severity: "warn",
      origin: "pagasa",
      fields: { event: plainLine(product.event, 80), sent: product.sent, expires },
    };
    return [alert];
  });
}

/** Lean safe: PAGASA alerts are used only from a complete snapshot read within its freshness. */
export function pagasaUsable(snapshot: AdvisorySnapshot | null, now: Date): string | null {
  return incompleteWhy(snapshot, now);
}

const SWEEP_PHRASES: Record<SweepFields["words"], string> = { closure: "a road closure", flood: "flooding" };

/**
 * The only words an alert message is made of: the fixed templates, the validated fields and the source link.
 * `areas` are the areaDescs that touch this rider's trip, from PAGASA's own record.
 */
export function alertWords(alert: Alert, areas: readonly string[]): string {
  if (alert.origin === "pagasa") {
    const f = alert.fields as PagasaFields;
    const named = areas.map((a) => plainLine(a, 60)).filter((a) => a !== "");
    const shown = named.slice(0, 3).join(", ");
    const where =
      "nationwide" in alert.scope || named.length === 0 ? "the whole country" : named.length > 3 ? `${shown} and ${named.length - 3} more` : shown;
    return `PAGASA ${plainLine(f.event, 80)} for ${where}, sent ${phtTime(f.sent)}, until ${phtTime(f.expires)}.`;
  }
  const f = alert.fields as SweepFields;
  // "the MMDA" opens a sentence as "The MMDA"; a bare host name is left as it is written.
  const org = alert.sourceOrg.replace(/^the /, "The ");
  return `${org} reports ${SWEEP_PHRASES[f.words]} at ${plainLine(f.place, 80)}, posted ${phtTime(f.posted)}. Unconfirmed by Lusong.`;
}

/** The message a rider gets on Telegram: the words, then the source's link. */
export function alertMessage(alert: Alert, areas: readonly string[]): string {
  return `${alertWords(alert, areas)} ${alert.sourceUrl}`;
}

function parseAlert(text: string): Alert | null {
  try {
    const a = JSON.parse(text) as Alert;
    if (typeof a?.id !== "string" || typeof a.version !== "number" || !Number.isFinite(Date.parse(a.expiresAt))) return null;
    return a;
  } catch {
    return null;
  }
}

export interface AlertStore {
  /**
   * Replaces every PAGASA alert with these, in one step, when `generation` is newer than the snapshot the stored ones came
   * from, so a slow run never brings back what a newer snapshot cancelled. Deletes every expired alert too. False when a
   * newer generation is already stored.
   */
  rebuildPagasa(generation: number, alerts: readonly Alert[], nowMs: number): Promise<boolean>;
  /**
   * Adds each alert whose id was never seen in the last SEEN_TTL_MS; one seen before keeps its first version, time and
   * expiry, even after it expired and was pruned.
   */
  addIfAbsent(alerts: readonly Alert[]): Promise<number>;
  /** Every unexpired alert; expired ones are dropped as they are read. */
  all(nowMs: number): Promise<Alert[]>;
  /**
   * Every unexpired alert, changing nothing: for public reads (the map), which must never race a rebuild by deleting
   * what it just replaced (S3cP-1).
   */
  list(nowMs: number): Promise<Alert[]>;
  /** True while this version of the alert is stored and unexpired: read again right before each send. */
  isActive(id: string, version: number, nowMs: number): Promise<boolean>;
  cursor(): Promise<string | null>;
  setCursor(watcherId: string | null): Promise<void>;
}

/** For local development and tests only. */
export class MemoryAlertStore implements AlertStore {
  private alerts = new Map<string, string>();
  private seen = new Map<string, { eventAt: string; expiresAt: string; until: number }>();
  private generation = -1;
  private savedCursor: string | null = null;
  constructor(private readonly clock: () => number = Date.now) {}

  async rebuildPagasa(generation: number, alerts: readonly Alert[], nowMs: number) {
    if (generation <= this.generation) return false;
    this.generation = generation;
    for (const [id, text] of this.alerts) {
      const a = parseAlert(text);
      if (id.startsWith("pagasa:") || !a || Date.parse(a.expiresAt) <= nowMs) this.alerts.delete(id);
    }
    for (const a of alerts) this.alerts.set(a.id, JSON.stringify(a));
    return true;
  }

  async addIfAbsent(alerts: readonly Alert[]) {
    let added = 0;
    for (const a of alerts) {
      const seen = this.seen.get(a.id);
      const fresh = !seen || seen.until <= this.clock();
      if (fresh) this.seen.set(a.id, { eventAt: a.eventAt, expiresAt: a.expiresAt, until: this.clock() + SEEN_TTL_MS });
      if (this.alerts.has(a.id) || !fresh) continue;
      this.alerts.set(a.id, JSON.stringify(a));
      added += 1;
    }
    return added;
  }

  async all(nowMs: number) {
    const out: Alert[] = [];
    for (const [id, text] of this.alerts) {
      const a = parseAlert(text);
      if (!a || Date.parse(a.expiresAt) <= nowMs) this.alerts.delete(id);
      else out.push(a);
    }
    return out;
  }

  async list(nowMs: number) {
    return [...this.alerts.values()].map(parseAlert).filter((a): a is Alert => a !== null && Date.parse(a.expiresAt) > nowMs);
  }

  async isActive(id: string, version: number, nowMs: number) {
    const a = parseAlert(this.alerts.get(id) ?? "");
    return a !== null && a.version === version && Date.parse(a.expiresAt) > nowMs;
  }

  async cursor() {
    return this.savedCursor;
  }

  async setCursor(watcherId: string | null) {
    this.savedCursor = watcherId;
  }
}

/** KEYS: alerts hash. ARGV: generation, now ms, generation field, then id, JSON pairs. */
const REBUILD_SCRIPT = `
local stored = tonumber(redis.call('HGET', KEYS[1], ARGV[3]) or '-1')
if tonumber(ARGV[1]) <= stored then return 0 end
local now = tonumber(ARGV[2])
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  local id, value = all[i], all[i + 1]
  if id ~= ARGV[3] then
    local expires = tonumber(string.match(value, '"expiresMs":(%d+)'))
    if string.sub(id, 1, 7) == 'pagasa:' or not expires or expires <= now then redis.call('HDEL', KEYS[1], id) end
  end
end
for i = 4, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('HSET', KEYS[1], ARGV[3], ARGV[1])
return 1
`;

/** KEYS: alerts hash, then each alert's seen key. ARGV: seen TTL ms, then id, stored form, seen record per alert. */
const ADD_IF_ABSENT_SCRIPT = `
local added = 0
for i = 2, #KEYS do
  local at = 2 + (i - 2) * 3
  local stored = redis.call('HEXISTS', KEYS[1], ARGV[at]) == 1
  local fresh = redis.call('SET', KEYS[i], ARGV[at + 2], 'NX', 'PX', ARGV[1])
  if fresh and not stored then
    redis.call('HSET', KEYS[1], ARGV[at], ARGV[at + 1])
    added = added + 1
  end
end
return added
`;

/** Stored with its expiry in ms first, so the rebuild script can read it without a JSON parser. */
function storedForm(a: Alert): string {
  return JSON.stringify({ expiresMs: Date.parse(a.expiresAt), ...a });
}

/** Upstash's REST API, in the same database as the watchers (lib/watch-store.ts). */
export class UpstashAlertStore implements AlertStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "lusong",
  ) {}

  private key(name: string) {
    return name.replace(/^lusong/, this.prefix);
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  async rebuildPagasa(generation: number, alerts: readonly Alert[], nowMs: number) {
    const pairs = alerts.flatMap((a) => [a.id, storedForm(a)]);
    return (await this.command(["EVAL", REBUILD_SCRIPT, 1, this.key(ALERTS_KEY), generation, nowMs, ALERTS_GENERATION_FIELD, ...pairs])) === 1;
  }

  async addIfAbsent(alerts: readonly Alert[]) {
    if (alerts.length === 0) return 0;
    const keys = [this.key(ALERTS_KEY), ...alerts.map((a) => this.key(SEEN_KEY_PREFIX) + a.id)];
    const args = alerts.flatMap((a) => [a.id, storedForm(a), JSON.stringify({ eventAt: a.eventAt, expiresAt: a.expiresAt })]);
    return Number(await this.command(["EVAL", ADD_IF_ABSENT_SCRIPT, keys.length, ...keys, SEEN_TTL_MS, ...args]));
  }

  async all(nowMs: number) {
    const flat = await this.command(["HGETALL", this.key(ALERTS_KEY)]);
    if (!Array.isArray(flat)) throw new Error("unexpected alert list");
    const out: Alert[] = [];
    const expired: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const id = String(flat[i]);
      if (id === ALERTS_GENERATION_FIELD) continue;
      const a = parseAlert(String(flat[i + 1]));
      if (!a || Date.parse(a.expiresAt) <= nowMs) expired.push(id);
      else out.push(stripStored(a));
    }
    if (expired.length > 0) await this.command(["HDEL", this.key(ALERTS_KEY), ...expired]);
    return out;
  }

  async list(nowMs: number) {
    const flat = await this.command(["HGETALL", this.key(ALERTS_KEY)]);
    if (!Array.isArray(flat)) throw new Error("unexpected alert list");
    const out: Alert[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (String(flat[i]) === ALERTS_GENERATION_FIELD) continue;
      const a = parseAlert(String(flat[i + 1]));
      if (a && Date.parse(a.expiresAt) > nowMs) out.push(stripStored(a));
    }
    return out;
  }

  async isActive(id: string, version: number, nowMs: number) {
    const text = await this.command(["HGET", this.key(ALERTS_KEY), id]);
    const a = typeof text === "string" ? parseAlert(text) : null;
    return a !== null && a.version === version && Date.parse(a.expiresAt) > nowMs;
  }

  async cursor() {
    const value = await this.command(["GET", this.key(DELIVERY_CURSOR_KEY)]);
    return typeof value === "string" && value !== "" ? value : null;
  }

  async setCursor(watcherId: string | null) {
    if (watcherId === null) await this.command(["DEL", this.key(DELIVERY_CURSOR_KEY)]);
    else await this.command(["SET", this.key(DELIVERY_CURSOR_KEY), watcherId, "PX", DELIVERY_CURSOR_TTL_MS]);
  }
}

function stripStored(a: Alert & { expiresMs?: number }): Alert {
  const alert = { ...a };
  delete alert.expiresMs;
  return alert;
}

const sharedMemoryStore = (() => {
  let store: MemoryAlertStore | null = null;
  return () => (store ??= new MemoryAlertStore());
})();

/** The same database and switches as the budget (lib/budget.ts); the memory store is never chosen when deployed. */
export function alertStoreFromEnv(env: Record<string, string | undefined> = process.env): AlertStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashAlertStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashAlertStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}
