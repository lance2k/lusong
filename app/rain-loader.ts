import type { Bbox } from "../lib/rain";
import { buildRainLayer, type RainLayer } from "./rain-layer";
import { rainFetchPlan, rainReplyOf, rainUrl } from "./rain-view";

export interface RainState {
  layer: RainLayer | null;
  loading: boolean;
}

export interface RainLoader {
  /** Records the map's current view; the next `load` plans against it. */
  setView(view: Bbox): void;
  /** Fetches when the view has left the last good box; when it hasn't, drops any request still out for another box. */
  load(): void;
  /** Aborts the request in flight; nothing it returns is shown. */
  stop(): void;
}

/**
 * The rain layer's requests, apart from React so the order of replies can be tested. Only the newest request can set
 * the state, and a view that is back inside the box already shown cancels the request made for somewhere else.
 */
export function createRainLoader(deps: { fetch: typeof fetch; onState: (next: (s: RainState) => RainState) => void }): RainLoader {
  let view: Bbox | null = null;
  let fetched: Bbox | null = null;
  let request: AbortController | null = null;

  function cancel() {
    if (!request) return;
    request.abort();
    request = null;
    deps.onState((s) => ({ ...s, loading: false }));
  }

  return {
    setView(next) {
      view = next;
    },
    load() {
      const box = rainFetchPlan({ enabled: true, view, fetched });
      if (!box) {
        cancel();
        return;
      }
      request?.abort();
      const controller = new AbortController();
      request = controller;
      deps.onState((s) => ({ ...s, loading: true }));
      const settle = (body: unknown) => {
        if (controller.signal.aborted) return;
        request = null;
        const reply = rainReplyOf(body);
        // Only a good reply makes the box reusable; any other is asked again on the next move.
        fetched = reply.status === "ok" ? box : null;
        deps.onState(() => ({ layer: buildRainLayer(reply), loading: false }));
      };
      deps
        .fetch(rainUrl(box), { signal: controller.signal })
        .then((res) => res.json().catch(() => null))
        .then(settle, () => settle(null));
    },
    stop() {
      request?.abort();
      request = null;
    },
  };
}
