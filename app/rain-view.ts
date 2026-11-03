import { MAX_BOX_DEG, RAIN_CREDIT, type Bbox, type RainReply } from "../lib/rain";

export const RAIN_DEBOUNCE_MS = 800;
/** How far past the view a request reaches, as a share of the view's size, so small pans stay inside the fetched box. */
export const RAIN_REACH = 0.25;

export function containsBox(outer: Bbox, inner: Bbox): boolean {
  return outer.south <= inner.south && outer.west <= inner.west && outer.north >= inner.north && outer.east >= inner.east;
}

const floor2 = (v: number) => Math.floor(v * 100) / 100;
const ceil2 = (v: number) => Math.ceil(v * 100) / 100;

/**
 * The box to ask the server for: the view with a margin, so a small pan is covered. A view that already needs the
 * server's 3 degree limit gets no margin (a margin would only push it over), and one wider than that is sent as it is
 * for the server to refuse. Rounded outward to 0.01 degrees, so the box always contains the view.
 */
export function requestBox(view: Bbox): Bbox {
  const height = view.north - view.south;
  const width = view.east - view.west;
  const reach = (span: number) => span * RAIN_REACH;
  const padded = height + 2 * reach(height) <= MAX_BOX_DEG && width + 2 * reach(width) <= MAX_BOX_DEG;
  const [dy, dx] = padded ? [reach(height), reach(width)] : [0, 0];
  return { south: floor2(view.south - dy), west: floor2(view.west - dx), north: ceil2(view.north + dy), east: ceil2(view.east + dx) };
}

/** A new request is needed only when the view has left the box last fetched successfully. */
export function needsRainFetch(view: Bbox, fetched: Bbox | null): boolean {
  return fetched === null || !containsBox(fetched, view);
}

/** The box to request now, or null when nothing should go out: the layer is off, no view yet, or the view is still covered. */
export function rainFetchPlan(input: { enabled: boolean; view: Bbox | null; fetched: Bbox | null }): Bbox | null {
  if (!input.enabled || !input.view || !needsRainFetch(input.view, input.fetched)) return null;
  return requestBox(input.view);
}

export function rainUrl(box: Bbox): string {
  return `/api/rain?bbox=${[box.south, box.west, box.north, box.east].join(",")}`;
}

const STATUSES = new Set(["ok", "paused", "refused", "down"]);

/** What came back, trusted no further than its shape: anything else reads as the layer being down. */
export function rainReplyOf(body: unknown): RainReply {
  const b = body as Partial<RainReply> | null;
  const usable =
    b !== null && typeof b === "object" && typeof b.status === "string" && STATUSES.has(b.status) && Array.isArray(b.points);
  if (!usable) return { status: "down", points: [], modelTime: null, credit: RAIN_CREDIT };
  const points = b.points!.filter(
    (p) => typeof p?.lat === "number" && typeof p.lon === "number" && typeof p.mm === "number" && Number.isFinite(p.mm),
  );
  return { ...(b as RainReply), points, modelTime: typeof b.modelTime === "string" ? b.modelTime : null };
}

export interface Debounced {
  call: () => void;
  cancel: () => void;
}

/** Runs `fn` once `ms` after the last call. The timer functions are injected so a test needs no real wait. */
export function debounce(
  fn: () => void,
  ms: number,
  timers: { set: (f: () => void, ms: number) => unknown; clear: (id: unknown) => void } = {
    set: (f, delay) => setTimeout(f, delay),
    clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  },
): Debounced {
  let id: unknown = null;
  const cancel = () => {
    if (id !== null) timers.clear(id);
    id = null;
  };
  return {
    call: () => {
      cancel();
      id = timers.set(() => {
        id = null;
        fn();
      }, ms);
    },
    cancel,
  };
}
