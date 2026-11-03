import { countStoreFromEnv, createAddressLimit, type AddressLimit } from "./address-limit";
import { admit } from "./admission";
import { budgetFromEnv, type Budget } from "./budget";
import { clientIp } from "./check-handler";
import { beforeDeadline, readBody } from "./deadline";
import { MetaApiError } from "./meta";
import { placesDepsFromEnv, type PlacesDeps } from "./places";
import { readTripText, resolveTrip, TRIP_TEXT_RESERVE_MICROS, tripTextOf, type ReadTrip } from "./trip-text";
import { TRIP_TEXT_PER_IP_DAILY, type TripTextReason, type TripTextReply } from "./trip-text-words";

/** The per-address count's keys: `lusong:trip-text:ip:<day>:<hash>`, apart from the daily checks' `lusong:ip:…`. */
export const TRIP_TEXT_LIMIT_PREFIX = "lusong:trip-text";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * One deadline, `totalMs` from the request's arrival, for the whole run. The model call starts only with `readMs` plus
 * `afterReadMs` left: the settle's store call (5 s at most), both place searches (Photon's gate waits 3 s, its request
 * 4 s) and `replyMs` to answer. app/api/trip-text/route.ts gives the function more than `totalMs`.
 */
export interface TripTextTiming {
  totalMs: number;
  bodyMs: number;
  readMs: number;
  afterReadMs: number;
  replyMs: number;
}

export const TRIP_TEXT_TIMING: TripTextTiming = { totalMs: 40_000, bodyMs: 5_000, readMs: 20_000, afterReadMs: 13_000, replyMs: 1_000 };

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
  timing?: TripTextTiming;
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
  const timing = deps.timing ?? TRIP_TEXT_TIMING;

  return async function POST(request: Request): Promise<Response> {
    const deadline = Date.now() + timing.totalMs;
    const replyBy = deadline - timing.replyMs;
    const readBy = deadline - timing.afterReadMs;

    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: Math.min(Date.now() + timing.bodyMs, readBy) });
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
    const taken = await beforeDeadline(deps.limit().take(clientIp(request), at), readBy);
    if (taken === "late" || taken === "unavailable") return failed(503, "unavailable");
    if (taken === "limited") return failed(429, "ip");

    // No address: a typed trip counts against the daily budget and never against an address's 10 checks.
    const admitting = admit(deps.budget(), { clientIp: null, reserveMicros: TRIP_TEXT_RESERVE_MICROS, now: at });
    const admission = await beforeDeadline(admitting, readBy);
    if (admission === "late") {
      // No model call will start, so a reservation that lands late is refunded in full.
      void admitting.then((a) => (a.ok ? a.run.settle(true) : undefined), () => {});
      return failed(503, "unavailable");
    }
    if (!admission.ok) return failed(503, admission.reason === "budget" ? "budget" : "unavailable");

    const { run } = admission;
    if (readBy - Date.now() < timing.readMs) {
      await run.settle(true);
      return failed(503, "unavailable");
    }
    let reading: Awaited<ReturnType<ReadTrip>> | "late";
    try {
      reading = await beforeDeadline(read(text, { meter: run.meter, deadline: Date.now() + timing.readMs }), readBy);
    } catch (err) {
      // Only the endpoint and status: a parse error or an upstream body could quote the rider's words.
      console.error("typed trip reading failed:", err instanceof MetaApiError ? err.message : "not a Meta API error");
      await run.settle(false);
      return failed(502, "model");
    }
    if (reading === "late") {
      console.error("typed trip reading failed: out of time");
      await run.settle(false);
      return failed(502, "model");
    }
    await run.settle(true);

    const resolved = await beforeDeadline(resolveTrip(reading, deps.places()), replyBy);
    const reply: TripTextReply = resolved === "late" ? { status: "failed", reason: "search" } : resolved;
    const status = reply.status === "ok" ? 200 : reply.reason === "search" ? 503 : 422;
    return Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });
  };
}
