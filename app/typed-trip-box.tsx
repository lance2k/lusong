"use client";

import { useId, useReducer, useState } from "react";
import type { Place } from "../lib/built-in-places";
import { leavingLine, TRIP_TEXT_LINES, TRIP_TEXT_MAX, TRIP_TEXT_MIN, TRIP_TEXT_PRIVACY } from "../lib/trip-text-words";
import { candidateLine, chosenTrip, initialTypedTrip, tripTextReplyOf, typedTripReducer, type TypedTripAction, type TypedTripState } from "./typed-trip";
import { Button } from "./ui/button";

export const TYPED_TRIP_LABEL = "Or type your trip";
export const TYPED_TRIP_EXAMPLE = "Talamban to IT Park, leaving around 7";
export const USE_THIS_TRIP = "Use this trip";
/** Why Use this trip is still greyed out (S9). */
export const PICK_BOTH_LINE = "Pick one place under From and one under To to use this trip.";

export interface ChosenTrip {
  from: Place;
  to: Place;
  leaveAt: string | null;
}

function Candidates({ end, legend, places, picked, name, send }: {
  end: "from" | "to";
  legend: string;
  places: Place[];
  picked: number | null;
  name: string;
  send: (a: TypedTripAction) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-label text-ink-2">{legend}</legend>
      {places.map((p, i) => (
        <label key={p.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-line bg-surface px-3 py-2 has-checked:border-brand has-checked:bg-brand/10">
          <input type="radio" name={name} checked={picked === i} onChange={() => send({ type: "pick", end, index: i })} className="h-5 w-5 shrink-0 accent-[var(--brand)]" />
          <span>{candidateLine(p)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The typed box as drawn for one state; every sentence is a fixed line or a template over the place search's names. */
export function TypedTripView({ state, text, onText, onSend, send, onUse, onFocusBox }: {
  state: TypedTripState;
  text: string;
  onText: (t: string) => void;
  onSend: () => void;
  send: (a: TypedTripAction) => void;
  onUse: (trip: ChosenTrip) => void;
  onFocusBox?: () => void;
}) {
  const id = useId();
  const { view } = state;
  const chosen = chosenTrip(state);
  const reading = view.step === "reading";
  return (
    <div className="space-y-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <label htmlFor={`${id}-text`} className="block text-label text-ink-2">
          {TYPED_TRIP_LABEL}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`${id}-text`}
            type="text"
            autoComplete="off"
            maxLength={TRIP_TEXT_MAX}
            placeholder={TYPED_TRIP_EXAMPLE}
            value={text}
            onFocus={onFocusBox}
            onChange={(e) => onText(e.target.value)}
            className="min-h-11 w-full min-w-0 rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-2"
          />
          <Button type="submit" look="tonal" disabled={reading || text.trim().length < TRIP_TEXT_MIN} className="shrink-0">
            Read
          </Button>
        </div>
      </form>
      <p className="text-small text-ink-2">{TRIP_TEXT_PRIVACY}</p>
      <div aria-live="polite" className="space-y-3">
        {reading && <p className="text-sm text-ink-2">Reading your trip…</p>}
        {view.step === "failed" && (
          <p role="status" className="font-medium text-warn-ink">
            {TRIP_TEXT_LINES[view.reason]}
          </p>
        )}
        {view.step === "choose" && (
          <div className="space-y-3 rounded-control border border-line bg-ground p-3">
            <p className="font-medium">Pick the places you meant.</p>
            <Candidates end="from" legend="From" places={view.from} picked={view.picked.from} name={`${id}-from`} send={send} />
            <Candidates end="to" legend="To" places={view.to} picked={view.picked.to} name={`${id}-to`} send={send} />
            {view.leaveAt && <p>{leavingLine(view.leaveAt)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!chosen} onClick={() => chosen && onUse(chosen)}>
                {USE_THIS_TRIP}
              </Button>
              <Button look="outline" onClick={() => send({ type: "dismiss" })}>
                Not these
              </Button>
            </div>
            {!chosen && <p className="text-small text-ink-2">{PICK_BOTH_LINE}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** One box above From and To. Nothing is checked or saved until the rider taps Use this trip. */
export function TypedTripBox({ onUse, onFocusBox }: { onUse: (trip: ChosenTrip) => boolean; onFocusBox?: () => void }) {
  const [state, send] = useReducer(typedTripReducer, initialTypedTrip);
  const [text, setText] = useState("");

  async function read() {
    const ticket = state.ticket + 1;
    send({ type: "send" });
    try {
      const res = await fetch("/api/trip-text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      send({ type: "reply", ticket, reply: tripTextReplyOf(await res.json().catch(() => null)) });
    } catch {
      send({ type: "reply", ticket, reply: { status: "failed", reason: "model" } });
    }
  }

  return (
    <TypedTripView
      state={state}
      text={text}
      onText={(t) => {
        setText(t);
        send({ type: "edit" });
      }}
      onSend={read}
      send={send}
      onFocusBox={onFocusBox}
      onUse={(trip) => {
        if (!onUse(trip)) return;
        send({ type: "used" });
        setText("");
      }}
    />
  );
}
