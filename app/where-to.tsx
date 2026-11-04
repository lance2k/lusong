"use client";

import { useEffect, useState } from "react";
import { DEMO_TRIPS, SCENARIOS, scenariosFor, type DemoTripId } from "../lib/samples";
import { OWN_TRIP, type CommuteInputs } from "./commute-state";
import { SAMPLES_LINE } from "./credits";
import { leavingLine } from "../lib/trip-text-words";
import { OwnTripPanel, type OwnTrip } from "./own-trip";
import { TypedTripBox, type ChosenTrip } from "./typed-trip-box";
import { Button } from "./ui/button";
import { Chip, ChipGroup } from "./ui/chip";
import { IconRain, IconTick } from "./ui/icons";

const TRIP_IDS = Object.keys(DEMO_TRIPS) as DemoTripId[];

/** The saved trip, home to work: the one the watcher watches. There is no reverse. */
export const MY_TRIP_LABEL = "My trip";

/** The check button's id: "Use this trip" moves focus to it, the next step once the trip is filled in (#49). */
export const CHECK_BUTTON_ID = "check-trip";

/** `value` is null while the page hasn't yet read whether this phone has a saved trip: no chip is pressed then. */
export function TripChips({ value, onChange }: { value: CommuteInputs["trip"] | null; onChange: (id: CommuteInputs["trip"]) => void }) {
  return (
    <ChipGroup legend="Trip">
      <Chip pressed={value === OWN_TRIP} onClick={() => onChange(OWN_TRIP)}>
        {MY_TRIP_LABEL}
      </Chip>
      {TRIP_IDS.map((id) => (
        <Chip key={id} pressed={value === id} onClick={() => onChange(id)}>
          {DEMO_TRIPS[id].label}
        </Chip>
      ))}
    </ChipGroup>
  );
}

/** `labels` are the own trip's names as its boxes show them; they last only while the page is open, so without both the line says "Your trip". */
export function inputWords(inputs: CommuteInputs, labels?: { from: string | null; to: string | null }): string {
  const rain = inputs.rainingHere ? "raining here" : "no rain tap";
  if (inputs.trip === OWN_TRIP) return labels?.from && labels.to ? `Your trip: ${labels.from} → ${labels.to} · ${rain}` : `Your trip · ${rain}`;
  const scenario = SCENARIOS.find((s) => s.id === inputs.scenario)!.label;
  return `Demo: ${DEMO_TRIPS[inputs.trip].label} · ${scenario} · ${rain}`;
}

export interface WhereToProps {
  headingId: string;
  inputs: CommuteInputs;
  change: (inputs: Partial<CommuteInputs>) => void;
  own: OwnTrip;
  checking: boolean;
  canCheck: boolean;
  onCheck: () => void;
  /** A From or To box got focus. */
  onFocusBox: () => void;
  focusSignal: number;
  onPickMyTrip: () => void;
  onOpenWatcher: () => void;
  /** Collapsed to one line while a check runs or its answer shows; the rider can open it again. */
  collapsed: boolean;
  onExpand: () => void;
  summary: string | null;
  /** Fills From and To from a typed trip the rider confirmed; false when it changed nothing. */
  onUseTypedTrip: (trip: ChosenTrip) => boolean;
  /** The typed trip's leaving time, while the trip is still the one it came with. */
  leaveAt: string | null;
  /**
   * False until the page has read whether this phone has a saved trip, which the server can't know. Until then no trip
   * is shown as chosen, so a phone with a saved trip never opens on the demo (#43). Defaults to true.
   */
  tripKnown?: boolean;
}

export const LEAVE_AT_WATCHER_LINE = "If you switch on the watcher, its window starts an hour before.";

export function WhereTo(p: WhereToProps) {
  const { inputs, own } = p;
  const known = p.tripKnown ?? true;
  const ownTrip = inputs.trip === OWN_TRIP;
  // "Use this trip" unmounts with the typed box's choices; focus goes on to the check, not back to the text box,
  // which would open the phone keyboard (#49). It runs after the render that enabled the button.
  const [focusCheck, setFocusCheck] = useState(0);
  useEffect(() => {
    if (focusCheck > 0) document.getElementById(CHECK_BUTTON_ID)?.focus();
  }, [focusCheck]);
  return (
    <section aria-labelledby={p.headingId} className="space-y-4">
      <h2 id={p.headingId} tabIndex={-1} className="text-title outline-none">
        Where to?
      </h2>
      {p.collapsed && p.summary ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-[15px] text-ink-2">{p.summary}</p>
          <Button look="tonal" onClick={p.onExpand} aria-expanded={false}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <TripChips
            value={known ? inputs.trip : null}
            onChange={(id) => {
              p.change({ trip: id });
              if (id === OWN_TRIP) p.onPickMyTrip();
            }}
          />
          {known && ownTrip && (
            <>
              <TypedTripBox
                onUse={(trip) => {
                  const used = p.onUseTypedTrip(trip);
                  if (used) setFocusCheck((n) => n + 1);
                  return used;
                }}
                onFocusBox={p.onFocusBox}
              />
              <OwnTripPanel own={own} onFocusBox={p.onFocusBox} focusSignal={p.focusSignal} />
              {own.draft.step === "set" && p.leaveAt && (
                <p className="text-[15px]">
                  {leavingLine(p.leaveAt)}. {LEAVE_AT_WATCHER_LINE}
                </p>
              )}
              {own.draft.step === "set" && (
                <Button look="outline" onClick={p.onOpenWatcher}>
                  Watcher on Telegram
                </Button>
              )}
            </>
          )}
          {known && inputs.trip !== OWN_TRIP && (
            <div className="space-y-2">
              <ChipGroup legend="Sample reports">
                {scenariosFor(inputs.trip).map((s) => (
                  <Chip key={s.id} pressed={s.id === inputs.scenario} onClick={() => p.change({ scenario: s.id })}>
                    {s.label}
                  </Chip>
                ))}
              </ChipGroup>
              <p className="text-small text-ink-2">{SAMPLES_LINE}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Chip pressed={inputs.rainingHere} onClick={() => p.change({ rainingHere: !inputs.rainingHere })}>
              {inputs.rainingHere ? <IconTick size={18} /> : <IconRain size={18} />}
              Raining here
            </Chip>
          </div>
          <Button id={CHECK_BUTTON_ID} size="lg" className="w-full justify-center" onClick={p.onCheck} disabled={!known || p.checking || !p.canCheck}>
            {ownTrip ? "Check my trip" : "Check this commute"}
          </Button>
        </>
      )}
    </section>
  );
}
