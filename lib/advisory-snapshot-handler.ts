import { alertStoreFromEnv, pagasaAlerts, type AlertStore } from "./alerts";
import { advisoryStoreFromEnv, incompleteWhy, refreshSnapshot, type AdvisoryStore } from "./advisory-snapshot";
import { sameSecret } from "./watch-handler";

const NOT_SET_UP = "The advisory snapshot isn't set up yet.";

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * POST /api/advisory/snapshot: the scheduled refresh, authenticated as the watch tick is (a Bearer of WATCH_TICK_SECRET),
 * so the one scheduler secret covers both. It answers with counts only, never the records.
 */
export function makeSnapshotHandler(deps: {
  secret: () => string | undefined;
  store: () => AdvisoryStore | null;
  /** Rebuilt from a complete snapshot as soon as it publishes, so a Cancel stops alert sends before the next delivery run. */
  alerts?: () => AlertStore | null;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  return async function POST(request: Request): Promise<Response> {
    const secret = deps.secret();
    if (!secret) return fail(503, NOT_SET_UP);
    const auth = request.headers.get("authorization");
    const given = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (!sameSecret(given, secret)) return fail(401, "Unauthorized.");
    const store = deps.store();
    if (!store) return fail(503, NOT_SET_UP);
    const result = await refreshSnapshot({ store, fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()) });
    if (result.outcome === "busy") return Response.json({ outcome: "busy" }, { status: 200 });
    if (result.outcome === "store_failed") return Response.json({ outcome: "store_failed" }, { status: 503 });
    const { snapshot } = result;
    const alerts = deps.alerts?.();
    if (alerts && result.outcome === "published" && incompleteWhy(snapshot, new Date(snapshot.fetchedAt)) === null) {
      await alerts.rebuildPagasa(snapshot.generation, pagasaAlerts(snapshot, new Date(snapshot.fetchedAt)), Date.parse(snapshot.fetchedAt)).catch((err) => {
        console.error("alert store failed on the PAGASA rebuild:", err instanceof Error ? err.message : err);
      });
    }
    return Response.json(
      { outcome: result.outcome, complete: snapshot.complete, why: snapshot.why, entries: snapshot.entries.length, products: snapshot.products.length, fetchedAt: snapshot.fetchedAt },
      { status: snapshot.complete ? 200 : 503 },
    );
  };
}

export function snapshotHandlerFromEnv() {
  return makeSnapshotHandler({ secret: () => process.env.WATCH_TICK_SECRET, store: () => advisoryStoreFromEnv(), alerts: () => alertStoreFromEnv() });
}
