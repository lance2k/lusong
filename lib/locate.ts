import { USER_AGENT } from "./advisory";
import type { Point } from "./answer";
import { VALHALLA_CLIENT_ID, VALHALLA_URL, wayIdFromLocate, type ValhallaGate } from "./router";

const REQUEST_TIMEOUT_MS = 10_000;

export interface Spot {
  wayId: number | null;
  place: string | null;
}

interface LocateEdge {
  distance?: number;
  edge_info?: { way_id?: number; names?: string[] };
}

const NOWHERE: Spot = { wayId: null, place: null };

/** The gate's answer, or "late" once the deadline (epoch ms) passes first. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | "late"> {
  if (deadline === Infinity) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()))));
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first name of each way at the nearest distance: one street, or a corner's two. */
function placeOf(edges: LocateEdge[]): string | null {
  const named = edges.filter((e) => typeof e.distance === "number" && typeof e.edge_info?.way_id === "number");
  if (named.length === 0) return null;
  const nearest = Math.min(...named.map((e) => e.distance!));
  const names = new Map<number, string>();
  for (const e of named) {
    const name = e.edge_info!.names?.find((n) => typeof n === "string" && n.trim() !== "");
    if (e.distance === nearest && name && !names.has(e.edge_info!.way_id!)) names.set(e.edge_info!.way_id!, name);
  }
  return names.size === 0 ? null : [...new Set(names.values())].join(" at ");
}

/**
 * One /locate request through the shared Valhalla gate, never retried: a report is stored whether or not its road is
 * found, and a missing way id only means it can never retire a blocker.
 */
export async function locateSpot(
  at: Point,
  deps: { fetch: typeof fetch; gate: ValhallaGate },
  opts: { deadline?: number } = {},
): Promise<Spot> {
  const deadline = opts.deadline ?? Infinity;
  if ((await beforeDeadline(deps.gate.acquire(), deadline)) !== "ok") return NOWHERE;
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) return NOWHERE;
  try {
    const res = await deps.fetch(`${VALHALLA_URL}/locate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "X-Client-Id": VALHALLA_CLIENT_ID },
      body: JSON.stringify({ locations: [{ lat: at.lat, lon: at.lon }], costing: "motorcycle", verbose: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return NOWHERE;
    const body = (await res.json().catch(() => null)) as { edges?: LocateEdge[] | null }[] | null;
    const entry = Array.isArray(body) ? body[0] : null;
    if (!entry || !Array.isArray(entry.edges)) return NOWHERE;
    return { wayId: wayIdFromLocate(entry), place: placeOf(entry.edges) };
  } catch (err) {
    console.error("Valhalla /locate unreachable:", err instanceof Error ? err.message : err);
    return NOWHERE;
  }
}
