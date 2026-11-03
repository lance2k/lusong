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

export const DELIVERY_LIMITS: DeliveryLimits = { budgetMs: 45_000, maxSends: 40, chatGapMs: 1_000, maxRetries: 3, retryWaitMs: 60_000 };

/** A send starts only with Telegram's timeout and this margin left of the lease, so it always ends inside it. */
const LEASE_MARGIN_MS = 500;
/** No send is started with less than a lease and a store call left of the run. */
const STORE_CALL_MS = 5_000;
/** Watchers whose alert history one store call reads. */
export const HISTORY_BATCH = 25;

/** The promise's value, or "late" once `ms` have passed; a late read is left to settle on its own. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
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
  const deadline = Date.now() + limits.budgetMs;
  const now = deps.now();
  const summary: DeliverySummary = { ok: true, alerts: 0, pagasaHeld: null, watchers: 0, due: 0, sent: 0, rejected: 0, ambiguous: 0, deferred: 0, unread: 0 };

  // PAGASA's alerts are rebuilt from the snapshot, which has already applied every Update's and Cancel's references.
  try {
    const snapshot = deps.advisory ? await readStoredSnapshot(deps.advisory) : null;
    summary.pagasaHeld = deps.advisory ? pagasaUsable(snapshot, now) : "no advisory store";
    if (snapshot && summary.pagasaHeld === null) await deps.alerts.rebuildPagasa(snapshot.generation, pagasaAlerts(snapshot, now), now.getTime());
  } catch (err) {
    summary.pagasaHeld = `store: ${message(err)}`;
  }

  let alerts: Alert[];
  let watchers: WatchRecord[];
  let lines: (Point[] | null)[];
  let cursor: string | null;
  try {
    // Lean safe: a PAGASA alert is sent only while the snapshot behind it is complete and fresh.
    alerts = (await deps.alerts.all(now.getTime())).filter((a) => a.origin !== "pagasa" || summary.pagasaHeld === null);
    watchers = (await deps.watches.list()).filter((w) => w.chatId !== null && !w.stopping);
    cursor = await deps.alerts.cursor().catch(() => null);
    lines = await deps.watches.routes(watchers.map((w) => w.id));
  } catch (err) {
    console.error("alert delivery couldn't read its stores:", message(err));
    return { ...summary, ok: false };
  }
  summary.alerts = alerts.length;
  summary.watchers = watchers.length;
  if (alerts.length === 0 || watchers.length === 0) return summary;
  const lineOf = new Map(watchers.map((w, i) => [w.id, lines[i]]));

  // Each watcher's owed alerts, oldest event first. Histories are read HISTORY_BATCH watchers to a store call, and no
  // batch starts without a read's timeout and a send's room left, so slow reads can't spend the run (S4D-1).
  const queues: Owed[][] = [];
  const ordered = fromCursor(watchers, cursor);
  let readUpTo: string | null = null;
  let readStopped = false;
  for (let start = 0; start < ordered.length; ) {
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
      const room = deadline - Date.now() - SEND_LEASE_MS - STORE_CALL_MS;
      if (room < STORE_CALL_MS) {
        readStopped = true;
        summary.unread = ordered.length - start;
        break;
      }
      let states: (string | null)[][] | "late";
      try {
        states = await withinMs(
          deps.watches.alertStatesMany(batch.map((b) => ({ id: b.watcher.id, members: b.touching.map((t) => memberOf(t.alert)) }))),
          Math.min(room, STORE_CALL_MS),
        );
      } catch (err) {
        console.error("alert delivery couldn't read the watchers' alert history:", message(err));
        summary.ok = false;
        states = "late";
      }
      if (states === "late") {
        readStopped = true;
        summary.unread = ordered.length - start;
        break;
      }
      batch.forEach((b, i) => {
        const owed = b.touching.filter((_, j) => states[i][j] === null || /^retry:/.test(states[i][j]!)).map((t) => ({ watcher: b.watcher, alert: t.alert, areas: t.areas }));
        if (owed.length > 0) queues.push(owed);
      });
    }
    readUpTo = ordered[next - 1].id;
    start = next;
  }
  summary.due = queues.reduce((n, q) => n + q.length, 0);

  // One alert per watcher per round, so a watcher with many alerts doesn't hold up the rest and each chat's sends are
  // spaced out by everyone else's.
  const lastSentAt = new Map<string, number>();
  let attempted = 0;
  let lastWatcher: string | null = null;
  let stoppedEarly = false;
  for (let round = 0; queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      const owed = queue[round];
      if (!owed) continue;
      if (stoppedEarly || attempted >= limits.maxSends || deadline - Date.now() < SEND_LEASE_MS + STORE_CALL_MS) {
        stoppedEarly = true;
        summary.deferred += 1;
        continue;
      }
      const chatId = owed.watcher.chatId!;
      const gap = (lastSentAt.get(chatId) ?? -Infinity) + limits.chatGapMs - deps.now().getTime();
      if (gap > 0) await sleep(gap);
      attempted += 1;
      const outcome = await deliverOne(deps, limits, owed);
      if (outcome === "sent" || outcome === "rejected" || outcome === "ambiguous") lastSentAt.set(chatId, deps.now().getTime());
      if (outcome === "sent") summary.sent += 1;
      else if (outcome === "rejected") summary.rejected += 1;
      else if (outcome === "ambiguous") summary.ambiguous += 1;
      else if (outcome === "deferred") summary.deferred += 1;
      else if (outcome === "failed") summary.ok = false;
      if (round === 0) lastWatcher = owed.watcher.id;
    }
  }
  // Where the next run starts: after the last watcher this one reached, or from the beginning once everyone was.
  // A run that reached no one keeps the cursor it started from.
  const resumeAfter = stoppedEarly ? (lastWatcher ?? cursor) : readStopped ? (readUpTo ?? cursor) : null;
  await deps.alerts.setCursor(resumeAfter).catch((err) => console.error("alert delivery couldn't save its cursor:", message(err)));
  return summary;
}

type Outcome = "sent" | "rejected" | "ambiguous" | "deferred" | "skipped" | "failed";

/** One alert to one watcher, under the watcher's send lease, which a switch-off also takes (S4P-1, S4P-2). */
async function deliverOne(deps: DeliveryDeps, limits: DeliveryLimits, owed: Owed): Promise<Outcome> {
  const { watcher, alert } = owed;
  const member = memberOf(alert);
  const leaseAsked = Date.now();
  let lease: string | null;
  try {
    // S4P-5: a Cancel published since the run began has removed it.
    if (!(await deps.alerts.isActive(alert.id, alert.version, deps.now().getTime()))) return "skipped";
    lease = await deps.watches.takeSendLease(watcher.id, SEND_LEASE_MS);
  } catch (err) {
    console.error("alert delivery store failed before the lease:", message(err));
    return "failed";
  }
  if (!lease) return "deferred";
  try {
    let claim;
    try {
      claim = await deps.watches.claimAlert(watcher.id, watcher.gen, member, deps.now().getTime(), limits.chatGapMs);
    } catch (err) {
      // The claim may have been written: then it is an attempt whose outcome is unknown, never retried.
      console.error("alert delivery store failed on the claim:", message(err));
      return "failed";
    }
    if (!claim.claimed) return claim.why === "soon" ? "deferred" : "skipped";
    if (Date.now() - leaseAsked > SEND_LEASE_MS - SEND_TIMEOUT_MS - LEASE_MARGIN_MS) {
      // Too little of the lease is left for the send to end inside it, where a switch-off waits for it: given back.
      const restore = claim.tries > 0 ? `retry:${claim.tries}:0` : null;
      await deps.watches.settleAlert(watcher.id, member, claim.value, restore).catch(() => {});
      return "deferred";
    }

    const sent = await deps.channel.send(watcher.chatId!, alertMessage(alert, owed.areas));
    try {
      if (sent.ok) {
        await deps.watches.settleAlert(watcher.id, member, claim.value, "sent");
        return "sent";
      }
      if (!sent.rejected) {
        await deps.watches.settleAlert(watcher.id, member, claim.value, "ambiguous");
        return "ambiguous";
      }
      if (sent.permanent) {
        await deps.watches.remove(watcher.id);
        return "rejected";
      }
      const tries = claim.tries + 1;
      const wait = sent.retryAfterS !== undefined ? sent.retryAfterS * 1_000 : limits.retryWaitMs;
      const next = tries <= limits.maxRetries ? `retry:${tries}:${deps.now().getTime() + wait}` : "rejected";
      await deps.watches.settleAlert(watcher.id, member, claim.value, next);
      return "rejected";
    } catch (err) {
      // The `attempt:` stays, which never sends again: after a refusal, one missed message, never a duplicate.
      console.error("alert delivery store failed after sending:", message(err));
      return sent.ok ? "sent" : sent.rejected ? "rejected" : "ambiguous";
    }
  } finally {
    await deps.watches.releaseSendLease(watcher.id, lease).catch((err) => console.error("alert delivery couldn't release the lease:", message(err)));
  }
}
