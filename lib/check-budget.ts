/**
 * Each step of one check gets a cut-off measured from the check's start (#44), sized from live draws, and never past
 * the check's deadline. A step past its cut-off ends the way a timeout does: no search findings, no way around, or no
 * pick. None of those is a Go, since the tested rules pick the answer from what did finish.
 */

/** The web search's model call ends this long after the check's start. 14.8–35.0 s live (2026-11-03), 30.1 and 23.8 s (2026-11-04). */
export const SEARCH_STEP_MS = 37_000;
/**
 * A first model turn isn't started with less than this left: the fastest measured live was 2.6 s (2026-11-03; 4.1 and 3.6 s on 2026-11-04), so a
 * turn with less would be cut off by the deadline and still paid for (inferred: the call's input is billed).
 */
export const FIRST_TURN_FASTEST_MS = 2_600;
/**
 * A later turn reads the tool results: 13.8–18.0 s live (3 draws, 2026-11-03), then 12.9, 18.9, 13.9 and 20.1 s
 * (2 draws, 2026-11-04). Not started with less than the fastest.
 */
export const LATER_TURN_FASTEST_MS = 12_800;

export interface CheckBudget {
  /** Epoch ms of the check's first byte. */
  startedAt: number;
  /** Epoch ms by which every step ends. */
  deadline: number;
  /** The web search's model call ends by this. */
  searchBy: number;
  /** A way around isn't started after this. */
  aroundBy: number;
  /** Model turn `turn` (1 first) isn't started after this. */
  pickBy(turn: number): number;
}

export interface StepSizes {
  /** The search's share, from the start. */
  searchMs: number;
  /** The longest one fetchRoute can take. */
  routeWorstMs: number;
  /** Kept for the model's pick after a way around, when the deadline is nearer than the search's share allows. */
  modelRoomMs: number;
  /** A first model turn isn't started with less than this left. */
  firstTurnMs: number;
  /** A later model turn isn't started with less than this left. */
  laterTurnMs: number;
}

/** A full check's sizes, apart from the routing's, which lib/router.ts measures. */
export const STEP_SIZES = { searchMs: SEARCH_STEP_MS, firstTurnMs: FIRST_TURN_FASTEST_MS, laterTurnMs: LATER_TURN_FASTEST_MS };

export function checkBudget(startedAt: number, deadline: number, sizes: StepSizes): CheckBudget {
  return {
    startedAt,
    deadline,
    // A deadline nearer than a full check's still leaves a way around and the pick their room.
    searchBy: Math.min(startedAt + sizes.searchMs, deadline - sizes.routeWorstMs - sizes.modelRoomMs),
    aroundBy: deadline - sizes.routeWorstMs,
    pickBy: (turn) => deadline - (turn <= 1 ? sizes.firstTurnMs : sizes.laterTurnMs),
  };
}
