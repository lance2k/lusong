"use client";

import { useEffect, useRef, useState } from "react";
// Relative, not "@/": vitest doesn't resolve the alias, and this page is rendered in its tests.
import { BISAYA_VOICE_ENABLED, VOICE_LANGUAGES, type VoiceLanguage } from "../lib/voice-language";
import type { VoiceReportView } from "../lib/voice-report-handler";
import { MAX_VOICE_MS } from "../lib/wav";
import { phoneLocation } from "./phone-location";
import { startRecording, voiceNoteForm, type Recording } from "./voice-recorder";

type State =
  | { step: "idle" }
  | { step: "recording"; startedAt: number }
  | { step: "locating" }
  | { step: "sending" }
  | { step: "done"; report: VoiceReportView; duplicate: boolean }
  | { step: "failed"; message: string };

const TONES = {
  block: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
  other: "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100",
};

function Heard({ report, duplicate }: { report: VoiceReportView; duplicate: boolean }) {
  return (
    <div className={`space-y-2 rounded-2xl border px-5 py-4 ${report.counts && report.role === "block" ? TONES.block : TONES.other}`} data-testid="voice-reading">
      <p className="text-sm font-medium uppercase tracking-wide opacity-75">Lusong heard your voice note</p>
      <p className="text-lg font-semibold">{report.heard}</p>
      {report.saidPlace && <p className="text-[15px]">You named: {report.saidPlace}</p>}
      <p className="text-[15px]">
        {report.place ? `At ${report.place}` : "At your location"}, received {report.received}.
      </p>
      <p className="text-[15px]">{report.effect}</p>
      {duplicate && report.counts && <p className="text-[15px]">Lusong already had this voice note, so it stays one report.</p>}
    </div>
  );
}

export default function VoiceNote() {
  const [state, setState] = useState<State>({ step: "idle" });
  const [now, setNow] = useState(0);
  /** Nothing is picked for the rider: the language is theirs to declare, and Lusong goes by it. */
  const [language, setLanguage] = useState<VoiceLanguage | null>(null);
  const recording = useRef<Recording | null>(null);
  /** Set synchronously, so a second tap can't start a second recording or a second paid read. */
  const busy = useRef(false);
  /** The language picked when recording started: the one the note is sent with. */
  const recordedIn = useRef<VoiceLanguage | null>(null);

  /** Aborted when the page goes away, so a recording still starting then is let go as soon as it is. */
  const mounted = useRef<AbortController | null>(null);

  useEffect(() => {
    const page = new AbortController();
    mounted.current = page;
    return () => {
      page.abort();
      recording.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (state.step !== "recording") return;
    const tick = setInterval(() => setNow(Date.now()), 200);
    const hardStop = setTimeout(() => void finish(), MAX_VOICE_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(hardStop);
    };
  }, [state.step]);

  async function record() {
    if (busy.current || !language) return;
    busy.current = true;
    recordedIn.current = language;
    const page = mounted.current;
    try {
      recording.current = await startRecording({ signal: page?.signal });
    } catch {
      busy.current = false;
      if (page?.signal.aborted) return;
      setState({ step: "failed", message: "Lusong needs the microphone to record a voice note. Allow it and tap record again." });
      return;
    }
    const startedAt = Date.now();
    setNow(startedAt);
    setState({ step: "recording", startedAt });
  }

  async function finish() {
    const rec = recording.current;
    const language = recordedIn.current;
    if (!rec || !language) return;
    recording.current = null;
    try {
      const audio = await rec.stop();
      setState({ step: "locating" });
      let at: { lat: number; lon: number };
      try {
        at = await phoneLocation();
      } catch (err) {
        setState({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
        return;
      }
      setState({ step: "sending" });
      try {
        const res = await fetch("/api/report/voice", { method: "POST", body: voiceNoteForm(audio, at, language) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
        setState({ step: "done", report: body.report, duplicate: body.duplicate });
      } catch (err) {
        setState({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
      }
    } finally {
      busy.current = false;
    }
  }

  const secondsLeft = state.step === "recording" ? Math.max(0, Math.ceil((MAX_VOICE_MS - (now - state.startedAt)) / 1000)) : 0;
  const working = state.step === "locating" || state.step === "sending";
  return (
    <div className="space-y-3">
      <fieldset disabled={state.step === "recording" || working} className="space-y-2">
        <legend className="text-[15px] font-medium text-zinc-800 dark:text-zinc-200">Which language will you speak?</legend>
        <div className="flex gap-3">
          {VOICE_LANGUAGES.map((l) => (
            <label
              key={l.value}
              className="flex flex-1 items-center gap-2 rounded-xl border border-zinc-300 px-4 py-3 text-[15px] has-[:checked]:border-sky-600 has-[:checked]:bg-sky-50 dark:border-zinc-700 dark:has-[:checked]:bg-sky-950"
            >
              <input type="radio" name="voice-language" value={l.value} checked={language === l.value} onChange={() => setLanguage(l.value)} />
              {l.label}
            </label>
          ))}
        </div>
        {!BISAYA_VOICE_ENABLED && <p className="text-sm text-zinc-600 dark:text-zinc-400">Bisaya voice notes aren&apos;t supported yet.</p>}
      </fieldset>
      {state.step === "recording" ? (
        <button
          type="button"
          onClick={() => void finish()}
          className="flex w-full items-center justify-between gap-3 rounded-2xl bg-red-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-red-700"
        >
          <span>Stop and send</span>
          <span className="tabular-nums" aria-live="polite" aria-label={`${secondsLeft} seconds left`}>
            0:{String(secondsLeft).padStart(2, "0")}
          </span>
        </button>
      ) : (
        <button
          type="button"
          disabled={working || !language}
          onClick={() => void record()}
          className="w-full rounded-2xl border-2 border-sky-600 px-5 py-4 text-lg font-semibold text-sky-700 transition hover:bg-sky-50 disabled:opacity-60 dark:text-sky-300 dark:hover:bg-sky-950"
        >
          {state.step === "locating" ? "Finding where you are…" : state.step === "sending" ? "Listening to your note…" : "Record a voice note (up to 30 s)"}
        </button>
      )}
      {state.step === "idle" && (
        <p className="text-[15px] leading-snug text-zinc-600 dark:text-zinc-400">
          Pick the language, then say the street and how deep the water is. A voice note can warn others a street is not
          passable, never that it is clear. It is sent to Meta&apos;s Model API (Muse Voice Transcribe and Muse Spark) to be
          read; Lusong keeps the place you name and what you said about the water, not the recording or the rest of what you said.
        </p>
      )}
      {state.step === "recording" && <p className="text-center text-zinc-600 dark:text-zinc-400">Recording… it stops by itself at 30 seconds.</p>}
      {state.step === "done" && <Heard report={state.report} duplicate={state.duplicate} />}
      {state.step === "failed" && (
        <p className="rounded-2xl border border-red-300 bg-red-50 px-5 py-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {state.message}
        </p>
      )}
    </div>
  );
}
