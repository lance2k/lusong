import { runDelivery, type DeliverySummary } from "./alert-delivery";
import { alertStoreFromEnv } from "./alerts";
import { advisoryStoreFromEnv } from "./advisory-snapshot";
import { channelFromEnv } from "./channel";
import { sameSecret } from "./watch-handler";
import { watchStoreFromEnv } from "./watch-store";

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
