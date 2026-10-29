import { scenariosFor, type DemoTripId, type ScenarioId } from "../lib/samples";

export interface CommuteInputs {
  trip: DemoTripId;
  scenario: ScenarioId;
  rainingHere: boolean;
}

export type CommuteView<R> =
  | { step: "idle" }
  | { step: "checking"; startedAt: number; for: CommuteInputs }
  | { step: "done"; result: R; for: CommuteInputs }
  | { step: "failed"; message: string; for: CommuteInputs };

export interface CommuteState<R = unknown> {
  inputs: CommuteInputs;
  /** Bumped by every input change and every check, so only the latest check's response is shown. */
  ticket: number;
  view: CommuteView<R>;
}

export type CommuteAction<R = unknown> =
  | { type: "change"; inputs: Partial<CommuteInputs> }
  | { type: "start"; at: number }
  | { type: "answered"; ticket: number; result: R }
  | { type: "failed"; ticket: number; message: string };

export const initialCommuteState: CommuteState = {
  inputs: { trip: "banilad-itpark", scenario: "none", rainingHere: false },
  ticket: 0,
  view: { step: "idle" },
};

export function commuteReducer<R>(state: CommuteState<R>, action: CommuteAction<R>): CommuteState<R> {
  switch (action.type) {
    case "change": {
      const inputs = { ...state.inputs, ...action.inputs };
      if (!scenariosFor(inputs.trip).some((s) => s.id === inputs.scenario)) inputs.scenario = "none";
      return { inputs, ticket: state.ticket + 1, view: { step: "idle" } };
    }
    case "start":
      return { ...state, ticket: state.ticket + 1, view: { step: "checking", startedAt: action.at, for: state.inputs } };
    case "answered":
    case "failed": {
      if (action.ticket !== state.ticket || state.view.step !== "checking") return state;
      const checkedFor = state.view.for;
      return {
        ...state,
        view:
          action.type === "answered"
            ? { step: "done", result: action.result, for: checkedFor }
            : { step: "failed", message: action.message, for: checkedFor },
      };
    }
  }
}
