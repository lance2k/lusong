import { TRIP_BOUND } from "./trip-bound";

export const RAIN_CREDIT = "Rain now: model estimate, Open-Meteo (CC BY 4.0)";
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const RAIN_USER_AGENT = "Lusong/1.0 (+https://lusong-mocha.vercel.app)";

export const LATTICE_DEG = 0.1;
export const MAX_AXIS_POINTS = 5;
export const MAX_POINTS = MAX_AXIS_POINTS * MAX_AXIS_POINTS;
export const MAX_BOX_DEG = 3;
export const CACHE_TTL_MS = 15 * 60_000;
export const CACHE_MAX_ENTRIES = 2_000;
export const CALLS_PER_HOUR = 300;
export const FETCH_TIMEOUT_MS = 6_000;

const HOUR_MS = 3_600_000;

export type RainStatus = "ok" | "paused" | "refused" | "down";

export interface RainPoint {
  lat: number;
  lon: number;
  /** Precipitation in the model's last 15-minute step. */
  mm: number;
}

export interface RainReply {
  status: RainStatus;
  points: RainPoint[];
  /** ISO time (UTC) of the oldest model step among the points, or null when there are none. */
  modelTime: string | null;
  credit: typeof RAIN_CREDIT;
}

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** A lattice point as integer tenths of a degree, so the cache key and the request never carry float noise. */
interface Cell {
  latTenths: number;
  lonTenths: number;
}

const key = (c: Cell) => `${c.latTenths},${c.lonTenths}`;
const degrees = (tenths: number) => tenths / 10;

/** Tenths of a degree, rounded to kill float noise (116.9 * 10 is 1169.0000000000002). */
const tenths = (deg: number) => Number((deg * 10).toFixed(6));

/** Parse `south,west,north,east`; null for anything that is not four finite numbers in order. */
export function parseBbox(raw: string | null): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 4 || parts.some((p) => p.trim() === "")) return null;
  const [south, west, north, east] = parts.map(Number);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south >= north || west >= east) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { south, west, north, east };
}

/** `n` tenths-indices from lo to hi (inclusive), at most `cap`, spread evenly with both ends kept. */
function thin(lo: number, hi: number, cap: number): number[] {
  const count = hi - lo + 1;
  if (count <= cap) return Array.from({ length: count }, (_, i) => lo + i);
  return Array.from({ length: cap }, (_, i) => lo + Math.round((i * (hi - lo)) / (cap - 1)));
}

export type Snapped = { ok: true; cells: Cell[] } | { ok: false };

/**
 * The lattice points a map view needs: every 0.1° point inside the view (and inside the Philippines box), thinned
 * evenly to 5 per axis. Refused when the view is wider or taller than 3° or does not touch the Philippines box. A view
 * that only overlaps the box is clipped to it, so a phone looking past the edge still gets the Philippine side.
 */
export function snapBbox(box: Bbox): Snapped {
  if (box.north - box.south > MAX_BOX_DEG || box.east - box.west > MAX_BOX_DEG) return { ok: false };
  const south = Math.max(box.south, TRIP_BOUND.south);
  const north = Math.min(box.north, TRIP_BOUND.north);
  const west = Math.max(box.west, TRIP_BOUND.west);
  const east = Math.min(box.east, TRIP_BOUND.east);
  if (south > north || west > east) return { ok: false };

  const latLo = Math.max(Math.floor(tenths(south)), Math.ceil(tenths(TRIP_BOUND.south)));
  const latHi = Math.min(Math.ceil(tenths(north)), Math.floor(tenths(TRIP_BOUND.north)));
  const lonLo = Math.max(Math.floor(tenths(west)), Math.ceil(tenths(TRIP_BOUND.west)));
  const lonHi = Math.min(Math.ceil(tenths(east)), Math.floor(tenths(TRIP_BOUND.east)));
  if (latLo > latHi || lonLo > lonHi) return { ok: false };

  const lats = thin(latLo, latHi, MAX_AXIS_POINTS);
  const lons = thin(lonLo, lonHi, MAX_AXIS_POINTS);
  const cells: Cell[] = [];
  for (const latTenths of lats) for (const lonTenths of lons) cells.push({ latTenths, lonTenths });
  return { ok: true, cells };
}

export interface ParsedPoint {
  mm: number;
  /** ISO time of the model step, UTC. */
  time: string;
}

/**
 * Open-Meteo answers one coordinate with an object and several with an array, in request order. Each element's own
 * latitude/longitude is the model grid cell it snapped to, not the requested point, so points are matched by position.
 * Null when the body is not the expected shape for `expected` points.
 */
export function parseOpenMeteo(body: unknown, expected: number): ParsedPoint[] | null {
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== expected) return null;
  const out: ParsedPoint[] = [];
  for (const item of list) {
    const current = (item as { current?: { time?: unknown; precipitation?: unknown } } | null)?.current;
    if (!current || typeof current.time !== "string" || typeof current.precipitation !== "number") return null;
    if (!Number.isFinite(current.precipitation) || current.precipitation < 0) return null;
    const withZone = /(Z|[+-]\d\d:\d\d)$/.test(current.time) ? current.time : `${current.time}Z`;
    const ms = Date.parse(withZone);
    if (!Number.isFinite(ms)) return null;
    out.push({ mm: current.precipitation, time: new Date(ms).toISOString() });
  }
  return out;
}

export function openMeteoUrl(cells: Cell[]): string {
  const params = new URLSearchParams({
    latitude: cells.map((c) => degrees(c.latTenths).toFixed(1)).join(","),
    longitude: cells.map((c) => degrees(c.lonTenths).toFixed(1)).join(","),
    current: "precipitation,rain",
  });
  return `${OPEN_METEO_URL}?${params.toString().replace(/%2C/g, ",")}`;
}

export interface RainDeps {
  fetch: typeof fetch;
  now: () => number;
}

interface CacheEntry extends ParsedPoint {
  fetchedAt: number;
}

export interface RainService {
  rain(rawBbox: string | null): Promise<RainReply>;
  /** For tests and probes. */
  stats(): { cached: number; callsLastHour: number };
}

const reply = (status: RainStatus, points: RainPoint[] = [], modelTime: string | null = null): RainReply => ({
  status,
  points,
  modelTime,
  credit: RAIN_CREDIT,
});

export function createRain(deps: RainDeps): RainService {
  const cache = new Map<string, CacheEntry>();
  let callTimes: number[] = [];

  function liveEntry(k: string, now: number): CacheEntry | null {
    const e = cache.get(k);
    if (!e) return null;
    if (now - e.fetchedAt >= CACHE_TTL_MS) {
      cache.delete(k);
      return null;
    }
    return e;
  }

  function store(k: string, e: CacheEntry, now: number) {
    cache.delete(k);
    cache.set(k, e);
    if (cache.size <= CACHE_MAX_ENTRIES) return;
    for (const [oldKey, old] of cache) {
      if (now - old.fetchedAt >= CACHE_TTL_MS) cache.delete(oldKey);
    }
    // Map iterates in insertion order, so the first keys are the oldest fetches.
    for (const oldKey of cache.keys()) {
      if (cache.size <= CACHE_MAX_ENTRIES) break;
      cache.delete(oldKey);
    }
  }

  function callsLastHour(now: number): number {
    callTimes = callTimes.filter((t) => now - t < HOUR_MS);
    return callTimes.length;
  }

  async function rain(rawBbox: string | null): Promise<RainReply> {
    const box = parseBbox(rawBbox);
    if (!box) return reply("refused");
    const snapped = snapBbox(box);
    if (!snapped.ok) return reply("refused");

    const now = deps.now();
    const found = new Map<string, CacheEntry>();
    const missing: Cell[] = [];
    for (const c of snapped.cells) {
      const e = liveEntry(key(c), now);
      if (e) found.set(key(c), e);
      else missing.push(c);
    }

    if (missing.length > 0) {
      if (callsLastHour(now) >= CALLS_PER_HOUR) return reply("paused");
      callTimes.push(now);
      let parsed: ParsedPoint[] | null = null;
      try {
        const res = await deps.fetch(openMeteoUrl(missing), {
          headers: { "User-Agent": RAIN_USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) parsed = parseOpenMeteo(await res.json(), missing.length);
      } catch {
        parsed = null;
      }
      if (!parsed) return reply("down");
      const fetchedAt = deps.now();
      missing.forEach((c, i) => {
        const entry = { ...parsed[i], fetchedAt };
        store(key(c), entry, fetchedAt);
        found.set(key(c), entry);
      });
    }

    const points = snapped.cells.map((c) => ({
      lat: degrees(c.latTenths),
      lon: degrees(c.lonTenths),
      mm: found.get(key(c))!.mm,
    }));
    const times = snapped.cells.map((c) => found.get(key(c))!.time).sort();
    return reply("ok", points, times[0]);
  }

  return {
    rain,
    stats: () => ({ cached: cache.size, callsLastHour: callsLastHour(deps.now()) }),
  };
}

let shared: RainService | null = null;

/** One service per server process: its cache and hourly count are what keep Open-Meteo's free tier safe. */
export function sharedRain(): RainService {
  shared ??= createRain({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  return shared;
}
