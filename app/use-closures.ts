"use client";

import { useEffect, useState } from "react";
import type { ClosureMark, ClosuresReply } from "../lib/closure-marks";
import { CLOSURES_REFRESH_MS, closuresReplyOf, liveMarks } from "./closures-layer";

const CLOCK_MS = 60_000;

export interface ClosuresState {
  reply: ClosuresReply | null;
  loading: boolean;
  /** The marks still live now: a mark leaves on its expiry even while refreshes fail (S3cP-5). */
  marks: ClosureMark[];
  now: number;
}

/**
 * The web sweep's reports for the map. Fetched when switched on, every ten minutes while the page is showing, and
 * again when it comes back into view; nothing while switched off.
 */
export function useClosures(enabled: boolean): ClosuresState {
  const [reply, setReply] = useState<ClosuresReply | null>(null);
  const [loading, setLoading] = useState(false);
  // 0 until the first reply: the page is prerendered, and no mark shows before a reply sets the clock.
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let request: AbortController | null = null;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      setLoading(true);
      fetch("/api/closures", { signal: controller.signal })
        .then((res) => res.json().catch(() => null))
        .then(
          (body) => body,
          () => null,
        )
        .then((body) => {
          if (controller.signal.aborted) return;
          setReply(closuresReplyOf(body));
          setLoading(false);
          setNow(Date.now());
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const refresh = window.setInterval(load, CLOSURES_REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      request?.abort();
      window.clearInterval(refresh);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
      setLoading(false);
    };
  }, [enabled]);

  const shown = enabled ? reply : null;
  return { reply: shown, loading: enabled && loading, marks: shown ? liveMarks(shown.marks, now) : [], now };
}
