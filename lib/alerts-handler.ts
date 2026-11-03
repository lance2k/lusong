import { runDelivery, type DeliverySummary } from "./alert-delivery";
import { alertStoreFromEnv } from "./alerts";
import { advisoryStoreFromEnv } from "./advisory-snapshot";
import { channelFromEnv } from "./channel";
import { sameSecret } from "./watch-handler";
import { watchStoreFromEnv } from "./watch-store";
import { placesDepsFromEnv, searchPlaces } from "./places";
import { safeFetch } from "./safe-fetch";
import { allowedHost } from "./sweep-admit";
import { runSweep, sweepLedgerFromEnv, sweepStoreFromEnv, wonderFromEnv, type SweepSummary } from "./sweep";

const NOT_SET_UP = "Alerts aren't set up yet.";

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** A Bearer of WATCH_TICK_SECRET, as the watch tick and the advisory snapshot take; unset refuses every call. */
export function authorized(request: Request, secret: string | undefined): Response | null {
  if (!secret) return fail(503, NOT_SET_UP);
  const auth = request.headers.get("authorization");
  const given = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  return sameSecret(given, secret) ? null : fail(401, "Unauthorized.");
}

/** POST /api/alerts/deliver, called by the scheduler (QStash `lusong-alert-deliver`). It answers with counts only. */
export function makeDeliverHandler(deps: { secret: () => string | undefined; deliver: () => Promise<DeliverySummary | null> }) {
  return async function POST(request: Request): Promise<Response> {
    const refused = authorized(request, deps.secret());
    if (refused) return refused;
    const summary = await deps.deliver();
    if (!summary) return fail(503, NOT_SET_UP);
    return Response.json(summary, { status: summary.ok ? 200 : 503 });
  };
}

export function deliverHandlerFromEnv() {
  return makeDeliverHandler({
    secret: () => process.env.WATCH_TICK_SECRET,
    deliver: async () => {
      const watches = watchStoreFromEnv();
      const alerts = alertStoreFromEnv();
      const channel = channelFromEnv();
      if (!watches || !alerts || !channel) return null;
      return runDelivery({ watches, alerts, advisory: advisoryStoreFromEnv(), channel, now: () => new Date() });
    },
  });
}

/** POST /api/alerts/sweep, called by the scheduler (QStash `lusong-alert-sweep`). It answers with counts only. */
export function makeSweepHandler(deps: { secret: () => string | undefined; sweep: () => Promise<SweepSummary | null> }) {
  return async function POST(request: Request): Promise<Response> {
    const refused = authorized(request, deps.secret());
    if (refused) return refused;
    const summary = await deps.sweep();
    if (!summary) return fail(503, NOT_SET_UP);
    return Response.json(summary, { status: summary.ok ? 200 : 503 });
  };
}

/** Discovery, the one paid call, runs only with LUSONG_SWEEP=on and MODEL_API_KEY set; admission runs either way. */
export function sweepHandlerFromEnv() {
  return makeSweepHandler({
    secret: () => process.env.WATCH_TICK_SECRET,
    sweep: async () => {
      const sweeps = sweepStoreFromEnv();
      const alerts = alertStoreFromEnv();
      if (!sweeps || !alerts) return null;
      const places = placesDepsFromEnv();
      const budgetUsd = Number(process.env.DAILY_BUDGET_USD ?? "10");
      return runSweep({
        sweeps,
        alerts,
        ledger: sweepLedgerFromEnv(),
        budgetMicros: Number.isFinite(budgetUsd) && budgetUsd > 0 ? Math.floor(budgetUsd * 1e6) : 0,
        wonder: wonderFromEnv,
        admit: {
          fetchPage: (url) => safeFetch(url, { allowHost: allowedHost }),
          geocode: async (query) => {
            const found = await searchPlaces(query, null, places);
            // A query Photon can't take is no place found: a province-wide warning, not a retry.
            if (found.status === "short") return { status: "ok", places: [] };
            return found.status === "ok" ? { status: "ok", places: found.places } : { status: "unavailable" };
          },
        },
        now: () => new Date(),
        enabled: process.env.LUSONG_SWEEP === "on" && Boolean(process.env.MODEL_API_KEY),
      });
    },
  });
}
