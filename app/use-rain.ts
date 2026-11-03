"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bbox } from "../lib/rain";
import { buildRainLayer, type RainLayer } from "./rain-layer";
import { debounce, RAIN_DEBOUNCE_MS, rainFetchPlan, rainReplyOf, rainUrl } from "./rain-view";

export interface RainState {
  layer: RainLayer | null;
  loading: boolean;
}

/**
 * The rain layer's data. While `enabled` is false nothing is fetched. While it is true, the map's moves (reported by
 * `onView`) are debounced, a request goes out only when the view has left the box last fetched, and a newer request or
 * switching off aborts the one in flight.
 */
export function useRain(enabled: boolean): RainState & { onView: (view: Bbox) => void } {
  const [state, setState] = useState<RainState>({ layer: null, loading: false });
  const view = useRef<Bbox | null>(null);
  const fetched = useRef<Bbox | null>(null);
  const request = useRef<AbortController | null>(null);
  const schedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    fetched.current = null;
    const load = () => {
      const box = rainFetchPlan({ enabled, view: view.current, fetched: fetched.current });
      if (!box) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState((s) => ({ ...s, loading: true }));
      fetch(rainUrl(box), { signal: controller.signal })
        .then((res) => res.json().catch(() => null))
        .then((body) => {
          if (controller.signal.aborted) return;
          const reply = rainReplyOf(body);
          // Only a good reply makes the box reusable; any other is asked again on the next move.
          fetched.current = reply.status === "ok" ? box : null;
          setState({ layer: buildRainLayer(reply), loading: false });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          fetched.current = null;
          setState({ layer: buildRainLayer(rainReplyOf(null)), loading: false });
        });
    };
    const debounced = debounce(load, RAIN_DEBOUNCE_MS);
    schedule.current = debounced.call;
    load();
    return () => {
      debounced.cancel();
      request.current?.abort();
      request.current = null;
      schedule.current = null;
    };
  }, [enabled]);

  const onView = useCallback((next: Bbox) => {
    view.current = next;
    schedule.current?.();
  }, []);

  return { ...state, loading: enabled && state.loading, layer: enabled ? state.layer : null, onView };
}
