import { alertWords, alertStoreFromEnv, type Alert, type AlertStore, type SweepFields } from "./alerts";
import type { Point } from "./answer";
import { ITEM_LIFETIME_MS } from "./sweep-admit";

export const MAX_MARKS = 50;
export const MARK_LIFETIME_HOURS = ITEM_LIFETIME_MS / 3_600_000;

/** One web-sweep report as the map shows it. `words` is the same template sentence the Telegram alert carries. */
export interface ClosureMark {
  id: string;
  words: string;
  sourceUrl: string;
  posted: string;
  expiresAt: string;
  /** Set when the geocoder placed one road or point; a province-wide report has none and is listed, not drawn. */
  spot: { point: Point; radiusM: number } | null;
}

export type ClosuresStatus = "ok" | "paused" | "down";
export interface ClosuresReply {
  status: ClosuresStatus;
  marks: ClosureMark[];
  /** How long a sweep report stays up after its page was posted, so the page can say so without importing the sweep. */
  lifetimeHours: number;
}

function httpsUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The sweep's unexpired reports, newest first, at most MAX_MARKS. PAGASA's advisories are drawn as areas already. */
export function closureMarks(alerts: readonly Alert[], nowMs: number): ClosureMark[] {
  const marks: ClosureMark[] = [];
  for (const a of alerts) {
    if (a.origin !== "sweep" || Date.parse(a.expiresAt) <= nowMs) continue;
    const sourceUrl = httpsUrl(a.sourceUrl);
    if (!sourceUrl) continue;
    const f = a.fields as SweepFields;
    marks.push({
      id: a.id,
      words: alertWords(a, []),
      sourceUrl,
      posted: f.posted,
      expiresAt: a.expiresAt,
      spot: "point" in a.scope ? { point: a.scope.point, radiusM: a.scope.radiusM } : null,
    });
  }
  return marks.sort((x, y) => Date.parse(y.posted) - Date.parse(x.posted)).slice(0, MAX_MARKS);
}

/** GET /api/closures: a read that changes nothing (`list`, never `all`). */
export async function closuresReply(store: AlertStore | null, nowMs: number): Promise<ClosuresReply> {
  const lifetimeHours = MARK_LIFETIME_HOURS;
  if (!store) return { status: "paused", marks: [], lifetimeHours };
  try {
    return { status: "ok", marks: closureMarks(await store.list(nowMs), nowMs), lifetimeHours };
  } catch (err) {
    console.error("closures read failed:", err instanceof Error ? err.message : err);
    return { status: "down", marks: [], lifetimeHours };
  }
}

export const closuresFromEnv = (nowMs = Date.now()) => closuresReply(alertStoreFromEnv(), nowMs);
