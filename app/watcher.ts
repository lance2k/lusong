import type { Trip, TripStorage } from "./trip";

export interface WindowInput {
  start: string;
  end: string;
}

/** What the phone keeps of a watcher. The token is the only way to switch it off, so it never leaves the phone otherwise. */
export interface SavedWatcher {
  token: string;
  window: WindowInput;
  /** The trip it was switched on for: the server keeps this copy until it is switched off. */
  trip: Trip;
  link: string | null;
  linkExpiresAt: string | null;
}

const KEY = "lusong.watcher";

export function watchOnRequest(trip: Trip, window: WindowInput) {
  return { action: "on" as const, from: trip.home, to: trip.work, window };
}

const samePoint = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => a.lat === b.lat && a.lon === b.lon;

export function watchesTrip(watcher: SavedWatcher, trip: Trip | null): boolean {
  return trip !== null && samePoint(watcher.trip.home, trip.home) && samePoint(watcher.trip.work, trip.work);
}

const isPoint = (p: unknown) => {
  const { lat, lon } = (p ?? {}) as Record<string, unknown>;
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon);
};

function parse(raw: string | null | undefined): SavedWatcher | null {
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as SavedWatcher;
    const ok =
      typeof w?.token === "string" &&
      typeof w.window?.start === "string" &&
      typeof w.window?.end === "string" &&
      isPoint(w.trip?.home) &&
      isPoint(w.trip?.work) &&
      (w.link === null || typeof w.link === "string") &&
      (w.linkExpiresAt === null || typeof w.linkExpiresAt === "string");
    return ok ? w : null;
  } catch {
    return null;
  }
}

type StorageEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Like the trip's store (app/trip.ts): read once, kept in step with other tabs, and held in memory if the phone refuses it. */
export function createWatcherStore(storage: TripStorage | null, events: StorageEvents | null) {
  let current: SavedWatcher | null | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const read = () => {
    try {
      return parse(storage?.getItem(KEY));
    } catch {
      return null;
    }
  };
  const fromOtherTab = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key !== null && key !== KEY) return;
    current = read();
    notify();
  };
  return {
    get(): SavedWatcher | null {
      if (current === undefined) current = read();
      return current;
    },
    /** False when the phone wouldn't store it, so it lasts only while the page is open. */
    save(watcher: SavedWatcher): boolean {
      current = watcher;
      notify();
      try {
        storage?.setItem(KEY, JSON.stringify(watcher));
        return storage !== null;
      } catch {
        return false;
      }
    },
    clear() {
      current = null;
      notify();
      try {
        storage?.removeItem(KEY);
      } catch {
        // Nothing to do: the server's copy is already deleted, and a stale token switches nothing on.
      }
    },
    subscribe(listener: () => void): () => void {
      if (listeners.size === 0) events?.addEventListener("storage", fromOtherTab);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) events?.removeEventListener("storage", fromOtherTab);
      };
    },
  };
}

export type WatcherStore = ReturnType<typeof createWatcherStore>;
export type WatchCall = (body: object) => Promise<{ status: number; body: Record<string, unknown> | null }>;

const SWITCH_OFF_TRIES = 3;
const KEEP_IT = "Allow this site to store data (private browsing blocks it) and try again.";

/**
 * The panel's switch-on. The token is the only way to switch the watcher off, so when the phone won't keep it the
 * watcher is switched off again at once, with the token still in memory, and no Telegram link is shown: otherwise
 * closing the page would leave the trip on the server, messaging the rider, with nothing able to delete it.
 */
export async function switchOnWatcher(deps: {
  call: WatchCall;
  store: WatcherStore;
  trip: Trip;
  window: WindowInput;
  retryMs?: number;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { status, body } = await deps.call(watchOnRequest(deps.trip, deps.window));
  if (status !== 200 || typeof body?.watcher !== "string") {
    return { ok: false, message: typeof body?.error === "string" ? body.error : "Lusong couldn't switch the watcher on. Try again in a minute." };
  }
  const saved: SavedWatcher = {
    token: body.watcher,
    window: deps.window,
    trip: deps.trip,
    link: typeof body.link === "string" ? body.link : null,
    linkExpiresAt: typeof body.linkExpiresAt === "string" ? body.linkExpiresAt : null,
  };
  if (deps.store.save(saved)) return { ok: true };

  deps.store.clear();
  for (let i = 0; i < SWITCH_OFF_TRIES; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, deps.retryMs ?? 1_000));
    const off = await deps.call({ action: "off", watcher: saved.token }).catch(() => null);
    if (off?.status === 200) {
      return {
        ok: false,
        message: `This browser wouldn't keep the watcher's key, and without it the watcher couldn't be switched off later, so Lusong switched it off again. ${KEEP_IT}`,
      };
    }
  }
  return {
    ok: false,
    message: `This browser wouldn't keep the watcher's key, and Lusong couldn't switch the watcher off again. With no Telegram chat linked it sends nothing, and Lusong deletes it in 30 days. ${KEEP_IT}`,
  };
}
