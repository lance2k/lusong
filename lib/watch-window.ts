/** Manila keeps UTC+8 all year, with no daylight saving. */
const PHT_OFFSET_MS = 8 * 60 * 60_000;

/** Minutes after midnight PHT: the window is [startMin, endMin), within one PHT day. */
export interface WatchWindow {
  startMin: number;
  endMin: number;
}

/** A longer window would spend more of the shared routing server on one rider than a morning or evening ride needs. */
export const MAX_WINDOW_MIN = 4 * 60;

function minutesOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** `{ start: "06:00", end: "08:00" }` as the page's time inputs send it; the window can't cross midnight. */
export function parseWindow(value: unknown): WatchWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const { start, end } = value as Record<string, unknown>;
  const startMin = minutesOf(start);
  const endMin = minutesOf(end);
  if (startMin === null || endMin === null || endMin <= startMin || endMin - startMin > MAX_WINDOW_MIN) return null;
  return { startMin, endMin };
}

function phtParts(now: Date): { day: string; minute: number } {
  const shifted = new Date(now.getTime() + PHT_OFFSET_MS);
  return { day: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export function phtDay(now: Date): string {
  return phtParts(now).day;
}

export function inWindow(window: WatchWindow, now: Date): boolean {
  const { minute } = phtParts(now);
  return minute >= window.startMin && minute < window.endMin;
}

export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function clockLine(now: Date): string {
  return `${hhmm(phtParts(now).minute)} PHT`;
}
