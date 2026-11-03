import { corridorFor, touches } from "./alert-corridor";
import { alertMessage, memberOf, pagasaAlerts, pagasaUsable, type Alert, type AlertStore } from "./alerts";
import { readStoredSnapshot, type AdvisoryStore } from "./advisory-snapshot";
import type { Point } from "./answer";
import { SEND_TIMEOUT_MS, type Channel } from "./channel";
import { SEND_LEASE_MS } from "./watch-tick";
import type { WatchRecord, WatchStore } from "./watch-store";

/**
 * Alert delivery (plan S4a, dispositions S4P-1, S4P-2, S4P-5, S4P-6, S4P-8, S4P-9): every linked watcher whose corridor
 * an alert touches gets one message for each alert version, whatever its window, and every linked watcher gets the
 * nationwide ones. It runs from its own route (POST /api/alerts/deliver), never inside the watch tick.
 */

export interface DeliveryLimits {
  /** The whole run, under the route's maxDuration (60 s) with room for the response. */
  budgetMs: number;
  maxSends: number;
  /** One chat gets at most one alert in this long (core.telegram.org/bots/faq: about one message a second per chat). */
  chatGapMs: number;
  /** Retries after a confirmed rejection; past them the alert is given up for that watcher. */
  maxRetries: number;
  /** A rejection that gives no retry_after waits this long. */
  retryWaitMs: number;
}

export const DELIVERY_LIMITS: DeliveryLimits = { budgetMs: 55_000, maxSends: 40, chatGapMs: 1_000, maxRetries: 3, retryWaitMs: 60_000 };

/** A send starts only with Telegram's timeout and this margin left of the lease, so it always ends inside it. */
const LEASE_MARGIN_MS = 500;
/** Every store call's bound (S4D-8): no call is waited on for longer, nor past the run's working time. */
const STORE_CALL_MS = 5_000;
/** Kept at the end of the run for what must still be written: a claim given back, the lease, the cursor. */
export const CLEANUP_RESERVE_MS = 3 * STORE_CALL_MS;
/** No send is started with less than a lease and a store call left of the working time. */
const SEND_START_MS = SEND_LEASE_MS + STORE_CALL_MS;
/** Watchers whose alert history one store call reads. */
export const HISTORY_BATCH = 25;

const LATE = Symbol("late");
type Late = typeof LATE;

/**
 * The call's value, or LATE once `ms` have passed; a call with no time at all isn't started. A late call is left to
 * settle on its own, so whatever it may still write has to be safe to find later.
 */
async function within<T>(ms: number, call: () => Promise<T>): Promise<T | Late> {
  if (ms <= 0) return LATE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Late>((resolve) => (timer = setTimeout(() => resolve(LATE), ms)));
  return Promise.race([call(), late]).finally(() => clearTimeout(timer));
}

/** One run's clock: working store calls end by `workEnd`; cleanup (claims given back, lease, cursor) by `end`. */
interface RunClock {
  store<T>(call: () => Promise<T>): Promise<T | Late>;
  cleanup<T>(call: () => Promise<T>): Promise<T | Late>;
  workLeft(): number;
}

function runClock(budgetMs: number): RunClock {
  const end = Date.now() + budgetMs;
  const workEnd = end - CLEANUP_RESERVE_MS;
  return {
    store: (call) => within(Math.min(STORE_CALL_MS, workEnd - Date.now()), call),
    cleanup: (call) => within(Math.min(STORE_CALL_MS, end - Date.now()), call),
    workLeft: () => workEnd - Date.now(),
  };
}

export interface DeliveryDeps {
  watches: WatchStore;
  alerts: AlertStore;
  /** PAGASA's snapshot; null leaves the stored PAGASA alerts as they are and sends none of them. */
  advisory: AdvisoryStore | null;
  channel: Channel;
  now: () => Date;
  limits?: Partial<DeliveryLimits>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliverySummary {
  ok: boolean;
  alerts: number;
  /** Why PAGASA's alerts weren't sent this run, or null when they were usable. */
  pagasaHeld: string | null;
  watchers: number;
  /** Alert messages owed at the start of the run. */
  due: number;
  sent: number;
  /** Telegram refused (a retry is booked unless the retries are spent). */
  rejected: number;
  /** No clear answer from Telegram: counted as delivered and never sent again. */
  ambiguous: number;
  /** Left for the next run: the send cap, the time budget, a retry not yet due, or the chat's one-second gap. */
  deferred: number;
  /** Watchers whose alert history the run had no time to read: the next run starts with them. */
  unread: number;
}

interface Owed {
  watcher: WatchRecord;
  alert: Alert;
  areas: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The run's watchers in id order, starting after the one the last run stopped at. */
function fromCursor(watchers: WatchRecord[], cursor: string | null): WatchRecord[] {
  const sorted = [...watchers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (cursor === null) return sorted;
  const at = sorted.findIndex((w) => w.id > cursor);
  return at <= 0 ? sorted : [...sorted.slice(at), ...sorted.slice(0, at)];
}

export async function runDelivery(deps: DeliveryDeps): Promise<DeliverySummary> {
  const limits = { ...DELIVERY_LIMITS, ...deps.limits };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = runClock(limits.budgetMs);
  const now = deps.now();
  const summary: DeliverySummary = { ok: true, alerts: 0, pagasaHeld: null, watchers: 0, due: 0, sent: 0, rejected: 0, ambiguous: 0, deferred: 0, unread: 0 };
  const read = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    const value = await clock.store(call);
    if (value === LATE) throw new Error(`${what}: out of time`);
    return value;
  };

  // PAGASA's alerts are rebuilt from the snapshot, which has already applied every Update's and Cancel's references.
  try {
    const advisory = deps.advisory;
    const snapshot = advisory ? await read("snapshot", () => readStoredSnapshot(advisory)) : null;
    summary.pagasaHeld = advisory ? pagasaUsable(snapshot, now) : "no advisory store";
    if (snapshot && summary.pagasaHeld === null) await read("rebuild", () => deps.alerts.rebuildPagasa(snapshot.generation, pagasaAlerts(snapshot, now), now.getTime()));
  } catch (err) {
    summary.pagasaHeld = `store: ${message(err)}`;
  }

  let alerts: Alert[];
  let watchers: WatchRecord[];
  let lines: (Point[] | null)[];
  let cursor: string | null;
  try {
    // Lean safe: a PAGASA alert is sent only while the snapshot behind it is complete and fresh.
    alerts = (await read("alerts", () => deps.alerts.all(now.getTime()))).filter((a) => a.origin !== "pagasa" || summary.pagasaHeld === null);
    watchers = (await read("watchers", () => deps.watches.list())).filter((w) => w.chatId !== null && !w.stopping);
    cursor = await read("cursor", () => deps.alerts.cursor()).catch(() => null);
    lines = await read("routes", () => deps.watches.routes(watchers.map((w) => w.id)));
  } catch (err) {
    console.error("alert delivery couldn't read its stores:", message(err));
    return { ...summary, ok: false };
  }
  summary.alerts = alerts.length;
  summary.watchers = watchers.length;
  if (alerts.length === 0 || watchers.length === 0) return summary;
  const lineOf = new Map(watchers.map((w, i) => [w.id, lines[i]]));

  // HISTORY_BATCH watchers at a time: their histories in one store call, then their sends, then the next batch
  // (S4D-1, S4D-8). Within a batch, one alert per watcher per round, so each chat's sends are spaced by the others'.
  const ordered = fromCursor(watchers, cursor);
  const lastSentAt = new Map<string, number>();
  let attempted = 0;
  let reached: string | null = null;
  let stopped = false;
  for (let start = 0; start < ordered.length && !stopped; ) {
    const batch: { watcher: WatchRecord; touching: { alert: Alert; areas: string[] }[] }[] = [];
    let next = start;
    for (; next < ordered.length && batch.length < HISTORY_BATCH; next++) {
      const watcher = ordered[next];
      const corridor = corridorFor(watcher.trip, lineOf.get(watcher.id) ?? null);
      const touching = alerts
        .map((alert) => ({ alert, ...touches(alert, corridor) }))
        .filter((t) => t.touches)
        .sort((a, b) => Date.parse(a.alert.eventAt) - Date.parse(b.alert.eventAt));
      if (touching.length > 0) batch.push({ watcher, touching });
    }
    if (batch.length > 0) {
      // A batch is read only when its sends could start after the read.
      let states: (string | null)[][] | Late = LATE;
      if (clock.workLeft() >= STORE_CALL_MS + SEND_START_MS) {
        try {
          states = await clock.store(() => deps.watches.alertStatesMany(batch.map((b) => ({ id: b.watcher.id, members: b.touching.map((t) => memberOf(t.alert)) }))));
        } catch (err) {
          console.error("alert delivery couldn't read the watchers' alert history:", message(err));
          summary.ok = false;
        }
      }
      if (states === LATE) {
        summary.unread = ordered.length - start;
        stopped = true;
        break;
      }
      const read = states;
      const queues = batch
        .map((b, i) =>
          b.touching
            .map((t, j) => ({ watcher: b.watcher, alert: t.alert, areas: t.areas, prior: read[i][j] }))
            .filter((o) => o.prior === null || /^retry:/.test(o.prior)),
        )
        .filter((q) => q.length > 0);
      summary.due += queues.reduce((n, q) => n + q.length, 0);
      for (let round = 0; queues.some((q) => q.length > round); round++) {
        for (const queue of queues) {
          const owed = queue[round];
          if (!owed) continue;
          if (stopped || attempted >= limits.maxSends || clock.workLeft() < SEND_START_MS) {
            stopped = true;
            summary.deferred += 1;
            continue;
          }
          const chatId = owed.watcher.chatId!;
          const gap = (lastSentAt.get(chatId) ?? -Infinity) + limits.chatGapMs - deps.now().getTime();
          if (gap > 0) await sleep(gap);
          attempted += 1;
          const outcome = await deliverOne(deps, limits, clock, owed);
          if (outcome === "sent" || outcome === "rejected" || outcome === "ambiguous") lastSentAt.set(chatId, deps.now().getTime());
          if (outcome === "sent") summary.sent += 1;
          else if (outcome === "rejected") summary.rejected += 1;
          else if (outcome === "ambiguous") summary.ambiguous += 1;
          else if (outcome === "deferred") summary.deferred += 1;
          else if (outcome === "failed") summary.ok = false;
          if (round === 0) reached = owed.watcher.id;
        }
      }
    }
    if (!stopped) reached = ordered[next - 1].id;
    else summary.unread = ordered.length - next;
    start = next;
  }
  // Where the next run starts: after the last watcher this one reached, or from the beginning once everyone was.
  // A run that reached no one keeps the cursor it started from.
  const resumeAfter = stopped ? (reached ?? cursor) : null;
  const saved = await clock.cleanup(() => deps.alerts.setCursor(resumeAfter)).catch((err) => console.error("alert delivery couldn't save its cursor:", message(err)));
  if (saved === LATE) console.error("alert delivery's cursor write was still pending at the end of the run");
  return summary;
}

type Outcome = "sent" | "rejected" | "ambiguous" | "deferred" | "skipped" | "failed";

/**
 * One alert to one watcher, under the watcher's send lease, which a switch-off also takes (S4P-1, S4P-2). A claim that
 * isn't followed by a send is given back to the state it was read in, so the next run tries it again (S4D-8).
 */
async function deliverOne(deps: DeliveryDeps, limits: DeliveryLimits, clock: RunClock, owed: Owed & { prior: string | null }): Promise<Outcome> {
  const { watcher, alert } = owed;
  const member = memberOf(alert);
  let lease: string | null | Late;
  let leaseAsked: number;
  try {
    // S4P-5: a Cancel published since the run began has removed it.
    const active = await clock.store(() => deps.alerts.isActive(alert.id, alert.version, deps.now().getTime()));
    if (active === LATE) return "deferred";
    if (!active) return "skipped";
    leaseAsked = Date.now();
    lease = await clock.store(() => deps.watches.takeSendLease(watcher.id, SEND_LEASE_MS));
  } catch (err) {
    console.error("alert delivery store failed before the lease:", message(err));
    return "failed";
  }
  // A lease that lands late is never released here; it lapses after SEND_LEASE_MS.
  if (lease === LATE || !lease) return "deferred";
  const held = lease;
  const claimAt = deps.now().getTime();
  const attempt = `attempt:${claimAt}`;
  const giveBack = async () => {
    const back = await clock.cleanup(() => deps.watches.settleAlert(watcher.id, member, attempt, owed.prior)).catch(() => LATE);
    if (back === LATE) console.error("alert delivery couldn't give back an unsent claim in time");
  };
  try {
    let claim;
    try {
      claim = await clock.store(() => deps.watches.claimAlert(watcher.id, watcher.gen, member, claimAt, limits.chatGapMs));
    } catch (err) {
      // The claim may have been written: then it is an attempt whose outcome is unknown, never retried.
      console.error("alert delivery store failed on the claim:", message(err));
      return "failed";
    }
    if (claim === LATE) {
      // Not sent: the claim, if it landed, is given back.
      await giveBack();
      return "deferred";
    }
    if (!claim.claimed) return claim.why === "soon" ? "deferred" : "skipped";
    if (Date.now() - leaseAsked > SEND_LEASE_MS - SEND_TIMEOUT_MS - LEASE_MARGIN_MS) {
      // Too little of the lease is left for the send to end inside it, where a switch-off waits for it: given back.
      await giveBack();
      return "deferred";
    }

    const sent = await deps.channel.send(watcher.chatId!, alertMessage(alert, owed.areas));
    // After a send the attempt stays unless its outcome is written: one missed message, never a duplicate.
    const settle = async (next: string) => {
      if ((await clock.cleanup(() => deps.watches.settleAlert(watcher.id, member, attempt, next))) === LATE) console.error("alert delivery's state write after a send was late; the attempt stays");
    };
    try {
      if (sent.ok) {
        await settle("sent");
        return "sent";
      }
      if (!sent.rejected) {
        await settle("ambiguous");
        return "ambiguous";
      }
      if (sent.permanent) {
        await clock.cleanup(() => deps.watches.remove(watcher.id));
        return "rejected";
      }
      const tries = claim.tries + 1;
      const wait = sent.retryAfterS !== undefined ? sent.retryAfterS * 1_000 : limits.retryWaitMs;
      await settle(tries <= limits.maxRetries ? `retry:${tries}:${deps.now().getTime() + wait}` : "rejected");
      return "rejected";
    } catch (err) {
      console.error("alert delivery store failed after sending:", message(err));
      return sent.ok ? "sent" : sent.rejected ? "rejected" : "ambiguous";
    }
  } finally {
    await clock
      .cleanup(() => deps.watches.releaseSendLease(watcher.id, held))
      .catch((err) => console.error("alert delivery couldn't release the lease:", message(err)));
  }
}
