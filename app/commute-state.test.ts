import { describe, expect, it } from "vitest";
import { commuteReducer, initialCommuteState, type CommuteState } from "./commute-state";

const answered = { answer: { kind: "wait" } } as never;

function run(...steps: Parameters<typeof commuteReducer>[1][]): CommuteState {
  return steps.reduce(commuteReducer, initialCommuteState);
}

describe("the commute check's page state", () => {
  it("a result names the inputs it was checked for", () => {
    const state = run(
      { type: "change", inputs: { scenario: "flooded" } },
      { type: "start", at: 1 },
      // The change took ticket 1, so the check is ticket 2.
      { type: "answered", ticket: 2, result: answered },
    );
    expect(state.view).toEqual({ step: "done", result: answered, for: { trip: "banilad-itpark", scenario: "flooded", rainingHere: false } });
  });

  it.each([{ trip: "mabolo-cbp" as const }, { scenario: "unclear" as const }, { rainingHere: true }])(
    "changing %o clears the shown answer",
    (change) => {
      const state = run({ type: "start", at: 1 }, { type: "answered", ticket: 1, result: answered }, { type: "change", inputs: change });
      expect(state.view).toEqual({ step: "idle" });
    },
  );

  it("a response that lands after the inputs changed is ignored", () => {
    const state = run({ type: "start", at: 1 }, { type: "change", inputs: { rainingHere: true } }, { type: "answered", ticket: 1, result: answered });
    expect(state.view).toEqual({ step: "idle" });
    expect(state.inputs.rainingHere).toBe(true);
  });

  it("a failure that lands after a newer check started is ignored", () => {
    const state = run({ type: "start", at: 1 }, { type: "change", inputs: { trip: "mabolo-cbp" } }, { type: "start", at: 2 }, { type: "failed", ticket: 1, message: "old" });
    expect(state.view).toMatchObject({ step: "checking", for: { trip: "mabolo-cbp" } });
  });

  it("switching to a trip that doesn't offer the chosen scenario falls back to no reports; one that does keeps it", () => {
    const away = run({ type: "change", inputs: { scenario: "no_way_around" } }, { type: "change", inputs: { trip: "mabolo-cbp" } });
    expect(away.inputs).toMatchObject({ trip: "mabolo-cbp", scenario: "none" });
    const kept = run({ type: "change", inputs: { scenario: "flooded" } }, { type: "change", inputs: { trip: "mabolo-cbp" } });
    expect(kept.inputs.scenario).toBe("flooded");
  });
});
