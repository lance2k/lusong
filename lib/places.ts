import { USER_AGENT } from "./advisory";
import { MAX_ACK_MS, slotStoreFromEnv, type SlotStore } from "./router";
import { builtInMatches, fold, MAX_PLACES, placeQuery, type Place, type PlacesReply } from "./built-in-places";
import { inBound, TRIP_BOUND, type Bound } from "./trip-bound";

export * from "./built-in-places";

export const PHOTON_URL = "https://photon.komoot.io/api/";
const PHOTON_TIMEOUT_MS = 4_000;

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
    });
  }
  return out;
}

/** INCRBY with a sliding expiry, so a caller that dies before decrementing frees its place within ttlMs. */
export interface CounterStore {
  add(key: string, delta: number, ttlMs: number): Promise<number>;
}

export class MemoryCounterStore implements CounterStore {
  private values = new Map<string, { n: number; until: number }>();

  async add(key: string, delta: number, ttlMs: number) {
    const now = Date.now();
    const cur = this.values.get(key);
    const n = (cur && cur.until > now ? cur.n : 0) + delta;
    this.values.set(key, { n, until: now + ttlMs });
    return n;
  }
}

const COUNTER_SCRIPT = "local n = redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ARGV[2]); return n";

export class UpstashCounterStore implements CounterStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async add(key: string, delta: number, ttlMs: number) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["EVAL", COUNTER_SCRIPT, "1", key, String(delta), String(ttlMs)]),
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined || typeof body.result !== "number") throw new Error(`Upstash HTTP ${res.status}`);
    return body.result;
  }
}

const sharedMemoryCounter = (() => {
  let store: MemoryCounterStore | null = null;
  return () => (store ??= new MemoryCounterStore());
})();

export function counterStoreFromEnv(env: Record<string, string | undefined> = process.env): CounterStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemoryCounter();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashCounterStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashCounterStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}

/** One key for every Lusong instance, so Photon sees at most one Lusong request a second. */
export const PHOTON_SLOT_KEY = "lusong:photon:slot";
export const PHOTON_SLOT_MS = 1_000 + MAX_ACK_MS;
export const PHOTON_QUEUE_KEY = "lusong:photon:waiting";
export const PHOTON_QUEUE_MAX = 20;
export const PHOTON_WAIT_MS = 3_000;
const PHOTON_POLL_MS = 250;
const QUEUE_TTL_MS = 10_000;

export type GateOutcome = "ok" | "busy" | "unavailable";

export interface PhotonGate {
  acquire(): Promise<GateOutcome>;
}

export function makePhotonGate(
  slots: SlotStore | null,
  queue: CounterStore | null,
  opts: { waitMs?: number; pollMs?: number; maxWaiting?: number } = {},
): PhotonGate {
  const waitMs = opts.waitMs ?? PHOTON_WAIT_MS;
  const pollMs = opts.pollMs ?? PHOTON_POLL_MS;
  const maxWaiting = opts.maxWaiting ?? PHOTON_QUEUE_MAX;
  return {
    async acquire() {
      if (!slots || !queue) return "unavailable";
      let waiting: number;
      try {
        waiting = await queue.add(PHOTON_QUEUE_KEY, 1, QUEUE_TTL_MS);
      } catch (err) {
        console.error("Photon queue store unreachable:", err instanceof Error ? err.message : err);
        return "unavailable";
      }
      try {
        if (waiting > maxWaiting) return "busy";
        const giveUpAt = Date.now() + waitMs;
        for (;;) {
          try {
            const asked = Date.now();
            const granted = await slots.claim(PHOTON_SLOT_KEY, PHOTON_SLOT_MS);
            if (granted && Date.now() - asked <= MAX_ACK_MS) return "ok";
          } catch (err) {
            console.error("Photon slot store unreachable:", err instanceof Error ? err.message : err);
            return "unavailable";
          }
          if (Date.now() + pollMs > giveUpAt) return "busy";
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } finally {
        queue.add(PHOTON_QUEUE_KEY, -1, QUEUE_TTL_MS).catch(() => {});
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

function merge(builtIns: Place[], found: Place[]): Place[] {
  const names = new Set(builtIns.map((p) => fold(p.name)));
  return [...builtIns, ...found.filter((p) => !names.has(fold(p.name)))].slice(0, MAX_PLACES);
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
  if (cached) return { status: "ok", places: merge(builtIns, cached) };
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
  return { status: "ok", places: merge(builtIns, found) };
}

const sharedCache = new PlaceCache();

export function placesDepsFromEnv(env: Record<string, string | undefined> = process.env): PlacesDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    gate: makePhotonGate(slotStoreFromEnv(env), counterStoreFromEnv(env)),
    cache: sharedCache,
    bound: TRIP_BOUND,
  };
}
