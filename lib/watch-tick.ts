import type { AnswerKind } from "./answer";
import { SEND_TIMEOUT_MS, type Channel } from "./channel";
import { COMMUTE_DEADLINE_MS, COMMUTE_TIMING, TITLES, type ScheduledCheck } from "./commute-handler";
import { simplifyLine } from "./alert-corridor";
import { beforeDeadline } from "./deadline";
import { clockLine, hhmm, inWindow, phtDay, windowOpensAt } from "./watch-window";
import type { WatchRecord, WatchStore, WatchTrip } from "./watch-store";

export interface TickLimits {
  /** Checks started in one tick; the rest wait for the next, ahead of every watcher this tick checked (see dueSince). */
  maxPerTick: number;
  /**
   * The whole tick, the last trip's send and store writes included: under the tick route's maxDuration (60 s) with
   * 5 s left for the response. A store call still running at its end is left to settle on its own.
   */
  budgetMs: number;
  /**
   * Kept at the end of the budget for a trip's send and its store writes after its check: the send lease (8 s), inside
   * which the send ends, and 2 s for recording it. No check runs into it.
   */
  afterCheckMs: number;
  /** One trip's check, its settle included, when the tick has that long left: the page's 80 s check and one store call. */
  checkMs: number;
  /** No check starts with less than this left before the checks' end; the trip waits for the next tick, first in line. */
  minCheckMs: number;
  /** A watcher is checked at most once in this long. Under 10 minutes, so a scheduler that fires a little early every
   *  10 minutes doesn't skip every other run. */
  minGapMs: number;
}

export const TICK_LIMITS: TickLimits = {
  maxPerTick: 20,
  budgetMs: 55_000,
  afterCheckMs: 10_000,
  checkMs: COMMUTE_DEADLINE_MS + COMMUTE_TIMING.storeCallMs,
  minCheckMs: 15_000,
  minGapMs: 9 * 60_000,
};

/** A tick holds the watcher's send lease from its last check that the watcher is on until its send is recorded. */
export const SEND_LEASE_MS = 8_000;
/** A send starts only with Telegram's timeout and this margin left of the lease, so it always ends inside it. */
const LEASE_MARGIN_MS = 500;
/** Longer than a lease lives; see switchOff. */
export const SWITCH_OFF_WAIT_MS = 10_000;
const SWITCH_OFF_POLL_MS = 100;

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
  /** Checks that gave no answer, and messages Telegram didn't take or didn't answer for. */
  failed: number;
  /** Due watchers left for the next tick by the cap or the time budget. */
  deferred: number;
}

/**
 * When the watcher last became due: its window's opening today or the end of its gap since its last check, whichever
 * is later. A trip deferred by one tick became due by that tick's start; every trip that tick checked becomes due a
 * gap after it, and every other trip after it too (its window opened later, or its gap hadn't passed), so sorting on
 * this puts each deferred trip first at the next tick.
 */
export function dueSince(w: WatchRecord, at: Date, minGapMs: number): number {
  return Math.max(w.checkedAt + minGapMs, windowOpensAt(w.window, at));
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
 * check sends nothing and keeps the last answer. A message is sent at most once: one Telegram refused can go again at the
 * next check, but one it may have taken (no clear answer) counts as sent.
 */
export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const limits = { ...TICK_LIMITS, ...deps.limits };
  const started = Date.now();
  const elapsed = deps.elapsedMs ?? (() => Date.now() - started);
  const end = started + limits.budgetMs;
  const checksEnd = end - limits.afterCheckMs;
  const at = deps.now();
  const summary: TickSummary = { ok: true, due: 0, checked: 0, sent: 0, failed: 0, deferred: 0 };

  let watchers: WatchRecord[];
  try {
    watchers = await by(deps.store.list(), checksEnd);
  } catch (err) {
    console.error("watch store unreadable:", err instanceof Error ? err.message : err);
    return { ...summary, ok: false };
  }
  const due = watchers
    .filter((w) => w.chatId !== null && inWindow(w.window, at) && at.getTime() - w.checkedAt >= limits.minGapMs)
    .map((w) => ({ w, since: dueSince(w, at, limits.minGapMs) }))
    .sort((a, b) => a.since - b.since || (a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0))
    .map(({ w }) => w);
  summary.due = due.length;

  for (const [i, w] of due.entries()) {
    if (i >= limits.maxPerTick || checksEnd - (started + elapsed()) < limits.minCheckMs) {
      summary.deferred = due.length - i;
      break;
    }
    // Earlier checks in this tick take time, so a window open when the tick began may have closed by now.
    const startAt = deps.now();
    if (!inWindow(w.window, startAt)) continue;
    try {
      if (!(await by(deps.store.claimRun(w.id, w.gen, startAt.getTime(), limits.minGapMs), checksEnd))) continue;
    } catch (err) {
      console.error("watch store failed on claim:", err instanceof Error ? err.message : err);
      summary.failed += 1;
      continue;
    }
    summary.checked += 1;
    // Its own deadline, from when it starts: the full check when the tick has that long, else the checks' end.
    const deadline = Math.min(checksEnd, started + elapsed() + limits.checkMs);
    const outcome = await runOne(deps, w, { deadline, end });
    if (outcome === "sent") summary.sent += 1;
    if (outcome === "failed") summary.failed += 1;
  }
  return summary;
}

async function runOne(
  deps: TickDeps,
  w: WatchRecord,
  run: { deadline: number; end: number },
): Promise<"sent" | "quiet" | "failed"> {
  let result: ScheduledCheck | "late";
  try {
    // A check ends by its deadline; one that runs on until no send could fit is a failed check, left to end on its own.
    result = await beforeDeadline(deps.check(w.trip, { deadline: run.deadline }), run.end - SEND_LEASE_MS);
  } catch (err) {
    console.error("watcher check failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
  if (result === "late" || !result.ok) return "failed";
  try {
    return await sendAnswer(deps, w, result.kind, run.end);
  } finally {
    // The alert delivery's corridor (S4P-6), kept after the send so it never delays one. A failed or late write leaves
    // the last line, or the fallback box, in use.
    if (result.line) {
      const saving = deps.store.saveRoute(w.id, w.gen, simplifyLine(result.line)).catch((err) => {
        console.error("watch store failed saving the route line:", err instanceof Error ? err.message : err);
      });
      await beforeDeadline(saving, run.end);
    }
  }
}

/**
 * Every store call here ends by `end`, the tick's: one still running then is left to settle on its own. Each is safe to
 * land late: a lease lapses in SEND_LEASE_MS, a mark that lands counts as sent (a missed message, never a second one),
 * and a commit or a drop is made for the watcher's generation only.
 */
async function sendAnswer(deps: TickDeps, w: WatchRecord, kind: AnswerKind, end: number): Promise<"sent" | "quiet" | "failed"> {
  // With less than a lease left of the tick, the send couldn't end inside it. Nothing is marked, so the next check sends it.
  if (end - Date.now() < SEND_LEASE_MS) return "failed";
  const leaseAsked = Date.now();
  let lease: string | null | "late";
  try {
    lease = await beforeDeadline(deps.store.takeSendLease(w.id, SEND_LEASE_MS), end);
  } catch (err) {
    console.error("watch store failed on the send lease:", err instanceof Error ? err.message : err);
    return "failed";
  }
  if (lease === "late") return "failed";
  // A switch-off holds the lease while it deletes the watcher.
  if (!lease) return "quiet";
  const held = lease;
  try {
    return await sendUnderLease(deps, w, kind, leaseAsked, end);
  } finally {
    const releasing = deps.store.releaseSendLease(w.id, held).catch((err) => {
      console.error("watch store failed releasing the send lease:", err instanceof Error ? err.message : err);
    });
    await beforeDeadline(releasing, end);
  }
}

/** The call's value; one that answers after `end` is a store failure, left to settle on its own. */
async function by<T>(call: Promise<T>, end: number): Promise<T> {
  const result = await beforeDeadline(call, end);
  if (result === "late") {
    call.catch(() => {});
    throw new Error("no answer before the tick's end");
  }
  return result;
}

async function sendUnderLease(deps: TickDeps, w: WatchRecord, kind: AnswerKind, leaseAsked: number, end: number): Promise<"sent" | "quiet" | "failed"> {
  // The check can outlast the window: what is sent is decided on the clock as it is now.
  const at = deps.now();
  if (!inWindow(w.window, at)) return "quiet";
  const day = phtDay(at);
  // A message whose delivery was uncertain counts as sent.
  const last = w.sending ?? { kind: w.lastKind, day: w.lastDay };
  const opening = last.day !== day;
  if (!opening && kind === last.kind) return "quiet";
  const answer = { kind, day };
  let sendAt: Date;
  try {
    // Recorded before the send, so a send whose outcome is unknown, or whose commit fails, is never sent again.
    // False when switched off (or switched on again) while the check ran: this run speaks for no one.
    if (!(await by(deps.store.markSending(w.id, w.gen, answer), end))) return "quiet";
    // The lease was asked for with at least its own length left of the tick, so a send that ends inside it ends in time.
    if (Date.now() - leaseAsked > SEND_LEASE_MS - SEND_TIMEOUT_MS - LEASE_MARGIN_MS) {
      // Too little of the lease is left for the send to end inside it, where a switch-off waits for it.
      await by(deps.store.dropSending(w.id, w.gen), end);
      return "failed";
    }
    // Recording the answer takes time too, and the window may close during it; the answer was recorded for `day`.
    sendAt = deps.now();
    if (!inWindow(w.window, sendAt) || phtDay(sendAt) !== day) {
      await by(deps.store.dropSending(w.id, w.gen), end);
      return "quiet";
    }
  } catch (err) {
    console.error("watch store failed before sending:", err instanceof Error ? err.message : err);
    return "failed";
  }
  const text = watchMessage({ kind, was: opening ? null : last.kind, at: sendAt, window: w.window, pageUrl: deps.pageUrl });
  const sent = await deps.channel.send(w.chatId!, text);
  try {
    if (sent.ok) {
      await by(deps.store.commit(w.id, w.gen, answer), end);
    } else if (sent.rejected) {
      if (sent.permanent) await by(deps.store.remove(w.id), end);
      else await by(deps.store.dropSending(w.id, w.gen), end);
    }
  } catch (err) {
    // The mark stays, so the answer counts as sent: after a refusal that means one missed message, never a duplicate.
    console.error("watch store failed after sending:", err instanceof Error ? err.message : err);
  }
  return sent.ok ? "sent" : "failed";
}

/**
 * Deletes a watcher once no send of its is under way. It takes the watcher's send lease, which a tick holds from its last
 * check that the watcher is on until its send is done, so a send that check allowed ends before this returns, and no tick
 * can start one while it deletes.
 *
 * The wait is bounded. A lease lives SEND_LEASE_MS, and a tick's send starts only with Telegram's whole timeout left of
 * it, so after SWITCH_OFF_WAIT_MS (longer than a lease) no send allowed before this began can still be running. A lease
 * still held then was taken during the wait, which the 9-minute run claim makes all but impossible; the rider asked for
 * the deletion, so it goes ahead rather than leave the trip on the server.
 */
export async function switchOff(store: WatchStore, id: string, opts: { waitMs?: number; pollMs?: number } = {}): Promise<void> {
  // Marked first (S4P-2): a send claimed after this sees it, so only one already claimed can still be under way.
  await store.markStopping(id);
  const until = Date.now() + (opts.waitMs ?? SWITCH_OFF_WAIT_MS);
  while (!(await store.takeSendLease(id, SEND_LEASE_MS)) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? SWITCH_OFF_POLL_MS));
  }
  // Deletes the lease too.
  await store.remove(id);
}
