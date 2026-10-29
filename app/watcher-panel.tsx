"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Trip } from "./trip";
import { createWatcherStore, watchesTrip, watchOnRequest, type SavedWatcher, type WindowInput } from "./watcher";

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

async function callWatch(body: object): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const button = "min-h-11 rounded-full border border-zinc-300 px-4 text-sm font-medium disabled:opacity-60 dark:border-zinc-700";

/** The watcher's switch, under the rider's own trip: on for a PHT window, linked to Telegram, and off. */
export function WatcherPanel({ trip }: { trip: Trip | null }) {
  const watcher = useSyncExternalStore(subscribe, savedWatcher, () => null);
  const [hours, setHours] = useState<WindowInput>({ start: "06:00", end: "08:00" });
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

  if (!watcher && !trip) return null;

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
      const { status: code, body } = await callWatch(watchOnRequest(trip!, hours));
      if (code !== 200 || typeof body?.watcher !== "string") {
        setMessage(typeof body?.error === "string" ? body.error : "Lusong couldn't switch the watcher on. Try again in a minute.");
        return;
      }
      const saved: SavedWatcher = {
        token: body.watcher,
        window: hours,
        trip: trip!,
        link: typeof body.link === "string" ? body.link : null,
        linkExpiresAt: typeof body.linkExpiresAt === "string" ? body.linkExpiresAt : null,
      };
      setStatus("waiting");
      watcherStore().save(saved);
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
    <div className="space-y-2 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="font-medium">Watcher on Telegram</p>
      {!watcher && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            Lusong checks this trip every 10 minutes in your window and messages you when the window opens and whenever the
            answer changes. It checks as if you hadn&apos;t tapped &ldquo;raining here&rdquo;.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              From (PHT)
              <input
                type="time"
                step={600}
                value={hours.start}
                onChange={(e) => setHours({ ...hours, start: e.target.value })}
                className="ml-2 min-h-11 rounded-lg border border-zinc-300 px-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-sm">
              to
              <input
                type="time"
                step={600}
                value={hours.end}
                onChange={(e) => setHours({ ...hours, end: e.target.value })}
                className="ml-2 min-h-11 rounded-lg border border-zinc-300 px-2 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
          <button type="button" disabled={busy} onClick={switchOn} className={button}>
            Switch the watcher on
          </button>
        </>
      )}
      {watcher && (
        <>
          <p>
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
              <p className="text-sm text-zinc-500">A link works once, for 15 minutes.</p>
            </div>
          )}
          {!watchesTrip(watcher, trip) && (
            <p className="text-amber-800 dark:text-amber-300">
              It is watching the trip you had when you switched it on. To watch this one, switch it off and on again.
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => switchOff(watcher)} className={button}>
            Switch the watcher off
          </button>
        </>
      )}
      {message && (
        <p role="status" className="font-medium text-amber-800 dark:text-amber-300">
          {message}
        </p>
      )}
      <p className="text-sm text-zinc-500">
        While it is on, Lusong&apos;s server keeps your trip&apos;s home and work points, your window and your Telegram chat.
        Switching it off deletes them; so does 30 days without opening Lusong.
      </p>
    </div>
  );
}
