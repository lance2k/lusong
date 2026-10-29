"use client";

import { useEffect, useRef, useState } from "react";
import type { AnswerKind } from "@/lib/answer";
import { DEMO_TRIPS, SCENARIOS, type DemoTripId, type ScenarioId } from "@/lib/samples";

interface PageReport {
  id: string;
  sample: boolean;
  place: string;
  age: string;
  depth: string | null;
  passability: string | null;
  origin: string;
  credit: string;
  sourceUrl: string;
  counts: boolean;
  onRoute: boolean;
  role: "clear" | "block" | "neutral";
}

interface PageAdvisory {
  state: "active" | "none" | "unreadable";
  headline?: string | null;
  rainForecast?: string | null;
  rivers?: string | null;
  sent?: string;
  expires?: string;
  link?: string;
  note: string | null;
}

interface CommuteResult {
  trip: { id: DemoTripId; label: string };
  rainingHere: boolean;
  answer: { kind: AnswerKind; title: string; reason: string; thin: string | null };
  route: { lengthKm: number; timeMin: number; streets: string[] };
  advisory: PageAdvisory;
  reports: PageReport[];
  mmdaCredit: string;
}

type State =
  | { step: "idle" }
  | { step: "checking"; startedAt: number }
  | { step: "done"; result: CommuteResult }
  | { step: "failed"; message: string };

const TONES: Record<AnswerKind, string> = {
  go: "bg-emerald-600 text-white",
  go_another_way: "bg-emerald-700 text-white",
  wait: "bg-red-600 text-white",
  no_one_knows: "bg-amber-500 text-black",
};

const ROLE_WORDS: Record<PageReport["role"], string> = {
  block: "Marks the spot not passable",
  neutral: "Neither clears nor blocks the spot",
  clear: "Shows the spot clear",
};

const TRIP_IDS = Object.keys(DEMO_TRIPS) as DemoTripId[];

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
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-sm aria-pressed:bg-zinc-900 aria-pressed:text-white dark:border-zinc-700 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-900"
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

function Advisory({ advisory }: { advisory: PageAdvisory }) {
  return (
    <section className="space-y-1 rounded-2xl border border-zinc-200 px-4 py-3 text-[15px] dark:border-zinc-800">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">PAGASA flood advisory for Cebu</h3>
      {advisory.state === "active" ? (
        <>
          <p className="font-medium">{advisory.headline ?? "General Flood Advisory"}: active</p>
          {advisory.rainForecast && <p>Rain forecast: {advisory.rainForecast}.</p>}
          {advisory.rivers && <p>Rivers named for Cebu: {advisory.rivers}.</p>}
          <p className="text-zinc-600 dark:text-zinc-400">
            Sent {advisory.sent}. Expires {advisory.expires}.
          </p>
          {advisory.link && (
            <a className="break-all text-sky-700 underline dark:text-sky-400" href={advisory.link}>
              PAGASA&apos;s record
            </a>
          )}
        </>
      ) : (
        <p className={advisory.state === "unreadable" ? "font-medium text-amber-800 dark:text-amber-300" : ""}>{advisory.note}</p>
      )}
    </section>
  );
}

function Report({ r }: { r: PageReport }) {
  const status = !r.counts ? "Older than 3 hours: shown, not counted." : !r.onRoute ? "Not on your route." : ROLE_WORDS[r.role] + ".";
  return (
    <li className="space-y-1 px-4 py-3">
      <p className="flex flex-wrap items-center gap-2">
        {r.sample && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-semibold uppercase dark:bg-zinc-700">Sample</span>}
        <span className="font-medium">{r.place}</span>
        <span className="text-zinc-500">{r.age}</span>
      </p>
      {r.depth && <p>Water {r.depth}.</p>}
      {r.passability && <p>{r.passability}.</p>}
      <p className="text-zinc-600 dark:text-zinc-400">{status}</p>
      {r.sample && (
        <p className="text-sm text-zinc-500">
          Sample, not a report from this street. Where the photo was really taken: {r.origin}. {r.credit}.{" "}
          <a className="text-sky-700 underline dark:text-sky-400" href={r.sourceUrl}>
            See the photo
          </a>
        </p>
      )}
    </li>
  );
}

function ResultView({ result }: { result: CommuteResult }) {
  const { answer, route } = result;
  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
        <div className={`px-5 py-4 ${TONES[answer.kind]}`}>
          <p className="text-2xl font-bold leading-tight">{answer.title}</p>
          <p className="mt-1 text-sm opacity-90">{result.trip.label} · demo</p>
        </div>
        <div className="space-y-2 px-5 py-4 text-[15px] leading-relaxed">
          <p>{answer.reason}</p>
          {answer.thin && <p className="text-zinc-600 dark:text-zinc-400">{answer.thin}</p>}
          {result.rainingHere && <p className="text-zinc-600 dark:text-zinc-400">You tapped &ldquo;raining here&rdquo;.</p>}
        </div>
      </section>

      <Advisory advisory={result.advisory} />

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Reports</h3>
        {result.reports.length === 0 ? (
          <p className="text-[15px] text-zinc-600 dark:text-zinc-400">No reports on this trip.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 text-[15px] dark:divide-zinc-800 dark:border-zinc-800">
            {result.reports.map((r) => (
              <Report key={r.id} r={r} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-zinc-500">{result.mmdaCredit}</p>
      </section>

      <section className="text-[15px]">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">Route</h3>
        <p>
          {route.lengthKm.toFixed(2)} km, about {route.timeMin} min by motorbike
          {route.streets.length > 0 && <>, via {route.streets.join(", ")}</>}.
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Route from Valhalla (FOSSGIS) on OpenStreetMap data, © OpenStreetMap contributors.
        </p>
      </section>
    </div>
  );
}

export default function CommuteCheck() {
  const [trip, setTrip] = useState<DemoTripId>("banilad-itpark");
  const [scenario, setScenario] = useState<ScenarioId>("none");
  const [rainingHere, setRainingHere] = useState(false);
  const [state, setState] = useState<State>({ step: "idle" });
  const latest = useRef(0);

  async function check() {
    const ticket = ++latest.current;
    setState({ step: "checking", startedAt: Date.now() });
    try {
      const res = await fetch("/api/commute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "demo", trip, scenario, rainingHere }),
      });
      const body = await res.json().catch(() => null);
      if (ticket !== latest.current) return;
      if (!res.ok || !body?.answer) {
        setState({ step: "failed", message: body?.error ?? "Lusong couldn't run the check. Try again in a minute." });
        return;
      }
      setState({ step: "done", result: body as CommuteResult });
    } catch {
      if (ticket === latest.current) setState({ step: "failed", message: "Lusong couldn't be reached. Check your connection." });
    }
  }

  return (
    <div className="space-y-5">
      <Choice label="Demo trip" options={TRIP_IDS.map((id) => ({ id, label: DEMO_TRIPS[id].label }))} value={trip} onChange={setTrip} />
      <div className="space-y-1">
        <Choice label="Sample reports" options={SCENARIOS} value={scenario} onChange={setScenario} />
        <p className="text-sm text-zinc-500">
          Samples are labelled test photos from elsewhere, pinned on these streets for the demo. Real checks never use them.
        </p>
      </div>
      <button
        type="button"
        aria-pressed={rainingHere}
        onClick={() => setRainingHere((r) => !r)}
        className="w-full rounded-2xl border-2 border-sky-600 px-5 py-3 text-base font-semibold text-sky-700 aria-pressed:bg-sky-600 aria-pressed:text-white dark:text-sky-300"
      >
        {rainingHere ? "Raining here ✓" : "Tap if it's raining here"}
      </button>
      <button
        type="button"
        onClick={check}
        disabled={state.step === "checking"}
        className="w-full rounded-2xl bg-sky-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-60"
      >
        Check this commute
      </button>

      <div aria-live="polite">
        {state.step === "checking" && (
          <p className="text-center text-zinc-600 dark:text-zinc-400">
            Reading PAGASA&apos;s flood advisory, getting the motorbike route and gathering reports… <Elapsed since={state.startedAt} /> s
          </p>
        )}
        {state.step === "failed" && (
          <p className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 font-semibold text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {state.message}
          </p>
        )}
        {state.step === "done" && <ResultView result={state.result} />}
      </div>
    </div>
  );
}
