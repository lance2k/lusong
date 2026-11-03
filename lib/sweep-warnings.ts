import { corridorFor, touches } from "./alert-corridor";
import { alertWords, type Alert } from "./alerts";
import type { Point } from "./answer";

/** A sweep item as the page shows it: the fixed template's words and the page it came from. */
export interface SweepWarning {
  id: string;
  text: string;
  link: string;
}

/**
 * The sweep's items near a check's routes, for the page. They are read after the answer is decided and never passed to
 * it: SWEEP_BLOCKING (lib/sweep-admit.ts) is false, so a sweep item never changes an answer, whatever its severity.
 */
export function sweepWarningsAlong(alerts: Alert[] | "late", lines: readonly Point[][]): SweepWarning[] {
  if (alerts === "late") return [];
  const corridors = lines.filter((l) => l.length >= 2).map((l) => corridorFor({ from: l[0], to: l.at(-1)! }, l));
  return alerts
    .filter((a) => a.origin === "sweep" && corridors.some((c) => touches(a, c).touches))
    .sort((a, b) => Date.parse(b.eventAt) - Date.parse(a.eventAt))
    .slice(0, 5)
    .map((a) => ({ id: a.id, text: alertWords(a, []), link: a.sourceUrl }));
}
