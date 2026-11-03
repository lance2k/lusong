import { createHash, randomUUID } from "node:crypto";
import { ATOM, CAP, FEED_URL, fetchText, MSG_TYPES, readPolygon, RESPONSE_TYPES, STATUSES, time, Unreadable } from "./advisory";
import { judgeArea, type CapArea } from "./advisory-geo";
import type { AdvisoryState, Point } from "./answer";
import { childOf, childrenOf, parseXml, textOf, type XmlElement } from "./xml";

/**
 * A snapshot of PAGASA's whole CAP feed (plan S1 §2, dispositions S1P-4, S1P-5, S1P-7): every record the feed lists,
 * read within fixed bounds, kept in the shared store and judged against each route on its own (lib/advisory-geo.ts).
 */

export const SNAPSHOT_KEY = "lusong:advisory:snapshot:v1";
export const SNAPSHOT_LEASE_KEY = "lusong:advisory:snapshot:lease";
export const CAP_KEY_PREFIX = "lusong:advisory:cap:v1:";
/** Records are immutable once published, so a raw record is kept long after any advisory in it has expired. */
export const CAP_TTL_MS = 72 * 3_600_000;
/** Kept a day; whether it can be relied on is read from its fetchedAt, never from whether the key exists. */
export const SNAPSHOT_TTL_MS = 24 * 3_600_000;
/** A snapshot older than this reads as incomplete: the schedule refreshes every 10 minutes, so 30 is three missed runs. */
export const STALE_AFTER_MS = 30 * 60_000;
/** An incomplete snapshot is refreshed again only after this long, so checks while PAGASA is down don't each ask it. */
export const INCOMPLETE_RETRY_MS = 60_000;

export interface SnapshotLimits {
  /** Feed entries considered; a feed listing more is incomplete. */
  maxRecords: number;
  maxBytes: number;
  /** Records fetched at a time. */
  concurrency: number;
  /** Per request. */
  timeoutMs: number;
  /** For the whole snapshot, feed and records together. */
  deadlineMs: number;
}

export const SNAPSHOT_LIMITS: SnapshotLimits = { maxRecords: 120, maxBytes: 256 * 1024, concurrency: 4, timeoutMs: 10_000, deadlineMs: 45_000 };
/** Outlives the longest snapshot, so a lease lapses only when its owner has died. */
export const SNAPSHOT_LEASE_MS = SNAPSHOT_LIMITS.deadlineMs + 15_000;

export const capKey = (link: string) => `${CAP_KEY_PREFIX}${createHash("sha256").update(link).digest("hex")}`;

/**
 * Event names seen in PAGASA's feed (2026-10-29 and 2026-11-03 saves) and test/fixtures/pagasa: "General Flood Advisory
 * (Moderate)", "General Flood Advisory (Final)", "Tropical Cyclone Warning" (wind signals, by province) and "Tropical
 * Cyclone Alert" (the whole area of responsibility). Rainfall warnings weren't in either save; their names are matched
 * by "rain". Flood, rainfall and cyclone products make a route's advisory active; any other event is only shown.
 */
export type AdvisoryKind = "flood" | "rainfall" | "cyclone" | "other";
const KIND_BY_EVENT: [RegExp, AdvisoryKind][] = [
  [/flood/i, "flood"],
  [/rain/i, "rainfall"],
  [/tropical cyclone|typhoon|tropical storm|wind signal/i, "cyclone"],
];
export const COUNTING_KINDS: ReadonlySet<AdvisoryKind> = new Set(["flood", "rainfall", "cyclone"]);

export function kindOf(event: string): AdvisoryKind {
  return KIND_BY_EVENT.find(([pattern]) => pattern.test(event))?.[1] ?? "other";
}

export interface ProductInfo {
  expires: string;
  rainForecast: string | null;
  /** "**Cebu** - Rivers and its tributaries particularly …" lines, by the name in bold. */
  rivers: { name: string; text: string }[];
  areas: CapArea[];
}

/** One live CAP product: a record no later Update or Cancel names, with its infos that aren't all-clears. */
export interface AdvisoryProduct {
  id: string;
  link: string;
  kind: AdvisoryKind;
  event: string;
  headline: string | null;
  sent: string;
  infos: ProductInfo[];
}

export interface FeedEntryView {
  link: string;
  title: string;
  updated: string;
}

export interface AdvisorySnapshot {
  /** The refresh's start time in ms: a snapshot is published only over an older one. */
  generation: number;
  fetchedAt: string;
  complete: boolean;
  /** Why it is not complete. */
  why: string | null;
  entries: FeedEntryView[];
  products: AdvisoryProduct[];
}

interface StoredRecord {
  fetchedAt: string;
  feedUpdated: string;
  link: string;
  xml: string;
}

/** The shared store's operations a snapshot needs: Upstash in production, memory in tests and local runs. */
export interface AdvisoryStore {
  get(key: string): Promise<string | null>;
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** `SET … NX PX`: true when the key was free and is now this value. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only while it still holds this value, so a lapsed lease never frees another refresh's. */
  deleteIfEquals(key: string, value: string): Promise<void>;
  /** Stores `<generation>\n<body>` only when the stored value's generation is lower, or none is stored, in one step. */
  publishIfNewer(key: string, generation: number, body: string, ttlMs: number): Promise<boolean>;
}

function generationOf(stored: string | null): number {
  if (stored === null) return -1;
  const match = /^(\d+)\n/.exec(stored);
  return match ? Number(match[1]) : -1;
}

export class MemoryAdvisoryStore implements AdvisoryStore {
  private values = new Map<string, { value: string; until: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  private read(key: string): string | null {
    const entry = this.values.get(key);
    return entry && entry.until > this.clock() ? entry.value : null;
  }

  async get(key: string) {
    return this.read(key);
  }

  async getMany(keys: readonly string[]) {
    return keys.map((k) => this.read(k));
  }

  async set(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, until: this.clock() + ttlMs });
  }

  // Read and write with no await between them, as Redis does in one step.
  async setIfAbsent(key: string, value: string, ttlMs: number) {
    if (this.read(key) !== null) return false;
    this.values.set(key, { value, until: this.clock() + ttlMs });
    return true;
  }

  async deleteIfEquals(key: string, value: string) {
    if (this.read(key) === value) this.values.delete(key);
  }

  async publishIfNewer(key: string, generation: number, body: string, ttlMs: number) {
    if (generationOf(this.read(key)) >= generation) return false;
    this.values.set(key, { value: `${generation}\n${body}`, until: this.clock() + ttlMs });
    return true;
  }
}

const DELETE_IF_EQUALS = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
// A missing key reads as false in Lua; a value without the "<digits>\n" head counts as generation -1, so it is replaced.
const PUBLISH_IF_NEWER =
  'local current = redis.call("GET", KEYS[1]) local stored = -1 ' +
  'if current then stored = tonumber(string.match(current, "^(%d+)\\n")) or -1 end ' +
  'if tonumber(ARGV[1]) > stored then redis.call("SET", KEYS[1], ARGV[1] .. "\\n" .. ARGV[2], "PX", ARGV[3]) return 1 else return 0 end';

export class UpstashAdvisoryStore implements AdvisoryStore {
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

  async getMany(keys: readonly string[]) {
    if (keys.length === 0) return [];
    const result = await this.command(["MGET", ...keys.map((k) => this.key(k))]);
    if (!Array.isArray(result) || result.length !== keys.length) throw new Error("Upstash MGET reply is not a list");
    return result.map((v) => (typeof v === "string" ? v : null));
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

  async publishIfNewer(key: string, generation: number, body: string, ttlMs: number) {
    return (await this.command(["EVAL", PUBLISH_IF_NEWER, "1", this.key(key), String(generation), body, String(ttlMs)])) === 1;
  }
}

const sharedMemoryStore = (() => {
  let store: MemoryAdvisoryStore | null = null;
  return () => (store ??= new MemoryAdvisoryStore());
})();

/** The same store and switches as the budget (lib/budget.ts); none configured is null. */
export function advisoryStoreFromEnv(env: Record<string, string | undefined> = process.env): AdvisoryStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryStore();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashAdvisoryStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashAdvisoryStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}

interface FeedEntry {
  title: string;
  updated: string;
  updatedMs: number;
  link: string;
}

function readFeed(xml: string): { entries: FeedEntry[]; unlinked: string[] } {
  const root = parseXml(xml);
  if (root.ns !== ATOM || root.name !== "feed") throw new Unreadable("not an Atom feed");
  const unlinked: string[] = [];
  const entries = childrenOf(root, ATOM, "entry").flatMap((entry) => {
    const title = textOf(entry, ATOM, "title") ?? "";
    const link = childrenOf(entry, ATOM, "link").find((l) => /\.cap$/.test(l.attrs.href ?? "") || l.attrs.type === "application/cap+xml");
    if (!link?.attrs.href) {
      unlinked.push(title);
      return [];
    }
    const updated = textOf(entry, ATOM, "updated") ?? "";
    return [{ title, updated, updatedMs: time(updated, `"${title}" updated`), link: new URL(link.attrs.href, FEED_URL).href }];
  });
  return { entries, unlinked };
}

interface ParsedRecord {
  id: string;
  status: string;
  msgType: string;
  sentMs: number;
  references: string[];
  product: AdvisoryProduct;
}

function required(el: XmlElement, name: string, link: string): string {
  const value = textOf(el, CAP, name);
  if (!value) throw new Unreadable(`${link} has no ${name}`);
  return value;
}

function riversOf(description: string): { name: string; text: string }[] {
  return [...description.matchAll(/\*\*([^*]+)\*\*\s*-\s*(.+)$/gm)].map((m) => ({
    name: m[1].trim(),
    text: m[2]
      .trim()
      .replace(/^rivers and its tributaries\s*(particularly\s*)?/i, "")
      .replace(/\.$/, ""),
  }));
}

function readArea(area: XmlElement, link: string): CapArea {
  const desc = (textOf(area, CAP, "areaDesc") ?? "").trim();
  if (desc === "") throw new Unreadable(`${link} has an area with no areaDesc`);
  const polygons = childrenOf(area, CAP, "polygon").flatMap((p) => {
    const ring = readPolygon(p.text);
    return ring ? [ring.flatMap((q) => [q.lon, q.lat])] : [];
  });
  const geocodes = childrenOf(area, CAP, "geocode")
    .filter((g) => textOf(g, CAP, "valueName") === "SAME")
    .map((g) => (textOf(g, CAP, "value") ?? "").trim())
    .filter((v) => v !== "");
  return { desc, polygons, geocodes };
}

/**
 * Every field a product's state depends on is checked, so a record missing one makes the snapshot incomplete rather
 * than quietly dropping a product. A Cancel, Ack or Error needs no info; an Alert or Update does.
 */
function readRecord(xml: string, link: string): ParsedRecord {
  const alert = parseXml(xml);
  if (alert.ns !== CAP || alert.name !== "alert") throw new Unreadable(`${link} is not a CAP alert`);
  const id = required(alert, "identifier", link);
  const sent = required(alert, "sent", link);
  const sentMs = time(sent, `${link} sent`);
  const status = required(alert, "status", link);
  if (!STATUSES.has(status)) throw new Unreadable(`${link} has status ${status}`);
  const msgType = required(alert, "msgType", link);
  if (!MSG_TYPES.has(msgType)) throw new Unreadable(`${link} has msgType ${msgType}`);
  // CAP references are "sender,identifier,sent" triples separated by spaces.
  const references = (textOf(alert, CAP, "references") ?? "")
    .split(/\s+/)
    .map((ref) => ref.split(",")[1])
    .filter((ref): ref is string => Boolean(ref));

  const infos = childrenOf(alert, CAP, "info");
  const describes = msgType === "Alert" || msgType === "Update";
  if (describes && infos.length === 0) throw new Unreadable(`${link} has no info block`);
  const read = infos.map((info) => {
    const expires = required(info, "expires", link);
    time(expires, `${link} expires`);
    const responses = childrenOf(info, CAP, "responseType").map((r) => r.text.trim());
    if (responses.some((r) => !RESPONSE_TYPES.has(r))) throw new Unreadable(`${link} has an unknown responseType`);
    const areas = childrenOf(info, CAP, "area").map((a) => readArea(a, link));
    if (describes && areas.length === 0) throw new Unreadable(`${link} has no usable area`);
    const description = childOf(info, CAP, "description")?.text ?? "";
    return {
      event: textOf(info, CAP, "event"),
      headline: textOf(info, CAP, "headline"),
      allClear: responses.includes("AllClear"),
      info: {
        expires,
        rainForecast: /rainfall forecast is\s+([^.\n]+?)\s*\.?\s*$/im.exec(description)?.[1] ?? null,
        rivers: riversOf(description),
        areas,
      } satisfies ProductInfo,
    };
  });
  const event = read.find((r) => r.event)?.event ?? read.find((r) => r.headline)?.headline ?? "PAGASA alert";
  return {
    id,
    status,
    msgType,
    sentMs,
    references,
    product: {
      id,
      link,
      kind: kindOf(event),
      event,
      headline: read.find((r) => r.headline)?.headline ?? null,
      sent,
      infos: read.filter((r) => !r.allClear).map((r) => r.info),
    },
  };
}

/**
 * Product identity is the CAP identifier: an Update replaces, and a Cancel removes, exactly the products its references
 * name. What is left is every Actual Alert or Update already sent that nothing names, with its live infos.
 */
function liveProducts(records: readonly ParsedRecord[], now: number): AdvisoryProduct[] {
  const replaced = new Set(records.filter((r) => r.msgType === "Update" || r.msgType === "Cancel").flatMap((r) => r.references));
  return records
    .filter((r) => r.status === "Actual" && (r.msgType === "Alert" || r.msgType === "Update") && r.sentMs <= now && !replaced.has(r.id))
    .map((r) => ({ ...r.product, infos: r.product.infos.filter((i) => Date.parse(i.expires) > now) }))
    .filter((p) => p.infos.length > 0);
}

function parseStoredRecord(text: string | null): StoredRecord | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as StoredRecord;
    return typeof value?.xml === "string" && typeof value.feedUpdated === "string" ? value : null;
  } catch {
    return null;
  }
}

interface BuildDeps {
  store: AdvisoryStore;
  fetch: typeof fetch;
  now: Date;
  limits: SnapshotLimits;
  /** Epoch ms by which the snapshot must be built. */
  deadline: number;
}

/**
 * The feed and every record it lists, newest first. A record is fetched only when the store doesn't hold it at the
 * feed's current `updated`, so PAGASA sees a request only for what is new.
 */
async function buildSnapshot(deps: BuildDeps, generation: number): Promise<AdvisorySnapshot> {
  const now = deps.now.getTime();
  const { limits } = deps;
  const signal = AbortSignal.timeout(Math.max(1, deps.deadline - Date.now()));
  const snapshot = (complete: boolean, why: string | null, entries: FeedEntry[], records: ParsedRecord[]): AdvisorySnapshot => ({
    generation,
    fetchedAt: deps.now.toISOString(),
    complete,
    why,
    entries: entries.map((e) => ({ link: e.link, title: e.title, updated: e.updated })),
    products: liveProducts(records, now),
  });

  let feed: ReturnType<typeof readFeed>;
  try {
    feed = readFeed(await fetchText(FEED_URL, deps, limits, signal));
  } catch (err) {
    return snapshot(false, `feed: ${err instanceof Error ? err.message : String(err)}`, [], []);
  }
  let failure: string | null = feed.unlinked.length > 0 ? `feed entry "${feed.unlinked[0]}" has no CAP link` : null;
  const listed = feed.entries.filter((e) => e.updatedMs <= now).sort((a, b) => b.updatedMs - a.updatedMs);
  if (listed.length > limits.maxRecords) failure ??= `the feed lists more than ${limits.maxRecords} records`;
  const entries = listed.slice(0, limits.maxRecords);

  let held: (StoredRecord | null)[];
  try {
    held = (await deps.store.getMany(entries.map((e) => capKey(e.link)))).map(parseStoredRecord);
  } catch {
    held = entries.map(() => null);
  }

  const records: ParsedRecord[] = [];
  const read = async (entry: FeedEntry, i: number): Promise<void> => {
    const kept = held[i];
    let xml: string;
    if (kept && kept.link === entry.link && kept.feedUpdated === entry.updated) {
      xml = kept.xml;
    } else {
      xml = await fetchText(entry.link, deps, limits, signal);
      const record: StoredRecord = { fetchedAt: deps.now.toISOString(), feedUpdated: entry.updated, link: entry.link, xml };
      await deps.store.set(capKey(entry.link), JSON.stringify(record), CAP_TTL_MS).catch(() => {});
    }
    records.push(readRecord(xml, entry.link));
  };

  // Every listed record is read: skipping one a newer record replaces would also hide what it replaced in turn.
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      if (Date.now() >= deps.deadline) {
        failure ??= "the snapshot ran out of time";
        return;
      }
      try {
        await read(entries[i], i);
      } catch (err) {
        failure ??= `${entries[i].link}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, entries.length) }, worker));
  return snapshot(failure === null, failure, entries, records);
}

export type RefreshOutcome =
  | { outcome: "published"; snapshot: AdvisorySnapshot }
  /** A newer snapshot was published while this one was being built, so this one was dropped. */
  | { outcome: "superseded"; snapshot: AdvisorySnapshot }
  /** Another refresh holds the lease. */
  | { outcome: "busy" }
  | { outcome: "store_failed"; why: string };

export interface RefreshDeps {
  store: AdvisoryStore;
  fetch: typeof fetch;
  now: () => Date;
  limits?: Partial<SnapshotLimits>;
  /** Epoch ms the refresh must end by, if sooner than its own deadline. */
  deadline?: number;
}

/**
 * The one refresh, for the schedule and for a check that finds the snapshot missing or stale: it holds the lease while
 * it builds (released only by its owner), and publishes only over an older generation, so a slow refresh that finishes
 * after a newer one never brings back what the newer one removed, even after its lease lapsed.
 */
export async function refreshSnapshot(deps: RefreshDeps): Promise<RefreshOutcome> {
  const limits = { ...SNAPSHOT_LIMITS, ...deps.limits };
  const token = randomUUID();
  try {
    if (!(await deps.store.setIfAbsent(SNAPSHOT_LEASE_KEY, token, SNAPSHOT_LEASE_MS))) return { outcome: "busy" };
  } catch (err) {
    return { outcome: "store_failed", why: err instanceof Error ? err.message : String(err) };
  }
  const now = deps.now();
  const generation = now.getTime();
  try {
    const deadline = Math.min(Date.now() + limits.deadlineMs, deps.deadline ?? Infinity);
    const snapshot = await buildSnapshot({ store: deps.store, fetch: deps.fetch, now, limits, deadline }, generation);
    const published = await deps.store.publishIfNewer(SNAPSHOT_KEY, generation, JSON.stringify(snapshot), SNAPSHOT_TTL_MS);
    return published ? { outcome: "published", snapshot } : { outcome: "superseded", snapshot };
  } catch (err) {
    return { outcome: "store_failed", why: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.store.deleteIfEquals(SNAPSHOT_LEASE_KEY, token).catch(() => {});
  }
}

export async function readStoredSnapshot(store: AdvisoryStore): Promise<AdvisorySnapshot | null> {
  const stored = await store.get(SNAPSHOT_KEY);
  if (stored === null) return null;
  const newline = stored.indexOf("\n");
  try {
    const snapshot = JSON.parse(stored.slice(newline + 1)) as AdvisorySnapshot;
    return Array.isArray(snapshot?.products) && typeof snapshot.fetchedAt === "string" ? snapshot : null;
  } catch {
    return null;
  }
}

/** Why a snapshot can't be relied on at `now`, or null when it can. */
export function incompleteWhy(snapshot: AdvisorySnapshot | null, now: Date): string | null {
  if (!snapshot) return "no snapshot of PAGASA's feed";
  if (!snapshot.complete) return snapshot.why ?? "the snapshot is incomplete";
  if (now.getTime() - Date.parse(snapshot.fetchedAt) > STALE_AFTER_MS) return `the snapshot is older than ${STALE_AFTER_MS / 60_000} minutes`;
  return null;
}

function settled(snapshot: AdvisorySnapshot | null, now: Date): boolean {
  if (!snapshot) return false;
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  return age >= 0 && age < (snapshot.complete ? STALE_AFTER_MS : INCOMPLETE_RETRY_MS);
}

export interface SnapshotReading {
  snapshot: AdvisorySnapshot | null;
  /** Set when even the stored snapshot couldn't be read. */
  why?: string;
}

const POLL_MS = 250;

/**
 * The snapshot a check reads: the stored one while it is fresh, otherwise a refresh run inline under the lease, or,
 * when another refresh holds it, that refresh's result if it lands by the deadline. Anything else is what is stored,
 * and reads as incomplete when stale.
 */
export async function snapshotForCheck(deps: { store: AdvisoryStore; fetch: typeof fetch; now: Date; deadline: number; limits?: Partial<SnapshotLimits> }): Promise<SnapshotReading> {
  let stored: AdvisorySnapshot | null;
  try {
    stored = await readStoredSnapshot(deps.store);
  } catch (err) {
    return { snapshot: null, why: `store: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (settled(stored, deps.now)) return { snapshot: stored };
  const refreshed = await refreshSnapshot({ store: deps.store, fetch: deps.fetch, now: () => deps.now, limits: deps.limits, deadline: deps.deadline });
  if (refreshed.outcome === "published") return { snapshot: refreshed.snapshot };
  if (refreshed.outcome === "busy") {
    while (Date.now() + POLL_MS < deps.deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const latest = await readStoredSnapshot(deps.store).catch(() => null);
      if (latest && (!stored || latest.generation > stored.generation)) return { snapshot: latest };
    }
    return { snapshot: stored };
  }
  return { snapshot: (await readStoredSnapshot(deps.store).catch(() => null)) ?? stored };
}

export interface ProductView {
  id: string;
  kind: AdvisoryKind;
  /** False for an event Lusong only shows: it doesn't make the route's advisory active. */
  counts: boolean;
  event: string;
  headline: string | null;
  /** The areaDescs this view is about: those covering the route, or, for a warning, those nothing could place. */
  areas: string[];
  sent: string;
  expires: string;
  link: string;
  rainForecast: string | null;
  rivers: string | null;
}

/** PAGASA's advisories as they bear on one route. */
export interface RouteAdvisory {
  /** "unreadable" whenever the snapshot is incomplete or stale: lean safe, as today. */
  state: AdvisoryState;
  /** Products with an area the route enters, most recently sent first. */
  covering: ProductView[];
  /** Products with an area nothing could place: shown on every check, never covering. */
  warnings: ProductView[];
  /** Why the snapshot can't be relied on, or null. */
  incomplete: string | null;
}

function view(product: AdvisoryProduct, infos: ProductInfo[], areas: CapArea[]): ProductView {
  const names = [...new Set(areas.map((a) => a.desc))];
  const folded = new Set(names.map((n) => n.toLowerCase()));
  const rivers = infos.flatMap((i) => i.rivers).filter((r) => folded.has(r.name.toLowerCase()));
  return {
    id: product.id,
    kind: product.kind,
    counts: COUNTING_KINDS.has(product.kind),
    event: product.event,
    headline: product.headline,
    areas: names,
    sent: product.sent,
    expires: infos.map((i) => i.expires).sort((a, b) => Date.parse(b) - Date.parse(a))[0],
    link: product.link,
    rainForecast: infos.find((i) => i.rainForecast)?.rainForecast ?? null,
    rivers: rivers.length > 0 ? rivers.map((r) => `${r.name}: ${r.text}`).join("; ") : null,
  };
}

/** Each live product judged against the route line on its own; every counting product that covers it applies. */
export function judgeRoute(reading: SnapshotReading, line: readonly Point[], now: Date): RouteAdvisory {
  const snapshot = reading.snapshot;
  const incomplete = reading.why ?? incompleteWhy(snapshot, now);
  const covering: ProductView[] = [];
  const warnings: ProductView[] = [];
  for (const product of snapshot?.products ?? []) {
    const infos = product.infos.filter((i) => Date.parse(i.expires) > now.getTime());
    if (infos.length === 0) continue;
    const judged = infos.flatMap((i) => i.areas.map((area) => ({ info: i, area, judgement: judgeArea(area, line) })));
    const covers = judged.filter((j) => j.judgement === "covers");
    const unplaced = judged.filter((j) => j.judgement === "unbounded");
    if (covers.length > 0) covering.push(view(product, [...new Set(covers.map((c) => c.info))], covers.map((c) => c.area)));
    if (unplaced.length > 0) warnings.push(view(product, [...new Set(unplaced.map((c) => c.info))], unplaced.map((c) => c.area)));
  }
  const bySent = (a: ProductView, b: ProductView) => Date.parse(b.sent) - Date.parse(a.sent);
  covering.sort(bySent);
  warnings.sort(bySent);
  const state: AdvisoryState = incomplete ? "unreadable" : covering.some((p) => p.counts) ? "active" : "none";
  return { state, covering, warnings, incomplete };
}
