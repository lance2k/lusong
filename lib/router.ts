import type { Point } from "./answer";
import { USER_AGENT } from "./advisory";

/** FOSSGIS's public Valhalla server: free, shared, fair use, no key. */
export const VALHALLA_URL = "https://valhalla1.openstreetmap.de";
export const VALHALLA_CLIENT_ID = "lusong";

/** One key for every Lusong instance, so the 1-request-a-second limit holds across all of them. */
export const VALHALLA_SLOT_KEY = "lusong:valhalla:slot";
/** 1 s plus 50 ms for the gap between claiming the slot and the request leaving. */
export const VALHALLA_SLOT_MS = 1_050;
export const GATE_WAIT_MS = 4_000;
const GATE_POLL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPTS = 2;

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
          if (await store.claim(VALHALLA_SLOT_KEY, VALHALLA_SLOT_MS)) return "ok";
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

export interface Route {
  line: Point[];
  lengthKm: number;
  timeMin: number;
  /** Street names in the order the route takes them. */
  streets: string[];
}

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: "unreachable" | "busy" | "gate_unavailable" | "no_route" };

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
        byte = encoded.charCodeAt(index++) - 63;
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
    summary?: { length?: number; time?: number };
    legs?: { shape?: string; maneuvers?: { street_names?: string[] }[] }[];
  };
  error_code?: number;
}

function readTrip(body: ValhallaTrip): Route | null {
  const leg = body.trip?.legs?.[0];
  const summary = body.trip?.summary;
  if (!leg?.shape || typeof summary?.length !== "number" || typeof summary.time !== "number") return null;
  const line = decodePolyline6(leg.shape);
  if (line.length < 2) return null;
  const streets = [...new Set((leg.maneuvers ?? []).flatMap((m) => m.street_names?.slice(0, 1) ?? []))];
  return { line, lengthKm: summary.length, timeMin: summary.time / 60, streets };
}

/** Valhalla's code for "No path could be found for input". */
const NO_PATH = 442;

export async function fetchRoute(
  request: { from: Point; to: Point; excludePolygons?: Point[][] },
  deps: { fetch: typeof fetch; gate: ValhallaGate },
): Promise<RouteResult> {
  const body = {
    locations: [request.from, request.to],
    costing: "motorcycle",
    ...(request.excludePolygons ? { exclude_polygons: request.excludePolygons.map((ring) => ring.map((p) => [p.lon, p.lat])) } : {}),
    directions_options: { units: "kilometers" },
  };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const gate = await deps.gate.acquire();
    if (gate === "busy") return { ok: false, reason: "busy" };
    if (gate === "unavailable") return { ok: false, reason: "gate_unavailable" };
    let res: Response;
    try {
      res = await deps.fetch(`${VALHALLA_URL}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "X-Client-Id": VALHALLA_CLIENT_ID },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.error("Valhalla unreachable:", err instanceof Error ? err.message : err);
      continue;
    }
    if (res.status >= 500 || res.status === 429) continue;
    const parsed = (await res.json().catch(() => null)) as ValhallaTrip | null;
    if (!res.ok) return { ok: false, reason: parsed?.error_code === NO_PATH ? "no_route" : "unreachable" };
    const route = parsed && readTrip(parsed);
    return route ? { ok: true, route } : { ok: false, reason: "unreachable" };
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
