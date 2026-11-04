import { distanceM, type Point } from "./answer";
import { USER_AGENT } from "./advisory";
import { beforeDeadline } from "./deadline";

/** FOSSGIS's public Valhalla server: free, shared, fair use, no key. */
export const VALHALLA_URL = "https://valhalla1.openstreetmap.de";
export const VALHALLA_CLIENT_ID = "lusong";

/** One key for every Lusong instance, so the 1-request-a-second limit holds across all of them. */
export const VALHALLA_SLOT_KEY = "lusong:valhalla:slot";
/**
 * The lease starts in the store before the caller hears it was granted. A grant is used only when its round trip took at
 * most MAX_ACK_MS, so the request leaves at most MAX_ACK_MS into a lease of 1 s + MAX_ACK_MS, and the next lease, which
 * cannot start before this one ends, puts the next request at least 1 s later.
 */
export const MAX_ACK_MS = 500;
export const VALHALLA_SLOT_MS = 1_000 + MAX_ACK_MS;
export const GATE_WAIT_MS = 4_000;
const GATE_POLL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPTS = 2;
/** An attempt isn't started with less than this before the caller's deadline. */
const MIN_ATTEMPT_MS = 500;
/** The longest one fetchRoute can take: each attempt waits for the slot, then for Valhalla. */
export const ROUTE_WORST_MS = ATTEMPTS * (GATE_WAIT_MS + REQUEST_TIMEOUT_MS);

/** `SET key 1 NX PX ttl`: true when this caller took the slot. */
export interface SlotStore {
  claim(key: string, ttlMs: number): Promise<boolean>;
}

export class MemorySlotStore implements SlotStore {
  private until = new Map<string, number>();

  async claim(key: string, ttlMs: number) {
    const now = Date.now();
    if ((this.until.get(key) ?? 0) > now) return false;
    this.until.set(key, now + ttlMs);
    return true;
  }
}

export class UpstashSlotStore implements SlotStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "",
  ) {}

  async claim(key: string, ttlMs: number) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", this.prefix ? `${this.prefix}:${key}` : key, "1", "NX", "PX", String(ttlMs)]),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`Upstash HTTP ${res.status}`);
    return body.result === "OK";
  }
}

const sharedMemorySlots = (() => {
  let store: MemorySlotStore | null = null;
  return () => (store ??= new MemorySlotStore());
})();

/** The same store and switches as the budget (lib/budget.ts); anything missing means no store, so no request. */
export function slotStoreFromEnv(env: Record<string, string | undefined> = process.env): SlotStore | null {
  if (env.LUSONG_BUDGET_STORE === "memory") {
    const deployed = Boolean(env.VERCEL) || env.NODE_ENV === "production";
    return deployed ? null : sharedMemorySlots();
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new UpstashSlotStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) return new UpstashSlotStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN);
  return null;
}

export type GateOutcome = "ok" | "busy" | "unavailable";

export interface ValhallaGate {
  /** Resolves once this caller may start one request, or says why it may not. */
  acquire(): Promise<GateOutcome>;
}

export function makeValhallaGate(
  store: SlotStore | null,
  opts: { waitMs?: number; pollMs?: number } = {},
): ValhallaGate {
  const waitMs = opts.waitMs ?? GATE_WAIT_MS;
  const pollMs = opts.pollMs ?? GATE_POLL_MS;
  return {
    async acquire() {
      if (!store) return "unavailable";
      const giveUpAt = Date.now() + waitMs;
      for (;;) {
        try {
          const asked = Date.now();
          const granted = await store.claim(VALHALLA_SLOT_KEY, VALHALLA_SLOT_MS);
          if (granted && Date.now() - asked <= MAX_ACK_MS) return "ok";
        } catch (err) {
          console.error("Valhalla slot store unreachable:", err instanceof Error ? err.message : err);
          return "unavailable";
        }
        if (Date.now() + pollMs > giveUpAt) return "busy";
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}

/** Ends further apart than this in a straight line are refused before Valhalla is asked. */
export const MAX_TRIP_STRAIGHT_KM = 100;
/** A route, plain or a way around, longer than this is refused: Lusong checks commutes, not long-distance trips. */
export const MAX_ROUTE_KM = 150;

export function endsTooFarApart(from: Point, to: Point): boolean {
  return distanceM(from, to) > MAX_TRIP_STRAIGHT_KM * 1_000;
}

export interface Route {
  line: Point[];
  lengthKm: number;
  timeMin: number;
  /** Street names in the order the route takes them. */
  streets: string[];
}

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: "unreachable" | "busy" | "gate_unavailable" | "no_route" | "ferry" | "too_far" | "too_long" | "out_of_time" };

export function decodePolyline6(encoded: string): Point[] {
  const out: Point[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    const deltas: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        if (index >= encoded.length) throw new Error("truncated polyline");
        // Six 5-bit chunks hold ±536 degrees at 1e6; a seventh would overflow 32-bit shifts into a plausible point.
        if (shift >= 30) throw new Error("overlong polyline value");
        const code = encoded.charCodeAt(index++);
        if (code < 63 || code > 126) throw new Error("character outside the polyline encoding");
        byte = code - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0];
    lon += deltas[1];
    out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return out;
}

interface ValhallaTrip {
  trip?: {
    summary?: { length?: number; time?: number; has_ferry?: boolean };
    legs?: { shape?: string; summary?: { has_ferry?: boolean }; maneuvers?: { street_names?: string[] }[] }[];
  };
  error_code?: number;
}

const onEarth = (p: Point) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** A road's number as OSM gives it ("54", "N54", "AH26", "C-5"), which Valhalla lists among a road's names. */
const ROAD_NUMBER = /^[A-Z]{0,3}-?\d+[A-Z]?$/i;

/**
 * A maneuver's road as the route line says it: its first name that isn't a number ("EDSA" over "1" and "AH26"), or
 * "road 54" when it has only a number, never the bare "54" (#58).
 */
function streetName(names: readonly string[]): string | null {
  const trimmed = names.map((n) => n.trim()).filter(Boolean);
  const named = trimmed.find((n) => !ROAD_NUMBER.test(n));
  if (named) return named;
  return trimmed.length > 0 ? `road ${trimmed[0]}` : null;
}

/** Anything not shaped like a Valhalla trip is null, never a thrown error or a half-read route. */
function readTrip(body: ValhallaTrip): (Route & { hasFerry: boolean }) | null {
  const leg = body.trip?.legs?.[0];
  const summary = body.trip?.summary;
  if (typeof leg?.shape !== "string" || typeof summary?.length !== "number" || typeof summary.time !== "number") return null;
  let line: Point[];
  try {
    line = decodePolyline6(leg.shape);
  } catch {
    return null;
  }
  if (line.length < 2 || !line.every(onEarth)) return null;
  const maneuvers: unknown = leg.maneuvers ?? [];
  if (!Array.isArray(maneuvers)) return null;
  const streets: string[] = [];
  for (const m of maneuvers) {
    const names: unknown = (m as { street_names?: unknown })?.street_names ?? [];
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) return null;
    const street = streetName(names);
    if (street && !streets.includes(street)) streets.push(street);
  }
  const hasFerry = summary.has_ferry === true || (Array.isArray(body.trip?.legs) ? body.trip.legs : []).some((l) => l?.summary?.has_ferry === true);
  return { line, lengthKm: summary.length, timeMin: summary.time / 60, streets, hasFerry };
}

/** Valhalla's code for "No path could be found for input". */
const NO_PATH = 442;

export async function fetchRoute(
  request: { from: Point; to: Point; excludePolygons?: Point[][] },
  deps: { fetch: typeof fetch; gate: ValhallaGate; deadline?: number },
): Promise<RouteResult> {
  const deadline = deps.deadline ?? Infinity;
  if (endsTooFarApart(request.from, request.to)) return { ok: false, reason: "too_far" };
  const body = {
    locations: [request.from, request.to],
    costing: "motorcycle",
    // Valhalla still returns a ferry route with this when there is no road (2026-11-03 Cebu → Tagbilaran probe), so a
    // reply with a ferry is refused below as well.
    costing_options: { motorcycle: { use_ferry: 0 } },
    ...(request.excludePolygons ? { exclude_polygons: request.excludePolygons.map((ring) => ring.map((p) => [p.lon, p.lat])) } : {}),
    directions_options: { units: "kilometers" },
  };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (deadline - Date.now() < MIN_ATTEMPT_MS) return { ok: false, reason: "out_of_time" };
    const gate = await beforeDeadline(deps.gate.acquire(), deadline);
    if (gate === "late") return { ok: false, reason: "out_of_time" };
    if (gate === "busy") return { ok: false, reason: "busy" };
    if (gate === "unavailable") return { ok: false, reason: "gate_unavailable" };
    let res: Response;
    try {
      res = await deps.fetch(`${VALHALLA_URL}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "X-Client-Id": VALHALLA_CLIENT_ID },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))),
      });
    } catch (err) {
      console.error("Valhalla unreachable:", err instanceof Error ? err.message : err);
      if (Date.now() >= deadline) return { ok: false, reason: "out_of_time" };
      continue;
    }
    if (res.status >= 500 || res.status === 429) continue;
    const parsed = (await res.json().catch(() => null)) as ValhallaTrip | null;
    if (!res.ok) return { ok: false, reason: parsed?.error_code === NO_PATH ? "no_route" : "unreachable" };
    const trip = parsed && readTrip(parsed);
    if (!trip) return { ok: false, reason: "unreachable" };
    const { hasFerry, ...route } = trip;
    if (hasFerry) return { ok: false, reason: "ferry" };
    if (route.lengthKm > MAX_ROUTE_KM) return { ok: false, reason: "too_long" };
    return { ok: true, route };
  }
  return { ok: false, reason: "unreachable" };
}

interface LocateEntry {
  edges?: { distance?: number; edge_info?: { way_id?: number } }[] | null;
}

/** The OSM way of the nearest edge, or null when two ways tie for nearest (a corner) or none is found. */
export function wayIdFromLocate(entry: LocateEntry): number | null {
  const edges = (entry.edges ?? []).filter((e) => typeof e.distance === "number" && typeof e.edge_info?.way_id === "number");
  if (edges.length === 0) return null;
  const nearest = Math.min(...edges.map((e) => e.distance!));
  const ways = new Set(edges.filter((e) => e.distance === nearest).map((e) => e.edge_info!.way_id!));
  return ways.size === 1 ? [...ways][0] : null;
}
