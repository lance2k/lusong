import { countStoreFromEnv, createAddressLimit, type AddressLimit } from "./address-limit";
import { admit } from "./admission";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { readBody } from "./deadline";
import { MetaApiError } from "./meta";
import { placesDepsFromEnv, type PlacesDeps } from "./places";
import { readTripText, resolveTrip, TRIP_TEXT_RESERVE_MICROS, tripTextOf, type ReadTrip } from "./trip-text";
import { TRIP_TEXT_PER_IP_DAILY, type TripTextReason } from "./trip-text-words";

/** The per-address count's keys: `lusong:trip-text:ip:<day>:<hash>`, apart from the daily checks' `lusong:ip:…`. */
export const TRIP_TEXT_LIMIT_PREFIX = "lusong:trip-text";

const MAX_BODY_BYTES = 4 * 1024;
const BODY_WAIT_MS = 5_000;
/** The model's share of the route's time; Photon's gate waits at most 3 s and its request 4 s after it. */
const READ_MS = 25_000;

export function tripTextLimitFromEnv(env: Record<string, string | undefined> = process.env): AddressLimit {
  return createAddressLimit({ store: countStoreFromEnv(env), prefix: TRIP_TEXT_LIMIT_PREFIX, limit: TRIP_TEXT_PER_IP_DAILY });
}

function failed(status: number, reason: TripTextReason): Response {
  return Response.json({ status: "failed", reason }, { status, headers: { "Cache-Control": "no-store" } });
}

export interface TripTextDeps {
  budget: () => Budget;
  limit: () => AddressLimit;
  places: () => PlacesDeps;
  read?: ReadTrip;
  now?: () => Date;
}

/**
 * POST { text }: the typed trip read by Muse Spark into two place strings and a time, the strings resolved by the place
 * search, and the reply built from the search's places only. Neither the text nor the model's strings are kept, logged
 * or sent back.
 */
export function makeTripTextHandler(
  deps: TripTextDeps = { budget: budgetFromEnv, limit: tripTextLimitFromEnv, places: placesDepsFromEnv },
) {
  const read = deps.read ?? readTripText;
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: Date.now() + BODY_WAIT_MS });
    if (!(body instanceof Uint8Array)) return failed(body === "too_large" ? 413 : 408, "text");
    let sent: unknown;
    try {
      sent = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return failed(400, "text");
    }
    const text = tripTextOf((sent as { text?: unknown } | null)?.text);
    if (!text) return failed(400, "text");

    const at = now();
    const taken = await deps.limit().take(clientIp(request), at);
    if (taken === "limited") return failed(429, "ip");
    if (taken === "unavailable") return failed(503, "unavailable");

    // No address: a typed trip counts against the daily budget and never against an address's 10 checks.
    const admission = await admit(deps.budget(), { clientIp: null, reserveMicros: TRIP_TEXT_RESERVE_MICROS, now: at });
    if (!admission.ok) return failed(503, admission.reason === "budget" ? "budget" : "unavailable");

    const { run } = admission;
    let reading: Awaited<ReturnType<ReadTrip>>;
    try {
      reading = await read(text, { meter: run.meter, deadline: Date.now() + READ_MS });
    } catch (err) {
      // Only the endpoint and status: a parse error or an upstream body could quote the rider's words.
      console.error("typed trip reading failed:", err instanceof MetaApiError ? err.message : "not a Meta API error");
      await run.settle(false);
      return failed(502, "model");
    }
    await run.settle(true);

    const reply = await resolveTrip(reading, deps.places());
    const status = reply.status === "ok" ? 200 : reply.reason === "search" ? 503 : 422;
    return Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });
  };
}
