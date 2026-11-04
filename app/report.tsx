"use client";

import { useEffect, useRef, useState } from "react";
import type { Role } from "../lib/answer";
import { readExifTimeText, withExifTime } from "../lib/exif";
import type { ReportView } from "../lib/report-handler";
import { phoneLocation } from "./phone-location";
import { photoOutcomeLine } from "./report-outcome";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;

/** Said before a pick: the photo is shown first, and only Send report sends it (#48). */
export const REPORT_PICK_LINE = "You'll see the photo before anything is sent.";
/** Said beside the preview, at the commit point. */
export const REPORT_SHARE_LINE =
  "Send report shares this photo and your location with Lusong. Once the report is saved, it counts for 3 hours in other riders' commute checks.";

/** The photo as it will be sent (re-encoded, metadata dropped), and a local URL to show it by. */
export interface Picked {
  photo: Blob;
  url: string;
}

export type ReportState =
  | { step: "idle" }
  | { step: "opening" }
  | { step: "previewing"; picked: Picked }
  | { step: "locating"; picked: Picked }
  | { step: "reading"; picked: Picked; startedAt: number }
  | { step: "done"; report: ReportView; duplicate: boolean }
  | { step: "failed"; message: string };

const sending = (state: ReportState) => state.step === "locating" || state.step === "reading";

/** A pick only ever shows the photo; sending is its own tap. A pick landing while a report is sent changes nothing. */
export function afterPick(state: ReportState, picked: Picked): ReportState {
  return sending(state) ? state : { step: "previewing", picked };
}

/**
 * The canvas re-encode shrinks the upload and drops every piece of metadata, GPS included. Only the capture time is
 * put back, because the server needs it to tell a fresh photo from an old one.
 */
async function preparePhoto(file: File): Promise<Blob> {
  const timeText = readExifTimeText(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const shrunk = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", JPEG_QUALITY),
  );
  if (!timeText) return shrunk;
  const bytes = withExifTime(new Uint8Array(await shrunk.arrayBuffer()), timeText);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
}

const ROLE_TONES: Record<Role, string> = {
  clear: "border-go bg-go/10 text-ink",
  block: "border-wait bg-wait/10 text-ink",
  neutral: "border-line bg-surface text-ink",
};

function Reading({ state }: { state: Extract<ReportState, { step: "done" }> }) {
  const { report, duplicate } = state;
  return (
    <div className={`space-y-2 rounded-card border-2 px-5 py-4 ${ROLE_TONES[report.counts ? report.role : "neutral"]}`} data-testid="report-reading">
      <p className="text-sm font-medium uppercase tracking-wide opacity-75">Lusong read your photo</p>
      <p className="text-xl font-semibold">{report.passability}</p>
      <p>Depth: {report.depth}</p>
      <p className="text-[15px]">
        {report.place ? `At ${report.place}` : "At your location"}, received {report.received}
        {report.captured ? `, photo taken ${report.captured}` : ""}.
      </p>
      <p className="text-[15px]">{report.effect}</p>
      {duplicate && report.counts && <p className="text-[15px]">Lusong already had this photo, so it stays one report.</p>}
      <p className="text-sm opacity-75">{report.mmdaCredit}</p>
    </div>
  );
}

const primary =
  "min-h-14 w-full rounded-control bg-brand px-5 text-lg font-semibold text-on-brand shadow-sm transition hover:brightness-110 disabled:opacity-60";
const secondary = "min-h-14 w-full rounded-control border border-line bg-surface px-5 text-lg font-semibold text-ink disabled:opacity-60";

function takeLabel(state: ReportState): string {
  if (state.step === "opening") return "Opening the photo…";
  if ("picked" in state) return "Retake";
  return "Report this street";
}

/** What the report shows for a state. `onTake` opens the camera or the photo picker; `onSend` sends the previewed photo. */
export function ReportPanel({ state, onTake, onSend }: { state: ReportState; onTake: () => void; onSend: () => void }) {
  const picked = "picked" in state ? state.picked : null;
  const busy = sending(state);
  return (
    <>
      {picked && (
        /* eslint-disable-next-line @next/next/no-img-element -- a local blob URL, nothing to optimise */
        <img
          src={picked.url}
          alt={state.step === "previewing" ? "Your photo, not sent yet" : "Your photo, being sent"}
          className={`block max-h-[35dvh] w-full rounded-card object-contain ${busy ? "animate-pulse motion-reduce:animate-none" : ""}`}
        />
      )}
      {state.step === "previewing" && <p className="text-sm text-ink-2">{REPORT_SHARE_LINE}</p>}
      {picked && (
        <button type="button" disabled={state.step !== "previewing"} onClick={onSend} className={primary}>
          {state.step === "locating" ? "Finding where you are…" : state.step === "reading" ? "Reading the water…" : "Send report"}
        </button>
      )}
      {/* The same button before and after a pick, and never disabled while a photo opens, so focus coming back from the
          picker stays on it; a newer pick replaces one still opening. */}
      <button type="button" disabled={busy} onClick={onTake} className={picked ? secondary : primary}>
        {takeLabel(state)}
      </button>
      {(state.step === "idle" || state.step === "done" || state.step === "failed") && (
        <p className="text-center text-sm text-ink-2">{REPORT_PICK_LINE}</p>
      )}
      {state.step === "reading" && (
        <p className="text-center text-ink-2">Finding the water, people and cars… usually about 15 s</p>
      )}
      {state.step === "done" && <Reading state={state} />}
      {state.step === "failed" && (
        <p role="alert" className="rounded-card border border-wait bg-wait/10 px-5 py-4 font-medium text-ink">
          {state.message}
        </p>
      )}
    </>
  );
}

/**
 * `shown` is false while the rider is elsewhere (another view or tab): the component stays mounted so a send still
 * lands here, and its outcome is also told through `notify`.
 */
export default function ReportStreet({ shown = true, notify }: { shown?: boolean; notify?: (line: string) => void } = {}) {
  const [state, setState] = useState<ReportState>({ step: "idle" });
  const seen = useRef({ shown, notify });
  useEffect(() => {
    seen.current = { shown, notify };
  });
  const input = useRef<HTMLInputElement>(null);
  /** Set synchronously, so a second tap on Send report can't start a second paid read. */
  const inFlight = useRef(false);
  /** Only the newest pick may land: one still opening when the rider picks again is dropped. */
  const latestPick = useRef(0);
  const shownUrl = useRef<string | null>(null);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (shownUrl.current) URL.revokeObjectURL(shownUrl.current);
      shownUrl.current = null;
    };
  }, []);

  function forgetPhoto() {
    if (shownUrl.current) URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = null;
  }

  function finish(next: Extract<ReportState, { step: "done" | "failed" }>) {
    forgetPhoto();
    setState(next);
    if (!seen.current.shown) seen.current.notify?.(photoOutcomeLine(next.step === "done" ? { report: next.report } : { message: next.message }));
  }

  async function pick(file: File) {
    if (inFlight.current) return;
    const thisPick = ++latestPick.current;
    setState({ step: "opening" });
    let photo: Blob;
    try {
      photo = await preparePhoto(file);
    } catch {
      if (latestPick.current === thisPick && !inFlight.current) finish({ step: "failed", message: "This browser couldn't open that photo. Try a JPEG or PNG." });
      return;
    }
    if (disposed.current || latestPick.current !== thisPick || inFlight.current) return;
    forgetPhoto();
    shownUrl.current = URL.createObjectURL(photo);
    setState((s) => afterPick(s, { photo, url: shownUrl.current! }));
  }

  async function send(picked: Picked) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setState({ step: "locating", picked });
      let at: { lat: number; lon: number };
      try {
        at = await phoneLocation();
      } catch (err) {
        finish({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
        return;
      }
      setState({ step: "reading", picked, startedAt: Date.now() });
      const form = new FormData();
      form.append("photo", picked.photo, "photo.jpg");
      form.append("lat", String(at.lat));
      form.append("lon", String(at.lon));
      try {
        const res = await fetch("/api/report", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
        finish({ step: "done", report: body.report, duplicate: body.duplicate });
      } catch (err) {
        finish({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
      }
    } finally {
      inFlight.current = false;
    }
  }

  // In the half-height sheet the preview opens below the fold: its Send button is brought into view, the photo above it.
  const root = useRef<HTMLDivElement>(null);
  const previewing = state.step === "previewing";
  useEffect(() => {
    const img = previewing ? root.current?.querySelector("img") : null;
    if (!img) return;
    // After the photo decodes: before, it has no height, and its load would push the button back out of view.
    const show = () => root.current?.querySelector("img ~ button")?.scrollIntoView({ block: "end", behavior: "smooth" });
    img.decode().then(show, show);
  }, [previewing]);

  return (
    <div ref={root} className="space-y-4">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void pick(file);
        }}
      />
      <ReportPanel
        state={state}
        onTake={() => input.current?.click()}
        onSend={() => {
          if (state.step === "previewing") void send(state.picked);
        }}
      />
    </div>
  );
}
