import { USER_AGENT } from "./advisory";
import { MAX_ACK_MS, slotStoreFromEnv, type SlotStore } from "./router";
import { distanceM } from "./answer";
import { builtInMatches, fold, MAX_PLACES, placeQuery, words, type Place, type PlacesReply } from "./built-in-places";
import { inBound, TRIP_BOUND, type Bound } from "./trip-bound";

export * from "./built-in-places";

export const PHOTON_URL = "https://photon.komoot.io/api/";
/**
 * Photon took 2.8–3.2 s from the laptop (5 draws, 2026-11-03), so 4 s turned a slow minute into "down" (#42). One
 * request a keystroke pause, never retried; with the queue's 3 s wait it still ends inside the route's 15 s.
 */
export const PHOTON_TIMEOUT_MS = 6_000;

export interface Bias {
  lat: number;
  lon: number;
}

/** The phone's location, rounded to about 10 km before it is used or leaves the server. */
export function roundBias(lat: unknown, lon: unknown, bound: Bound): Bias | null {
  const la = typeof lat === "string" ? Number(lat) : lat;
  const lo = typeof lon === "string" ? Number(lon) : lon;
  if (typeof la !== "number" || typeof lo !== "number" || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  const p = { lat: Math.round(la * 10) / 10, lon: Math.round(lo * 10) / 10 };
  return inBound(bound, p) ? p : null;
}

export function photonUrl(q: string, bound: Bound, bias: Bias | null): string {
  const params = new URLSearchParams({
    q,
    limit: String(MAX_PLACES),
    lang: "en",
    bbox: [bound.west, bound.south, bound.east, bound.north].join(","),
  });
  if (bias) {
    params.set("lat", String(bias.lat));
    params.set("lon", String(bias.lon));
  }
  return `${PHOTON_URL}?${params}`;
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 80) : null;
}

/** Photon's features that are points in the Philippines inside the bound, labelled from Photon's own fields. */
export function placesFromPhoton(body: unknown, bound: Bound): Place[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const geometry = (f as { geometry?: { type?: unknown; coordinates?: unknown } })?.geometry;
    const props = ((f as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>;
    if (geometry?.type !== "Point" || !Array.isArray(geometry.coordinates)) continue;
    const [lon, lat] = geometry.coordinates as unknown[];
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (props.countrycode !== "PH" || !inBound(bound, { lat, lon })) continue;
    const street = text(props.street);
    const name = text(props.name) ?? (street ? [text(props.housenumber), street].filter(Boolean).join(" ") : null);
    if (!name) continue;
    const areaParts: string[] = [];
    for (const k of ["district", "city", "county", "state"]) {
      const v = text(props[k]);
      if (v && v !== name && !areaParts.includes(v)) areaParts.push(v);
    }
    const area = areaParts.slice(0, 3).join(", ");
    const key = fold(`${name}|${area}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const osmType = text(props.osm_type);
    const osmId = typeof props.osm_id === "number" ? props.osm_id : null;
    out.push({
      id: osmType && osmId !== null ? `osm:${osmType}${osmId}` : `osm:${lat.toFixed(5)},${lon.toFixed(5)}`,
      name,
      area,
      lat,
      lon,
      source: "osm",
      ...(text(props.osm_key) && text(props.type) ? { feature: { key: text(props.osm_key)!, type: text(props.type)! } } : {}),
    });
  }
  return out;
}

/**
 * The callers waiting for Photon, each under its own id and expiry, so a caller that dies or whose leave is lost frees
 * its place when its own expiry passes, however much other traffic arrives.
 */
export interface WaitQueue {
  /** Drops expired waiters, adds this one until `until`, and returns how many are waiting, this one included. */
  join(key: string, id: string, now: number, until: number): Promise<number>;
  leave(key: string, id: string): Promise<void>;
}

export class MemoryWaitQueue implements WaitQueue {
  private waiting = new Map<string, Map<string, number>>();

  async join(key: string, id: string, now: number, until: number) {
    const q = this.waiting.get(key) ?? new Map<string, number>();
    for (const [other, expires] of q) if (expires <= now) q.delete(other);
    q.set(id, until);
    this.waiting.set(key, q);
    return q.size;
  }

  async leave(key: string, id: string) {
    this.waiting.get(key)?.delete(id);
  }
}

const JOIN_SCRIPT =
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); " +
  "redis.call('PEXPIRE', KEYS[1], ARGV[4]); return redis.call('ZCARD', KEYS[1])";

export class UpstashWaitQueue implements WaitQueue {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async call(command: string[], timeoutMs: number): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }

  async join(key: string, id: string, now: number, until: number) {
    const keyTtl = String(Math.max(1, until - now));
    const n = await this.call(["EVAL", JOIN_SCRIPT, "1", key, String(now), String(until), id, keyTtl], 1_000);
    if (typeof n !== "number") throw new Error("Upstash: unexpected reply");
    return n;
  }

  async leave(key: string, id: string) {
    await this.call(["ZREM", key, id], 2_000);
  }
}

const sharedMemoryQueue = (() => {
  let store: MemoryWaitQueue | null = null;
  return () => (store ??= new MemoryWaitQueue());
})();

export function waitQueueFromEnv(env: Record<string, string | undefined> = process.env): WaitQueue | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryQueue();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashWaitQueue(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashWaitQueue(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}

/** One key for every Lusong instance, so Photon sees at most one Lusong request a second. */
export const PHOTON_SLOT_KEY = "lusong:photon:slot";
export const PHOTON_SLOT_MS = 1_000 + MAX_ACK_MS;
export const PHOTON_QUEUE_KEY = "lusong:photon:waiters";
export const PHOTON_QUEUE_MAX = 20;
export const PHOTON_WAIT_MS = 3_000;
const PHOTON_POLL_MS = 250;
/** A waiter's place lasts past the longest wait, so a live waiter is never pruned. */
const WAITER_TTL_MS = PHOTON_WAIT_MS + 2_000;

export type GateOutcome = "ok" | "busy" | "unavailable";

export interface PhotonGate {
  acquire(): Promise<GateOutcome>;
}

const TIMED_OUT = Symbol("timed out");

/** The store call's result, or TIMED_OUT once `ms` passes; a call still running after that is left to finish alone. */
function within<T>(ms: number, call: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return Promise.resolve(TIMED_OUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    call().finally(() => clearTimeout(timer)),
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]);
}

/**
 * Resolves within `waitMs` of the call: "ok" when this caller may send one request now, "busy" when the queue is full
 * or the wait ran out, "unavailable" when a store is missing or failing. Every store call is bounded by the time left,
 * and a grant that comes back after the deadline or slower than MAX_ACK_MS is not used.
 */
export function makePhotonGate(
  slots: SlotStore | null,
  queue: WaitQueue | null,
  opts: { waitMs?: number; pollMs?: number; maxWaiting?: number; id?: () => string } = {},
): PhotonGate {
  const waitMs = opts.waitMs ?? PHOTON_WAIT_MS;
  const pollMs = opts.pollMs ?? PHOTON_POLL_MS;
  const maxWaiting = opts.maxWaiting ?? PHOTON_QUEUE_MAX;
  const newId = opts.id ?? (() => crypto.randomUUID());
  return {
    async acquire() {
      if (!slots || !queue) return "unavailable";
      const started = Date.now();
      const giveUpAt = started + waitMs;
      const id = newId();
      let joined: number | typeof TIMED_OUT;
      try {
        joined = await within(giveUpAt - Date.now(), () => queue.join(PHOTON_QUEUE_KEY, id, started, started + WAITER_TTL_MS));
      } catch (err) {
        console.error("Photon queue store unreachable:", err instanceof Error ? err.message : err);
        return "unavailable";
      }
      try {
        if (joined === TIMED_OUT) return "busy";
        if (joined > maxWaiting) return "busy";
        for (;;) {
          const asked = Date.now();
          let granted: boolean | typeof TIMED_OUT;
          try {
            granted = await within(Math.min(giveUpAt - asked, MAX_ACK_MS), () => slots.claim(PHOTON_SLOT_KEY, PHOTON_SLOT_MS));
          } catch (err) {
            console.error("Photon slot store unreachable:", err instanceof Error ? err.message : err);
            return "unavailable";
          }
          const now = Date.now();
          if (granted === true && now - asked <= MAX_ACK_MS && now <= giveUpAt) return "ok";
          if (now + pollMs > giveUpAt) return "busy";
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } finally {
        // A leave that fails or never arrives is covered by this waiter's own expiry.
        queue.leave(PHOTON_QUEUE_KEY, id).catch(() => {});
      }
    },
  };
}

/** A bounded in-process cache with an expiry; the oldest entry goes first when it is full. */
export class PlaceCache {
  private entries = new Map<string, { places: Place[]; until: number }>();

  constructor(
    private readonly max = 300,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Place[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.until <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.places;
  }

  set(key: string, places: Place[]) {
    this.entries.delete(key);
    this.entries.set(key, { places, until: this.now() + this.ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }

  get size() {
    return this.entries.size;
  }
}

/** A part's name is its parent's, word for word, with more after it, and it lies this close to the parent. */
const PART_OF_PLACE_M = 1_000;

/**
 * The list without the parts of a place that is in it: "SM City Baguio Balcony" and "… Taxi Loading/Unloading Area"
 * within 1 km of "SM City Baguio" are left out, so the rider picks the place itself (#57). A part stays when the
 * query names it: a query word beyond the parent's name starts one of the part's own words, and every such query
 * word starts one of its words or its area's.
 */
export function withoutParts(places: Place[], query: string): Place[] {
  const asked = words(query);
  return places.filter((child) => {
    const childWords = words(child.name);
    return !places.some((parent) => {
      if (parent === child) return false;
      const parentWords = words(parent.name);
      if (parentWords.length === 0 || childWords.length <= parentWords.length) return false;
      if (!parentWords.every((w, i) => childWords[i] === w)) return false;
      if (distanceM(parent, child) > PART_OF_PLACE_M) return false;
      const own = childWords.slice(parentWords.length);
      const beyond = asked.filter((q) => !parentWords.some((w) => w.startsWith(q)));
      const areaWords = words(child.area);
      const named = beyond.some((q) => own.some((w) => w.startsWith(q))) && beyond.every((q) => [...own, ...areaWords].some((w) => w.startsWith(q)));
      return !named;
    });
  });
}

function merge(builtIns: Place[], found: Place[], query: string): Place[] {
  const names = new Set(builtIns.map((p) => fold(p.name)));
  return withoutParts([...builtIns, ...found.filter((p) => !names.has(fold(p.name)))], query).slice(0, MAX_PLACES);
}

export interface PlacesDeps {
  fetch: typeof fetch;
  gate: PhotonGate;
  cache: PlaceCache;
  bound: Bound;
}

export async function searchPlaces(rawQuery: unknown, bias: Bias | null, deps: PlacesDeps): Promise<PlacesReply> {
  const q = placeQuery(rawQuery);
  if (!q) return { status: "short", places: [] };
  const builtIns = builtInMatches(q, deps.bound);
  const key = `${deps.bound.id}|${bias ? `${bias.lat},${bias.lon}` : "-"}|${fold(q)}`;
  const cached = deps.cache.get(key);
  if (cached) return { status: "ok", places: merge(builtIns, cached, q) };
  const gate = await deps.gate.acquire();
  if (gate !== "ok") return { status: gate === "busy" ? "busy" : "down", places: builtIns };
  let res: Response;
  try {
    res = await deps.fetch(photonUrl(q, deps.bound, bias), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
    });
  } catch {
    return { status: "down", places: builtIns };
  }
  if (!res.ok) return { status: res.status === 429 ? "busy" : "down", places: builtIns };
  const body = await res.json().catch(() => null);
  if (body === null) return { status: "down", places: builtIns };
  const found = placesFromPhoton(body, deps.bound);
  deps.cache.set(key, found);
  return { status: "ok", places: merge(builtIns, found, q) };
}

const sharedCache = new PlaceCache();

export function placesDepsFromEnv(env: Record<string, string | undefined> = process.env): PlacesDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    gate: makePhotonGate(slotStoreFromEnv(env), waitQueueFromEnv(env)),
    cache: sharedCache,
    bound: TRIP_BOUND,
  };
}
