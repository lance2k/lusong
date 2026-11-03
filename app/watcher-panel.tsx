"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Trip } from "./trip";
import { watchWindowFor } from "./typed-trip";
import { createWatcherStore, switchOnWatcher, watchesTrip, type SavedWatcher, type WatchCall, type WindowInput } from "./watcher";

let store: ReturnType<typeof createWatcherStore> | null = null;

function watcherStore() {
  if (!store) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    store = createWatcherStore(storage, window);
  }
  return store;
}

const subscribe = (listener: () => void) => watcherStore().subscribe(listener);
const savedWatcher = () => watcherStore().get();

type Status = "unknown" | "waiting" | "linked";

const callWatch: WatchCall = async (body) => {
  const res = await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const button = "min-h-11 rounded-chip border border-line bg-surface px-4 text-sm font-medium text-ink disabled:opacity-60";
const timeBox = "ml-2 min-h-11 rounded-control border border-line bg-surface px-2 text-ink";

/** The watcher's switch for the rider's own trip: on for a PHT window, linked to Telegram, and off. With no trip set yet, it only says what the watcher does. */
/** The window the time boxes start with: an hour up to a typed trip's leaving time, or 06:00 to 08:00. */
export function initialHours(leaveAt: string | null): WindowInput {
  return leaveAt ? watchWindowFor(leaveAt) : { start: "06:00", end: "08:00" };
}

export function WatcherPanel({ trip, leaveAt = null }: { trip: Trip | null; leaveAt?: string | null }) {
  const watcher = useSyncExternalStore(subscribe, savedWatcher, () => null);
  const [hours, setHours] = useState<WindowInput>(() => initialHours(leaveAt));
  const [status, setStatus] = useState<Status>("unknown");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const token = watcher?.token ?? null;

  useEffect(() => {
    if (!token) return;
    let live = true;
    const ask = () =>
      callWatch({ action: "status", watcher: token })
        .then(({ status: code, body }) => {
          if (!live) return;
          if (code === 404) watcherStore().clear();
          else if (body?.state === "linked" || body?.state === "waiting") setStatus(body.state);
        })
        .catch(() => {});
    // Coming back from Telegram after following the link shows it as linked without a reload.
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    void ask();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch {
      setMessage("Lusong couldn't be reached. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  const switchOn = () =>
    act(async () => {
      const result = await switchOnWatcher({ call: callWatch, store: watcherStore(), trip: trip!, window: hours });
      if (result.ok) setStatus("waiting");
      else setMessage(result.message);
    });

  const relink = (w: SavedWatcher) =>
    act(async () => {
      const { status: code, body } = await callWatch({ action: "link", watcher: w.token });
      if (code === 404) return watcherStore().clear();
      if (code !== 200 || typeof body?.link !== "string") {
        setMessage(typeof body?.error === "string" ? body.error : "Lusong couldn't make a new link. Try again in a minute.");
        return;
      }
      watcherStore().save({ ...w, link: body.link, linkExpiresAt: typeof body.linkExpiresAt === "string" ? body.linkExpiresAt : null });
    });

  const switchOff = (w: SavedWatcher) =>
    act(async () => {
      const { status: code, body } = await callWatch({ action: "off", watcher: w.token });
      if (code !== 200) {
        setMessage(typeof body?.error === "string" ? body.error : "Lusong couldn't switch the watcher off. Try again; until then it is still on.");
        return;
      }
      setStatus("unknown");
      watcherStore().clear();
    });

  return (
    <div className="space-y-3 text-[15px]">
      {!watcher && (
        <>
          <p className="text-ink-2">
            Lusong checks this trip every 10 minutes in your window and messages you when the window opens and whenever the
            answer changes. It checks as if you hadn&apos;t tapped &ldquo;raining here&rdquo;.
          </p>
          {trip && (
          <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-label text-ink-2">
              From (PHT)
              <input
                type="time"
                step={600}
                value={hours.start}
                onChange={(e) => setHours({ ...hours, start: e.target.value })}
                className={timeBox}
              />
            </label>
            <label className="text-label text-ink-2">
              to
              <input
                type="time"
                step={600}
                value={hours.end}
                onChange={(e) => setHours({ ...hours, end: e.target.value })}
                className={timeBox}
              />
            </label>
          </div>
          <button type="button" disabled={busy} onClick={switchOn} className={button}>
            Switch the watcher on
          </button>
          </>
          )}
        </>
      )}
      {watcher && (
        <>
          <p className="inline-flex items-center gap-2 rounded-chip border border-line bg-surface px-3 py-1 font-medium">
            <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${status === "linked" ? "bg-go" : "bg-unknown"}`} />
            {status === "linked"
              ? `On: Lusong messages you on Telegram between ${watcher.window.start} and ${watcher.window.end} PHT.`
              : `On for ${watcher.window.start} to ${watcher.window.end} PHT, once you link Telegram.`}
          </p>
          {status !== "linked" && (
            <div className="flex flex-wrap items-center gap-3">
              {watcher.link && (
                <a href={watcher.link} target="_blank" rel="noopener noreferrer" className={`${button} inline-flex items-center`}>
                  Link Telegram
                </a>
              )}
              <button type="button" disabled={busy} onClick={() => relink(watcher)} className={button}>
                Get a new Telegram link
              </button>
              <p className="text-sm text-ink-2">A link works once, for 15 minutes.</p>
            </div>
          )}
          {!watchesTrip(watcher, trip) && (
            <p className="text-warn-ink">
              It is watching the trip you had when you switched it on. To watch this one, switch it off and on again.
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => switchOff(watcher)} className={button}>
            Switch the watcher off
          </button>
        </>
      )}
      {message && (
        <p role="status" className="font-medium text-warn-ink">
          {message}
        </p>
      )}
      <p className="text-small text-ink-2">
        While it is on, Lusong&apos;s server keeps your trip&apos;s home and work points, your window and your Telegram chat.
        Switching it off deletes them; so does 30 days without opening Lusong.
      </p>
    </div>
  );
}
