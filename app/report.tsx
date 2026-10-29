"use client";

import { useRef, useState } from "react";
import type { Role } from "@/lib/answer";
import { readExifTimeText, withExifTime } from "@/lib/exif";
import type { ReportView } from "@/lib/report-handler";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;
const LOCATION_TIMEOUT_MS = 15_000;

type State =
  | { step: "idle" }
  | { step: "locating" }
  | { step: "reading"; startedAt: number }
  | { step: "done"; report: ReportView; duplicate: boolean }
  | { step: "failed"; message: string };

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

function phoneLocation(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Lusong needs your phone's location to place the report. Allow location and try again.")),
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}

const ROLE_TONES: Record<Role, string> = {
  clear: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  block: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
  neutral: "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100",
};

function Reading({ state }: { state: Extract<State, { step: "done" }> }) {
  const { report, duplicate } = state;
  return (
    <div className={`space-y-2 rounded-2xl border px-5 py-4 ${ROLE_TONES[report.counts ? report.role : "neutral"]}`} data-testid="report-reading">
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

export default function ReportStreet() {
  const [state, setState] = useState<State>({ step: "idle" });
  const input = useRef<HTMLInputElement>(null);
  /** Set synchronously, so a second pick can't start a second paid read. */
  const inFlight = useRef(false);

  async function send(file: File) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setState({ step: "locating" });
      let at: { lat: number; lon: number };
      let photo: Blob;
      const prepared = preparePhoto(file).catch(() => {
        throw new Error("This browser couldn't open that photo. Try a JPEG or PNG.");
      });
      try {
        [at, photo] = await Promise.all([phoneLocation(), prepared]);
      } catch (err) {
        setState({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
        return;
      }
      setState({ step: "reading", startedAt: Date.now() });
      const form = new FormData();
      form.append("photo", photo, "photo.jpg");
      form.append("lat", String(at.lat));
      form.append("lon", String(at.lon));
      try {
        const res = await fetch("/api/report", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
        setState({ step: "done", report: body.report, duplicate: body.duplicate });
      } catch (err) {
        setState({ step: "failed", message: err instanceof Error ? err.message : "Something went wrong." });
      }
    } finally {
      inFlight.current = false;
    }
  }

  const busy = state.step === "locating" || state.step === "reading";
  return (
    <div className="space-y-4">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void send(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="w-full rounded-2xl bg-sky-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-60"
      >
        {state.step === "locating" ? "Finding where you are…" : state.step === "reading" ? "Reading the water…" : "Report this street"}
      </button>
      {state.step === "reading" && (
        <p className="text-center text-zinc-600 dark:text-zinc-400">Finding the water, people and cars… usually about 15 s</p>
      )}
      {state.step === "done" && <Reading state={state} />}
      {state.step === "failed" && (
        <p className="rounded-2xl border border-red-300 bg-red-50 px-5 py-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {state.message}
        </p>
      )}
    </div>
  );
}
