"use client";

import { useEffect, useRef, useState } from "react";
import type { RefusalReason } from "@/lib/budget";
import type { PageObject, PageResult } from "@/lib/check";
import { cropBox, type ViewBox } from "@/lib/crop";
import { gaugeRowsFor, type Interval, type Landmark, type Verdict } from "@/lib/verdict";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;

const LANDMARK_WORDS: Record<Landmark, string> = {
  ankle: "at the ankle",
  half_knee: "at mid-shin (half-knee)",
  below_knee: "just below the knee",
  knee: "at the knee",
  mid_thigh: "at mid-thigh",
  hip: "at the hips",
  waist: "at the waist",
  chest: "at the chest",
  tyre_quarter: "a quarter up the tyre",
  tyre_half: "halfway up the tyre",
  tyre_three_quarter: "three-quarters up the tyre",
  tyre_full: "at the top of the tyre",
  above_tyre: "above the tyres",
  not_visible: "waterline not visible",
};

/** A result measured earlier on a credited photo, shown when the page can't measure the visitor's own. */
interface Sample {
  id: string;
  title: string;
  photo: string;
  result: string;
  measuredOn: string;
  credit: string;
}

type LoadedSample = { sample: Sample; result: PageResult };

const REFUSAL_REASONS: readonly RefusalReason[] = ["budget", "ip", "unavailable"];

type State =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "measuring"; previewUrl: string; startedAt: number }
  | { step: "done"; previewUrl: string; result: PageResult }
  | { step: "refused"; message: string; samples: LoadedSample[] | null; shown: number }
  | { step: "failed"; previewUrl: string | null; message: string };

async function loadSamples(): Promise<LoadedSample[]> {
  const samples = (await (await fetch("/samples/index.json")).json()) as Sample[];
  return Promise.all(
    samples.map(async (sample) => ({ sample, result: (await (await fetch(sample.result)).json()) as PageResult })),
  );
}

/** Re-encoding through a canvas shrinks the upload and drops EXIF, GPS included. */
async function shrinkToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", JPEG_QUALITY),
  );
}

function cm(i: Interval): string {
  return `${i.low}–${i.high} cm`;
}

function gaugeWords(i: Interval): string {
  const { within, below, above } = gaugeRowsFor(i);
  const name = (row: { name: string; inches: number }) => `${row.name.toLowerCase()} (${row.inches} in)`;
  if (within.length > 0) return `around MMDA ${within.map(name).join(" to ")}`;
  if (below && above) return `between MMDA ${name(below)} and ${name(above)}`;
  if (above) return `under MMDA ${name(above)}`;
  return `deeper than MMDA ${name(below!)}`;
}

const TONES = {
  green: "bg-emerald-600 text-white",
  amber: "bg-amber-500 text-black",
  red: "bg-red-600 text-white",
  grey: "bg-zinc-600 text-white",
};

function headline(v: Verdict): { title: string; code: string | null; tone: keyof typeof TONES } {
  if (v.kind === "cannot_measure") return { title: "Can't measure this one", code: null, tone: "grey" };
  if (v.kind === "no_flood") return { title: "Lusong couldn't find flood water in this photo", code: null, tone: "grey" };
  switch (v.passability) {
    case "shallow":
      return { title: "Shallow where measured, but not a go-ahead", code: null, tone: "amber" };
    case "unsure":
      return v.readingsComplete
        ? { title: "Unsure: treat it as not passable to light vehicles", code: null, tone: "amber" }
        : { title: "Unsure: it may be deeper than Lusong could read. Don't drive through", code: null, tone: "red" };
    case "NPLV":
      return { title: "Not passable to light vehicles", code: "NPLV", tone: "amber" };
    case "NPATV":
      return { title: "Not passable to any vehicle", code: "NPATV", tone: "red" };
  }
}

const CONFIDENCE_WORDS = {
  high: "High: three or more readings that agree.",
  medium: "Medium: at least two readings, fairly close together.",
  low: "Low: few readings, or they disagree. Depth often varies across a street.",
};

function VerdictCard({ result }: { result: PageResult }) {
  const v = result.verdict;
  const h = headline(v);
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      <div className={`px-5 py-4 ${TONES[h.tone]}`}>
        <p className="text-xl font-semibold leading-tight">{h.title}</p>
        {h.code && <p className="mt-1 text-sm opacity-90">MMDA class {h.code}</p>}
      </div>
      <div className="space-y-2 px-5 py-4 text-[15px] leading-relaxed">
        {v.kind === "measured" && (
          <>
            <p>
              Deepest reading: <b>{v.decidedBy.label}</b>,{" "}
              {v.decidedBy.landmark === "tyre_geometry"
                ? "estimated from the part of its tyre under water"
                : `water ${LANDMARK_WORDS[v.decidedBy.landmark]}`}
              , about{" "}
              <b>{cm(v.decidedBy.interval)}</b>, {gaugeWords(v.decidedBy.interval)}.
            </p>
            {v.decidedBy.landmark === "tyre_geometry" && (
              <p>
                That estimate assumes a 58–70 cm tyre seen side-on. On a wheel seen at an angle it can read shallower
                than the water is.
              </p>
            )}
            <p>
              {v.readingsUsed.length} reading{v.readingsUsed.length === 1 ? "" : "s"} in all, {cm(v.rangeCm)}. The
              deepest one decides, because a car has to get through the deepest part.
            </p>
            {v.passability === "shallow" && (
              <p>
                The readings put the water under 33 cm (MMDA half-tire deep) where these people and cars stand.
                Lusong never calls a street passable: depth changes across a street, and in testing it sometimes
                read knee-deep water as shallower than it was.
              </p>
            )}
            {v.passability === "unsure" && (
              <p>
                {v.readingsComplete
                  ? "Too few clear readings, so Lusong won't call this passable."
                  : "Some readings were missing or inconsistent, and a missing one could be the deepest, so Lusong won't give a class."}
              </p>
            )}
            <p className="text-zinc-600 dark:text-zinc-400">Confidence: {CONFIDENCE_WORDS[v.confidence]}</p>
          </>
        )}
        {v.kind === "cannot_measure" &&
          (v.reason === "too_crowded" ? (
            <p>
              There are too many people and cars in this photo to read in one go. Try a photo with fewer of them.
            </p>
          ) : (
            <p>
              Lusong measures against people and cars standing in the water, and it couldn&apos;t see a waterline on
              any here. Try a photo with a person or car in the water.
            </p>
          ))}
      </div>
    </section>
  );
}

/** The photo drawn inside the SVG, so a zoomed crop is the same drawing with a smaller viewBox. */
function Scene({ result, imageUrl, viewBox, label }: { result: PageResult; imageUrl: string; viewBox?: ViewBox; label: string }) {
  const { width, height } = result.image;
  const view = viewBox ?? { x: 0, y: 0, width, height };
  return (
    <svg viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} role="img" aria-label={label} className="block h-auto w-full">
      <image href={imageUrl} x={0} y={0} width={width} height={height} />
      {result.water.map((w, i) => (
        <path key={i} d={w.d} transform={w.transform} fill="rgb(56 189 248 / 0.35)" fillRule="evenodd" />
      ))}
      {result.objects.map((o) => (
        <g key={o.label}>
          <rect
            x={o.box.left}
            y={o.box.top}
            width={o.box.right - o.box.left}
            height={o.box.bottom - o.box.top}
            fill="none"
            stroke={o.usable ? "#facc15" : "#ffffff"}
            strokeOpacity={o.usable ? 1 : 0.6}
            strokeDasharray={o.usable ? undefined : "4 4"}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          {o.usable && o.waterlineY !== null && (
            <line
              x1={o.box.left - 6}
              x2={o.box.right + 6}
              y1={o.waterlineY}
              y2={o.waterlineY}
              stroke="#22d3ee"
              strokeWidth={3}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      ))}
    </svg>
  );
}

function Overlay({ result, imageUrl, label }: { result: PageResult; imageUrl: string; label: string }) {
  const { width, height } = result.image;
  const pct = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <div className="relative overflow-hidden rounded-2xl">
      <Scene result={result} imageUrl={imageUrl} label={label} />
      {result.objects.map((o) => (
        <span
          key={o.label}
          className={`absolute -translate-y-full rounded px-1 text-[11px] font-semibold leading-4 ${
            o.usable ? "bg-yellow-400 text-black" : "bg-black/60 text-white"
          }`}
          style={{ left: pct(o.box.left, width), top: pct(o.box.top, height) }}
        >
          {o.label}
        </span>
      ))}
    </div>
  );
}

/** At phone width the people are a few pixels tall, so each reading gets a zoomed view of its own. */
function Crops({ result, imageUrl }: { result: PageResult; imageUrl: string }) {
  const read = result.objects
    .filter((o) => o.landmark && o.landmark !== "not_visible")
    .sort((a, b) => Number(b.usable) - Number(a.usable));
  if (read.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Up close</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {read.map((o) => (
          <li key={o.label} className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <Scene result={result} imageUrl={imageUrl} viewBox={cropBox(o.box, result.image)} label={`${o.label} up close`} />
            <p className="px-2 py-1.5 text-[13px] leading-snug">
              <b>{o.label}</b> {LANDMARK_WORDS[o.landmark!]}
              {o.interval && <> · {cm(o.interval)}</>}
              {!o.usable && " · not used"}
              {o.tyreCm && <> · tyre {cm(o.tyreCm)}</>}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultView({ result, imageUrl, photoLabel }: { result: PageResult; imageUrl: string; photoLabel: string }) {
  return (
    <>
      <VerdictCard result={result} />
      <Overlay result={result} imageUrl={imageUrl} label={photoLabel} />
      <Crops result={result} imageUrl={imageUrl} />
      <ReadingList objects={result.objects} />
    </>
  );
}

function Refused({ state, onShow }: { state: Extract<State, { step: "refused" }>; onShow: (index: number) => void }) {
  const current = state.samples?.[state.shown];
  return (
    <>
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">{state.message}</p>
        <p className="mt-1 text-[15px]">
          Your photo was not measured.
          {current && " Below is a sample photo Lusong measured earlier, so you can see what a result looks like."}
        </p>
      </div>
      {state.samples && state.samples.length > 1 && (
        <div className="flex gap-2">
          {state.samples.map(({ sample }, i) => (
            <button
              key={sample.id}
              type="button"
              aria-pressed={i === state.shown}
              onClick={() => onShow(i)}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-sm aria-pressed:bg-zinc-900 aria-pressed:text-white dark:border-zinc-700 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-900"
            >
              {sample.title}
            </button>
          ))}
        </div>
      )}
      {current && (
        <>
          <p className="rounded-xl bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
            Sample photo, not yours · measured {current.sample.measuredOn} · Photo: {current.sample.credit}
          </p>
          <ResultView
            result={current.result}
            imageUrl={current.sample.photo}
            photoLabel={`Sample photo: ${current.sample.title}, with the water and the measured people and cars marked`}
          />
        </>
      )}
    </>
  );
}

function ReadingList({ objects }: { objects: PageObject[] }) {
  if (objects.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">What Lusong measured against</h2>
      <ul className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 text-[15px] dark:divide-zinc-800 dark:border-zinc-800">
        {objects.map((o) => (
          <li key={o.label} className="flex gap-3 px-4 py-3">
            <span className={`mt-0.5 h-fit rounded px-1.5 text-xs font-bold ${o.usable ? "bg-yellow-400 text-black" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
              {o.label}
            </span>
            <span>
              {o.kind === "person" ? "Person" : "Vehicle"}, {o.landmark ? LANDMARK_WORDS[o.landmark] : "no reading"}
              {o.interval && <b> · {cm(o.interval)}</b>}
              {!o.usable && o.landmark && o.landmark !== "not_visible" && " · not used"}
              {o.tyreCm && <> · tyre estimate {cm(o.tyreCm)}</>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-zinc-500">
        Cyan lines mark where the segmentation found the water meeting a person or car. Readings with no line still
        count; the line is drawn only where the mask clearly meets the water.
      </p>
      {objects.some((o) => o.tyreCm) && (
        <p className="mt-2 text-sm text-zinc-500">
          A tyre estimate assumes a car tyre 58–70 cm across, seen side-on. It counts all of the tyre it can&apos;t see
          as under water, so it reads deeper when the car&apos;s body hides the top of the tyre. On a wheel seen at an
          angle it can read shallower than the water is. It can make the verdict deeper, never shallower.
        </p>
      )}
    </section>
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

export default function Checker() {
  const [state, setState] = useState<State>({ step: "idle" });
  const input = useRef<HTMLInputElement>(null);
  /** Set synchronously, before the async resize, so a second pick can't start a second paid check. */
  const inFlight = useRef(false);
  const shownUrl = useRef<string | null>(null);
  /** Set on unmount so a resize still running then neither creates a URL nor starts a paid check. */
  const disposed = useRef(false);
  /** Samples load after the paid-check lock is released, so a late load must not land on a newer check. */
  const latestCheck = useRef(0);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (shownUrl.current) URL.revokeObjectURL(shownUrl.current);
      shownUrl.current = null;
    };
  }, []);

  function showPreview(blob: Blob): string {
    if (shownUrl.current) URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = URL.createObjectURL(blob);
    return shownUrl.current;
  }

  async function check(file: File) {
    if (inFlight.current) return;
    inFlight.current = true;
    const thisCheck = ++latestCheck.current;
    setState({ step: "preparing" });
    try {
      let blob: Blob;
      try {
        blob = await shrinkToJpeg(file);
      } catch {
        setState({ step: "failed", previewUrl: null, message: "This browser couldn't open that photo. Try a JPEG or PNG." });
        return;
      }
      if (disposed.current) return;
      const previewUrl = showPreview(blob);
      setState({ step: "measuring", previewUrl, startedAt: Date.now() });
      const form = new FormData();
      form.append("photo", blob, "photo.jpg");
      try {
        const res = await fetch("/api/check", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok && REFUSAL_REASONS.includes(body.reason)) {
          const message = body.error ?? "Lusong can't take new checks right now.";
          setState({ step: "refused", message, samples: null, shown: 0 });
          void loadSamples().then(
            (samples) => {
              if (disposed.current || latestCheck.current !== thisCheck) return;
              setState((s) => (s.step === "refused" ? { ...s, samples } : s));
            },
            () => {},
          );
          return;
        }
        if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
        setState({ step: "done", previewUrl, result: body as PageResult });
      } catch (err) {
        setState({ step: "failed", previewUrl, message: err instanceof Error ? err.message : "Something went wrong." });
      }
    } finally {
      inFlight.current = false;
    }
  }

  const busy = state.step === "preparing" || state.step === "measuring";
  return (
    <div className="space-y-5">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void check(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="w-full rounded-2xl bg-sky-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-60"
      >
        {state.step === "idle" ? "Choose or take a photo" : busy ? "Measuring…" : "Check another photo"}
      </button>

      {state.step === "measuring" && (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL, nothing to optimise */}
          <img src={state.previewUrl} alt="Your photo, being measured" className="block w-full animate-pulse rounded-2xl" />
          <p className="text-center text-zinc-600 dark:text-zinc-400">
            Finding the water, people and cars… <Elapsed since={state.startedAt} /> s (usually about 15)
          </p>
        </div>
      )}

      {state.step === "done" && (
        <ResultView
          result={state.result}
          imageUrl={state.previewUrl}
          photoLabel="Your photo with the water and the measured people and cars marked"
        />
      )}

      {state.step === "refused" && (
        <Refused state={state} onShow={(shown) => setState((s) => (s.step === "refused" ? { ...s, shown } : s))} />
      )}

      {state.step === "failed" && (
        <p className="rounded-2xl border border-red-300 bg-red-50 px-5 py-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {state.message}
        </p>
      )}
    </div>
  );
}
