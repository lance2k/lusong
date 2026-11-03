"use client";

import { useEffect, useRef, useState } from "react";
// Relative, not "@/": vitest doesn't resolve the alias, and this page is rendered in its tests.
import { BISAYA_VOICE_ENABLED, VOICE_LANGUAGES, type VoiceLanguage } from "../lib/voice-language";
import type { VoiceReportView } from "../lib/voice-report-handler";
import { MAX_VOICE_MS } from "../lib/wav";
import { phoneLocation } from "./phone-location";
import { RECORDING_STOPPED_LINE, voiceOutcomeLine } from "./report-outcome";
import { startRecording, voiceNoteForm } from "./voice-recorder";
import { voiceSession } from "./voice-session";

type State =
  | { step: "idle" }
  | { step: "recording"; startedAt: number }
  | { step: "locating" }
  | { step: "sending" }
  | { step: "done"; report: VoiceReportView; duplicate: boolean }
  | { step: "failed"; message: string };

const TONES = {
  block: "border-wait bg-wait/10 text-ink",
  other: "border-line bg-surface text-ink",
};

function Heard({ report, duplicate }: { report: VoiceReportView; duplicate: boolean }) {
  return (
    <div className={`space-y-2 rounded-card border-2 px-5 py-4 ${report.counts && report.role === "block" ? TONES.block : TONES.other}`} data-testid="voice-reading">
      <p className="text-sm font-medium uppercase tracking-wide opacity-75">Lusong heard your voice note</p>
      <p className="text-lg font-semibold">{report.heard}</p>
      {report.saidPlace && <p className="text-[15px]">The place Lusong heard: {report.saidPlace}</p>}
      <p className="text-[15px]">
        {report.place ? `At ${report.place}` : "At your location"}, received {report.received}.
      </p>
      <p className="text-[15px]">{report.effect}</p>
      {duplicate && report.counts && <p className="text-[15px]">Lusong already had this voice note, so it stays one report.</p>}
    </div>
  );
}

/**
 * `shown` is false while the rider is elsewhere: a note being sent still lands here and is also told through
 * `notify`, and a recording is stopped and dropped, never sent half-made.
 */
export default function VoiceNote({ shown = true, notify }: { shown?: boolean; notify?: (line: string) => void } = {}) {
  const [state, setState] = useState<State>({ step: "idle" });
  const seen = useRef({ shown, notify });
  /** The latest render's finish, for the 30 s timer, which outlives the render that set it. */
  const latestFinish = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    seen.current = { shown, notify };
    latestFinish.current = finish;
  });
  const [now, setNow] = useState(0);
  /** Nothing is picked for the rider: the language is theirs to declare, and Lusong goes by it. */
  const [language, setLanguage] = useState<VoiceLanguage | null>(null);
  const [session] = useState(() => voiceSession((signal) => startRecording({ signal })));
  /** Set synchronously, so a second tap can't start a second recording or a second paid read. */
  const busy = useRef(false);
  /** The language picked when recording started: the one the note is sent with. */
  const recordedIn = useRef<VoiceLanguage | null>(null);

  useEffect(() => () => void session.leave(), [session]);

  function settle(next: Extract<State, { step: "done" | "failed" }>) {
    setState(next);
    if (!seen.current.shown) seen.current.notify?.(voiceOutcomeLine(next.step === "done" ? { report: next.report } : { message: next.message }));
  }

  // Leaving lets go of a microphone still being set up, and drops a recording under way and says so. A note already
  // being sent is left to land.
  useEffect(() => {
    if (shown || !session.leave()) return;
    busy.current = false;
    seen.current.notify?.(RECORDING_STOPPED_LINE);
    // Not cleared on a quick return: the button must not stay on "Stop and send" with nothing recording.
    setTimeout(() => setState({ step: "idle" }), 0);
  }, [shown, session]);

  useEffect(() => {
    if (state.step !== "recording") return;
    const tick = setInterval(() => setNow(Date.now()), 200);
    const hardStop = setTimeout(() => void latestFinish.current(), MAX_VOICE_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(hardStop);
    };
  }, [state.step]);

  async function record() {
    if (busy.current || !language) return;
    busy.current = true;
    recordedIn.current = language;
    let rec;
    try {
      rec = await session.start();
    } catch {
      busy.current = false;
      setState({ step: "failed", message: "Lusong needs the microphone to record a voice note. Allow it and tap record again." });
      return;
    }
    if (!rec) {
      busy.current = false;
      return;
    }
    const startedAt = Date.now();
    setNow(startedAt);
    setState({ step: "recording", startedAt });
  }

  async function finish() {
    const language = recordedIn.current;
    if (!language) return;
    const rec = session.take();
    if (!rec) return;
    try {
      const audio = await rec.stop();
      setState({ step: "locating" });
      let at: { lat: number; lon: number };
      try {
        at = await phoneLocation();
      } catch (err) {
        settle({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
        return;
      }
      setState({ step: "sending" });
      try {
        const res = await fetch("/api/report/voice", { method: "POST", body: voiceNoteForm(audio, at, language) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
        settle({ step: "done", report: body.report, duplicate: body.duplicate });
      } catch (err) {
        settle({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
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
        <legend className="text-[15px] font-medium text-ink">Which language will you speak?</legend>
        <div className="flex gap-3">
          {VOICE_LANGUAGES.map((l) => (
            <label
              key={l.value}
              className="flex min-h-11 flex-1 items-center gap-2 rounded-control border border-line bg-surface px-4 py-3 text-[15px] has-[:checked]:border-brand has-[:checked]:bg-brand/10"
            >
              <input type="radio" name="voice-language" value={l.value} checked={language === l.value} onChange={() => setLanguage(l.value)} />
              {l.label}
            </label>
          ))}
        </div>
        {!BISAYA_VOICE_ENABLED && <p className="text-sm text-ink-2">Bisaya voice notes aren&apos;t supported yet.</p>}
      </fieldset>
      {state.step === "recording" ? (
        <button
          type="button"
          onClick={() => void finish()}
          className="flex min-h-14 w-full items-center justify-between gap-3 rounded-control bg-wait px-5 text-lg font-semibold text-on-wait shadow-sm transition hover:brightness-110"
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
          className="min-h-14 w-full rounded-control border-2 border-brand px-5 text-lg font-semibold text-brand transition hover:bg-brand/10 disabled:opacity-60"
        >
          {state.step === "locating" ? "Finding where you are…" : state.step === "sending" ? "Listening to your note…" : "Record a voice note (up to 30 s)"}
        </button>
      )}
      {state.step === "idle" && (
        <p className="text-[15px] leading-snug text-ink-2">
          Pick the language, then say the street and how deep the water is. A voice note can warn others a street is not
          passable, never that it is clear. It is sent to Meta&apos;s Model API (Muse Voice Transcribe and Muse Spark) to be
          read; Lusong keeps the place you name and what you said about the water, not the recording or the rest of what you said.
        </p>
      )}
      {state.step === "recording" && <p className="text-center text-ink-2">Recording… it stops by itself at 30 seconds.</p>}
      {state.step === "done" && <Heard report={state.report} duplicate={state.duplicate} />}
      {state.step === "failed" && (
        <p className="rounded-card border border-wait bg-wait/10 px-5 py-4 font-medium text-ink">
          {state.message}
        </p>
      )}
    </div>
  );
}
