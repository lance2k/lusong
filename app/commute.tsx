"use client";

import dynamic from "next/dynamic";
import { useEffect, useReducer, useRef, useState } from "react";
import type { AnswerKind, Point, RouteState } from "@/lib/answer";
import { detourWords } from "@/lib/commute-words";
import { DEMO_TRIPS, SCENARIOS, scenariosFor, type DemoTripId } from "@/lib/samples";
import { MusePick, WebFindings, type PageMuse } from "./commute-muse";
import { commuteReducer, initialCommuteState, OWN_TRIP, type CommuteInputs, type CommuteState } from "./commute-state";
import { OwnTripPanel, useOwnTrip } from "./own-trip";
import { tripMapProps } from "./map-props";
import { ReportEvidence, type PageReport } from "./report-evidence";
import { checkRequest } from "./trip";

// Leaflet needs the browser's window, so the map is never rendered on the server.
const TripMap = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <div className="h-72 w-full rounded-2xl bg-zinc-100 dark:bg-zinc-900" />,
});

interface PageProduct {
  counts: boolean;
  event: string;
  area: string;
  sent: string;
  expires: string;
  link: string;
  rainForecast: string | null;
  rivers: string | null;
}

interface PageAdvisory {
  state: "active" | "none" | "unreadable";
  about: "your way" | "the other way";
  products: PageProduct[];
  warnings: PageProduct[];
  incomplete: boolean;
  note: string | null;
}

interface CommuteResult {
  trip: { id: DemoTripId | null; label: string };
  /** Posts the sweep found near these routes; shown only, never part of the answer. */
  sweepWarnings?: { id: string; text: string; link: string }[];
  rainingHere: boolean;
  answer: { kind: AnswerKind; title: string; reason: string; thin: string | null };
  route: { lengthKm: number; timeMin: number; streets: string[]; line: Point[] };
  detour: {
    state: RouteState;
    proposedBy: "rules" | "muse_spark";
    lengthKm: number;
    timeMin: number;
    extraKm: number;
    extraMin: number;
    streets: string[];
    line: Point[];
  } | null;
  advisory: PageAdvisory;
  muse: PageMuse;
  reports: PageReport[];
  mmdaCredit: string;
}

const TONES: Record<AnswerKind, string> = {
  go: "bg-emerald-600 text-white",
  go_another_way: "bg-emerald-700 text-white",
  wait: "bg-red-600 text-white",
  no_one_knows: "bg-amber-500 text-black",
};

const TRIP_IDS = Object.keys(DEMO_TRIPS) as DemoTripId[];
const TRIP_OPTIONS = [...TRIP_IDS.map((id) => ({ id, label: DEMO_TRIPS[id].label })), { id: OWN_TRIP, label: "Your trip" } as const];

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={o.id === value}
            onClick={() => onChange(o.id)}
            className="min-h-11 rounded-full border border-zinc-300 px-3 py-1.5 text-sm aria-pressed:bg-zinc-900 aria-pressed:text-white dark:border-zinc-700 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-900"
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}</>;
}

function Product({ product }: { product: PageProduct }) {
  return (
    <li className="space-y-0.5">
      <p className="font-medium">
        {product.event} for {product.area}
        {product.counts ? "" : " (shown only)"}
      </p>
      {product.rainForecast && <p>Rain forecast: {product.rainForecast}.</p>}
      {product.rivers && <p>Rivers named: {product.rivers}.</p>}
      <p className="text-zinc-600 dark:text-zinc-400">
        Sent {product.sent}. Expires {product.expires}.
      </p>
      <a className="break-all text-sky-700 underline dark:text-sky-400" href={product.link}>
        PAGASA&apos;s record
      </a>
    </li>
  );
}

function Advisory({ advisory }: { advisory: PageAdvisory }) {
  return (
    <section className="space-y-1 rounded-2xl border border-zinc-200 px-4 py-3 text-[15px] dark:border-zinc-800">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">PAGASA advisories on {advisory.about}</h3>
      {advisory.incomplete && (
        <p className="font-medium text-amber-800 dark:text-amber-300">Incomplete: Lusong couldn&apos;t read all of PAGASA&apos;s feed, so it counts an advisory as active.</p>
      )}
      {advisory.products.length > 0 && (
        <ul className="space-y-2">
          {advisory.products.map((p) => (
            <Product key={p.link} product={p} />
          ))}
        </ul>
      )}
      {advisory.note && !advisory.incomplete && <p>{advisory.note}</p>}
      {advisory.warnings.length > 0 && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">PAGASA advisories Lusong couldn&apos;t place on the map:</p>
          <ul className="space-y-2">
            {advisory.warnings.map((p) => (
              <Product key={`w-${p.link}`} product={p} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function inputWords(inputs: CommuteInputs): string {
  const rain = inputs.rainingHere ? "raining here" : "no rain tap";
  if (inputs.trip === OWN_TRIP) return `Your trip · ${rain}`;
  const scenario = SCENARIOS.find((s) => s.id === inputs.scenario)!.label;
  return `Demo: ${DEMO_TRIPS[inputs.trip].label} · ${scenario} · ${rain}`;
}

function ResultView({ result, checkedFor }: { result: CommuteResult; checkedFor: CommuteInputs }) {
  const { answer, route, detour } = result;
  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
        <div className={`px-5 py-4 ${TONES[answer.kind]}`}>
          <p className="text-2xl font-bold leading-tight">{answer.title}</p>
          <p className="mt-1 text-sm opacity-90">{inputWords(checkedFor)}</p>
        </div>
        <div className="space-y-2 px-5 py-4 text-[15px] leading-relaxed">
          <p>{answer.reason}</p>
          {answer.thin && <p className="text-zinc-600 dark:text-zinc-400">{answer.thin}</p>}
          {result.rainingHere && <p className="text-zinc-600 dark:text-zinc-400">You tapped &ldquo;raining here&rdquo;.</p>}
        </div>
      </section>

      {result.muse && <MusePick pick={result.muse.pick} />}

      <Advisory advisory={result.advisory} />

      {result.sweepWarnings && result.sweepWarnings.length > 0 && (
        <section className="space-y-2 text-[15px]">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Posts near your way</h3>
          <p className="text-zinc-600 dark:text-zinc-400">Lusong found these online and hasn&apos;t confirmed them. They don&apos;t change the answer.</p>
          <ul className="space-y-2">
            {result.sweepWarnings.map((w) => (
              <li key={w.id}>
                {w.text}{" "}
                <a href={w.link} target="_blank" rel="noopener noreferrer" className="underline">
                  Source
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.muse && <WebFindings web={result.muse.web} />}

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Reports</h3>
        {result.reports.length === 0 ? (
          <p className="text-[15px] text-zinc-600 dark:text-zinc-400">No reports on this trip.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 text-[15px] dark:divide-zinc-800 dark:border-zinc-800">
            {result.reports.map((r) => (
              <ReportEvidence key={r.id} r={r} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-zinc-500">{result.mmdaCredit}</p>
      </section>

      <section className="space-y-3 text-[15px]">
        <div>
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            {detour ? "Your usual way" : "Route"}
          </h3>
          <p>
            {route.lengthKm.toFixed(2)} km, about {route.timeMin} min by motorbike
            {route.streets.length > 0 && <>, via {route.streets.join(", ")}</>}.
          </p>
        </div>
        {detour && (
          <div>
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">The other way</h3>
            <p>
              {detour.lengthKm.toFixed(2)} km, about {detour.timeMin} min by motorbike
              {detour.streets.length > 0 && <>, via {detour.streets.join(", ")}</>}.
            </p>
            <p className="font-semibold">{detourWords(detour)}.</p>
            {detour.proposedBy === "muse_spark" && (
              <p className="text-sm text-zinc-500">Muse Spark suggested this way; Lusong&apos;s rules judged it on the reports along it.</p>
            )}
          </div>
        )}
        <p className="mt-1 text-sm text-zinc-500">
          Route from Valhalla (FOSSGIS) on OpenStreetMap data, © OpenStreetMap contributors.
        </p>
      </section>
    </div>
  );
}

export default function CommuteCheck() {
  const [state, dispatch] = useReducer(
    commuteReducer<CommuteResult>,
    initialCommuteState as CommuteState<CommuteResult>,
  );
  const { trip, scenario, rainingHere } = state.inputs;
  const view = state.view;
  const own = useOwnTrip(() => dispatch({ type: "change", inputs: {} }));
  const ownTrip = trip === OWN_TRIP;
  const savedTrip = own.draft.step === "set" ? own.draft.trip : null;
  // A trip saved on an earlier visit is chosen once it is read, so the next check is one tap.
  const restored = useRef(false);
  useEffect(() => {
    if (!savedTrip || restored.current) return;
    restored.current = true;
    dispatch({ type: "change", inputs: { trip: OWN_TRIP } });
  }, [savedTrip]);
  const map = tripMapProps({
    demo: ownTrip ? null : DEMO_TRIPS[trip],
    draft: own.draft,
    riderMoved: own.touched,
    result: view.step === "done" ? view.result : null,
  });

  async function check() {
    const ticket = state.ticket + 1;
    const inputs = state.inputs;
    dispatch({ type: "start", at: Date.now() });
    try {
      const res = await fetch("/api/commute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputs.trip === OWN_TRIP ? checkRequest(savedTrip!, inputs.rainingHere) : { mode: "demo", ...inputs }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.answer) {
        dispatch({ type: "failed", ticket, message: body?.error ?? "Lusong couldn't run the check. Try again in a minute." });
        return;
      }
      dispatch({ type: "answered", ticket, result: body as CommuteResult });
    } catch {
      dispatch({ type: "failed", ticket, message: "Lusong couldn't be reached. Check your connection." });
    }
  }

  return (
    <div className="space-y-5">
      <Choice
        label="Trip"
        options={TRIP_OPTIONS}
        value={trip}
        onChange={(id) => dispatch({ type: "change", inputs: { trip: id } })}
      />
      {ownTrip && <OwnTripPanel own={own} />}
      <TripMap {...map} onTap={ownTrip ? own.tap : undefined} />
      {!ownTrip && (
        <div className="space-y-1">
          <Choice
            label="Sample reports"
            options={scenariosFor(trip)}
            value={scenario}
            onChange={(id) => dispatch({ type: "change", inputs: { scenario: id } })}
          />
          <p className="text-sm text-zinc-500">
            Samples are labelled test photos from elsewhere, pinned on these streets for the demo. Real checks never use them.
          </p>
        </div>
      )}
      <button
        type="button"
        aria-pressed={rainingHere}
        onClick={() => dispatch({ type: "change", inputs: { rainingHere: !rainingHere } })}
        className="w-full rounded-2xl border-2 border-sky-600 px-5 py-3 text-base font-semibold text-sky-700 aria-pressed:bg-sky-600 aria-pressed:text-white dark:text-sky-300"
      >
        {rainingHere ? "Raining here ✓" : "Tap if it's raining here"}
      </button>
      <button
        type="button"
        onClick={check}
        disabled={view.step === "checking" || (ownTrip && !savedTrip)}
        className="w-full rounded-2xl bg-sky-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-60"
      >
        {ownTrip ? "Check my trip" : "Check this commute"}
      </button>

      <div aria-live="polite">
        {view.step === "checking" && (
          <p className="text-center text-zinc-600 dark:text-zinc-400">
            Reading PAGASA&apos;s flood advisory, getting the motorbike route, gathering reports, checking the web for road closures and, if your way is blocked, looking for another… <Elapsed since={view.startedAt} /> s
          </p>
        )}
        {view.step === "failed" && (
          <p className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 font-semibold text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {view.message}
          </p>
        )}
        {view.step === "done" && <ResultView result={view.result} checkedFor={view.for} />}
      </div>
    </div>
  );
}
