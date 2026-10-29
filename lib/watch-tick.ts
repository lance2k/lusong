import type { AnswerKind } from "./answer";
import type { Channel } from "./channel";
import { TITLES, type ScheduledCheck } from "./commute-handler";
import { clockLine, hhmm, inWindow, phtDay } from "./watch-window";
import type { WatchRecord, WatchStore, WatchTrip } from "./watch-store";

export interface TickLimits {
  /** Checks started in one tick; the rest wait for the next, longest-unchecked first. */
  maxPerTick: number;
  /** The whole tick, under the tick route's maxDuration (60 s) with room for the response. */
  budgetMs: number;
  /** No check starts with less than this left of the budget. */
  minCheckMs: number;
  /** A watcher is checked at most once in this long. Under 10 minutes, so a scheduler that fires a little early every
   *  10 minutes doesn't skip every other run. */
  minGapMs: number;
}

export const TICK_LIMITS: TickLimits = { maxPerTick: 20, budgetMs: 45_000, minCheckMs: 15_000, minGapMs: 9 * 60_000 };

export interface TickDeps {
  store: WatchStore;
  channel: Channel;
  /** The real commute check of a stored trip, admitted with no address. */
  check: (trip: WatchTrip, opts: { deadline: number }) => Promise<ScheduledCheck>;
  /** The clock the windows are read on. */
  now: () => Date;
  /** The page a message links to. */
  pageUrl: string;
  limits?: Partial<TickLimits>;
  /** Time spent so far in this tick; real time unless a test sets it. */
  elapsedMs?: () => number;
}

export interface TickSummary {
  ok: boolean;
  /** Linked watchers inside their window and not checked in the last gap. */
  due: number;
  checked: number;
  sent: number;
  /** Checks that gave no answer, and messages Telegram didn't take. */
  failed: number;
  /** Due watchers left for the next tick by the cap or the time budget. */
  deferred: number;
}

/** Built from Lusong's fixed answer words and the window's own times only, never from model text. */
export function watchMessage(m: { kind: AnswerKind; was: AnswerKind | null; at: Date; window: WatchRecord["window"]; pageUrl: string }): string {
  const link = `Open Lusong and check your trip to see why: ${m.pageUrl}`;
  if (m.was === null) return `Lusong is watching your trip until ${hhmm(m.window.endMin)} PHT.\nAt ${clockLine(m.at)}: ${TITLES[m.kind]}\n${link}`;
  return `Your answer changed at ${clockLine(m.at)}: ${TITLES[m.kind]}\nIt was: ${TITLES[m.was]}\n${link}`;
}

/**
 * One run of the scheduler: checks each linked watcher inside its window at most once per gap, and messages it when its
 * window opens (its first answer of the PHT day) and whenever the answer differs from the last one sent. A failed
 * check sends nothing and keeps the last answer. A message counts as sent only once Telegram takes it.
 */
export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const limits = { ...TICK_LIMITS, ...deps.limits };
  const started = Date.now();
  const elapsed = deps.elapsedMs ?? (() => Date.now() - started);
  const deadline = started + limits.budgetMs;
  const at = deps.now();
  const summary: TickSummary = { ok: true, due: 0, checked: 0, sent: 0, failed: 0, deferred: 0 };

  let watchers: WatchRecord[];
  try {
    watchers = await deps.store.list();
  } catch (err) {
    console.error("watch store unreadable:", err instanceof Error ? err.message : err);
    return { ...summary, ok: false };
  }
  const due = watchers
    .filter((w) => w.chatId !== null && inWindow(w.window, at) && at.getTime() - w.checkedAt >= limits.minGapMs)
    .sort((a, b) => a.checkedAt - b.checkedAt);
  summary.due = due.length;

  for (const [i, w] of due.entries()) {
    if (i >= limits.maxPerTick || limits.budgetMs - elapsed() < limits.minCheckMs) {
      summary.deferred = due.length - i;
      break;
    }
    // Earlier checks in this tick take time, so a window open when the tick began may have closed by now.
    const startAt = deps.now();
    if (!inWindow(w.window, startAt)) continue;
    try {
      if (!(await deps.store.claimRun(w.id, w.gen, startAt.getTime(), limits.minGapMs))) continue;
    } catch (err) {
      console.error("watch store failed on claim:", err instanceof Error ? err.message : err);
      summary.failed += 1;
      continue;
    }
    summary.checked += 1;
    const outcome = await runOne(deps, w, { deadline });
    if (outcome === "sent") summary.sent += 1;
    if (outcome === "failed") summary.failed += 1;
  }
  return summary;
}

async function runOne(
  deps: TickDeps,
  w: WatchRecord,
  run: { deadline: number },
): Promise<"sent" | "quiet" | "failed"> {
  let result: ScheduledCheck;
  try {
    result = await deps.check(w.trip, { deadline: run.deadline });
  } catch (err) {
    console.error("watcher check failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
  if (!result.ok) return "failed";
  // The check can outlast the window: what is sent is decided on the clock as it is now.
  const at = deps.now();
  if (!inWindow(w.window, at)) return "quiet";
  const day = phtDay(at);
  const opening = w.lastDay !== day;
  if (!opening && result.kind === w.lastKind) return "quiet";
  try {
    // Switched off (or switched on again) while the check ran: this run speaks for no one.
    if (!(await deps.store.isCurrent(w.id, w.gen))) return "quiet";
    const text = watchMessage({ kind: result.kind, was: opening ? null : w.lastKind, at, window: w.window, pageUrl: deps.pageUrl });
    const sent = await deps.channel.send(w.chatId!, text);
    if (!sent.ok) {
      if (sent.permanent) await deps.store.remove(w.id);
      return "failed";
    }
    await deps.store.commit(w.id, w.gen, { kind: result.kind, day });
    return "sent";
  } catch (err) {
    console.error("watch store failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
