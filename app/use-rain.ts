"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bbox } from "../lib/rain";
import { createRainLoader, type RainState } from "./rain-loader";
import { debounce, RAIN_DEBOUNCE_MS } from "./rain-view";

export type { RainState } from "./rain-loader";

/**
 * The rain layer's data. While `enabled` is false nothing is fetched. While it is true, the map's moves (reported by
 * `onView`) are debounced, and `createRainLoader` decides what to fetch and which reply to show.
 */
export function useRain(enabled: boolean): RainState & { onView: (view: Bbox) => void } {
  const [state, setState] = useState<RainState>({ layer: null, loading: false });
  const view = useRef<Bbox | null>(null);
  const schedule = useRef<((view: Bbox) => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const loader = createRainLoader({ fetch: (input, init) => fetch(input, init), onState: setState });
    if (view.current) loader.setView(view.current);
    const debounced = debounce(() => loader.load(), RAIN_DEBOUNCE_MS);
    schedule.current = (next: Bbox) => {
      loader.setView(next);
      debounced.call();
    };
    loader.load();
    return () => {
      debounced.cancel();
      loader.stop();
      schedule.current = null;
    };
  }, [enabled]);

  const onView = useCallback((next: Bbox) => {
    view.current = next;
    schedule.current?.(next);
  }, []);

  return { ...state, loading: enabled && state.loading, layer: enabled ? state.layer : null, onView };
}
