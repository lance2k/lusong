import { describe, expect, it } from "vitest";
import { checkBudget, FIRST_TURN_FASTEST_MS, LATER_TURN_FASTEST_MS, SEARCH_STEP_MS, STEP_SIZES } from "./check-budget";
import { COMMUTE_DEADLINE_MS, COMMUTE_TIMING, MODEL_ROOM_MS } from "./commute-handler";
import { ROUTE_WORST_MS } from "./router";

const START = 1_800_000_000_000;
const SIZES = { ...STEP_SIZES, routeWorstMs: ROUTE_WORST_MS, modelRoomMs: MODEL_ROOM_MS };

describe("each step's cut-off, from the check's start (#44)", () => {
  it("gives a full check's search 37 s from the start: past the slowest measured (35.0 s), and where the 80 s split put it", () => {
    const budget = checkBudget(START, START + COMMUTE_DEADLINE_MS, SIZES);
    expect(budget.searchBy - START).toBe(SEARCH_STEP_MS);
    expect(SEARCH_STEP_MS).toBeGreaterThan(35_000);
    expect(SEARCH_STEP_MS).toBe(COMMUTE_DEADLINE_MS - ROUTE_WORST_MS - MODEL_ROOM_MS);
    expect(COMMUTE_TIMING.steps).toEqual({ searchMs: SEARCH_STEP_MS, firstTurnMs: FIRST_TURN_FASTEST_MS, laterTurnMs: LATER_TURN_FASTEST_MS });
  });

  it("with a nearer deadline, ends the search early enough to leave a way around and the pick their room", () => {
    const deadline = START + 60_000;
    const budget = checkBudget(START, deadline, SIZES);
    expect(budget.searchBy).toBe(deadline - ROUTE_WORST_MS - MODEL_ROOM_MS);
    expect(budget.searchBy).toBeLessThan(START + SEARCH_STEP_MS);
  });

  it("starts no way around with less than the longest route left", () => {
    const deadline = START + COMMUTE_DEADLINE_MS;
    expect(checkBudget(START, deadline, SIZES).aroundBy).toBe(deadline - ROUTE_WORST_MS);
  });

  it("starts no model turn with less left than its fastest measured turn", () => {
    const deadline = START + COMMUTE_DEADLINE_MS;
    const budget = checkBudget(START, deadline, SIZES);
    expect(budget.pickBy(1)).toBe(deadline - FIRST_TURN_FASTEST_MS);
    expect(budget.pickBy(2)).toBe(deadline - LATER_TURN_FASTEST_MS);
    expect(budget.pickBy(3)).toBe(deadline - LATER_TURN_FASTEST_MS);
  });
});
