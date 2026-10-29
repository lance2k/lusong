import { createHash, randomUUID } from "node:crypto";
import { admit } from "./admission";
import { roleOf, type Point, type Role } from "./answer";
import { budgetFromEnv, RESERVE_MICROS, type Budget } from "./budget";
import { checkPhoto } from "./check";
import { clientIp } from "./check-handler";
import { depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { readCaptureTime } from "./exif";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { locateSpot } from "./locate";
import { MetaApiError } from "./meta";
import { reportStoreFromEnv, toReport, type ReportStore, type StoredReport } from "./report-store";
import type { ValhallaGate } from "./router";

const MAX_BYTES = 3 * 1024 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
const MAX_SIDE = 1600;

/** Lusong's reports are for Philippine streets; a pin outside this box is refused before anything is paid for. */
const PHILIPPINES = { south: 4.5, north: 21.5, west: 116, east: 127 };

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pinFrom(form: FormData): Point | null {
  const lat = Number(form.get("lat"));
  const lon = Number(form.get("lon"));
  if (form.get("lat") === null || form.get("lon") === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function inThePhilippines(p: Point): boolean {
  return p.lat >= PHILIPPINES.south && p.lat <= PHILIPPINES.north && p.lon >= PHILIPPINES.west && p.lon <= PHILIPPINES.east;
}

/** What the reporter is shown: Lusong's reading in the commute check's words, and what it can do for others. */
export interface ReportView {
  id: string;
  place: string | null;
  received: string;
  captured: string | null;
  depth: string;
  passability: string;
  role: Role;
  effect: string;
  mmdaCredit: string;
}

function effectOf(report: StoredReport, role: Role): string {
  if (role === "clear") return "Others checking a trip through here will count this spot as clear for 3 hours.";
  if (role === "block") {
    return "Others checking a trip through here will count this spot as not passable for 3 hours, unless a newer photo of the same road shows it clear.";
  }
  if (report.verdict.kind !== "no_flood") return "Others will see this report, but it neither clears nor blocks the spot.";
  if (report.capturedAt === null) {
    return "Your photo carries no time it was taken, so Lusong can't tell it is recent: others will see it, but it can't mark the spot clear.";
  }
  return "Your photo's capture time (read as Philippine time) isn't within the hour before you sent it, so others will see it, but it can't mark the spot clear.";
}

function viewOf(report: StoredReport): ReportView {
  const role = roleOf(toReport(report), new Date(report.receivedAt));
  return {
    id: report.id,
    place: report.place,
    received: phtTime(report.receivedAt),
    captured: report.capturedAt === null ? null : phtTime(report.capturedAt),
    depth: depthWords(report.verdict),
    passability: passabilityLine(report.verdict),
    role,
    effect: effectOf(report, role),
    mmdaCredit: MMDA_CREDIT,
  };
}

export function makeReportHandler(deps: {
  gate: () => ValhallaGate;
  budget?: () => Budget;
  store?: () => ReportStore | null;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.store ?? reportStoreFromEnv;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    const receivedAt = now();
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "Send the photo as a form upload.");
    }
    const at = pinFrom(form);
    if (!at) return fail(400, "Lusong needs your phone's location to place the report.");
    if (!inThePhilippines(at)) return fail(400, "Lusong takes reports from streets in the Philippines only.");
    const photo = form.get("photo");
    if (!(photo instanceof File)) return fail(400, "No photo was attached.");
    if (photo.size > MAX_BYTES) return fail(413, "That photo is too large. Try a smaller one.");

    const upload = new Uint8Array(await photo.arrayBuffer());
    const capturedAt = readCaptureTime(upload);
    let jpeg: ReturnType<typeof sanitizeJpeg>;
    try {
      jpeg = sanitizeJpeg(upload);
    } catch (err) {
      if (err instanceof JpegError) return fail(415, "Lusong reads JPEG photos only.");
      throw err;
    }
    if (jpeg.width > MAX_SIDE || jpeg.height > MAX_SIDE) return fail(413, "That photo is too large. Try a smaller one.");
    // The stripped bytes, so a resend whose metadata was edited is still the same photo.
    const photoHash = createHash("sha256").update(jpeg.bytes).digest("hex");

    const store = reportStore();
    if (!store) return fail(503, "Lusong can't take reports right now.");
    let claim: Awaited<ReturnType<ReportStore["claimPhoto"]>>;
    try {
      claim = await store.claimPhoto(photoHash);
    } catch (err) {
      console.error("report store unreachable on claim:", err instanceof Error ? err.message : err);
      return fail(503, "Lusong can't take reports right now.");
    }
    if (claim.state === "duplicate") return Response.json({ duplicate: true, stored: true, report: viewOf(claim.report) });
    if (claim.state === "in_flight") return fail(409, "Lusong is already reading this photo.");

    const release = () =>
      store.releasePhoto(photoHash).catch((err: unknown) => {
        console.error("report store unreachable on release:", err instanceof Error ? err.message : err);
      });

    const admission = await admit(budget(), { clientIp: clientIp(request), reserveMicros: RESERVE_MICROS, now: receivedAt });
    if (!admission.ok) {
      await release();
      return admission.response();
    }

    const { run } = admission;
    let succeeded = false;
    try {
      const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
      let verdict: StoredReport["verdict"];
      try {
        verdict = (await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }, run.meter)).verdict;
      } catch (err) {
        console.error("report read failed:", err instanceof MetaApiError ? err.message : err);
        await release();
        return fail(502, "The measuring service didn't answer. Try again in a minute.");
      }
      succeeded = true;

      const spot = await locateSpot(at, { fetch: doFetch, gate: deps.gate() });
      const report: StoredReport = {
        id: randomUUID(),
        kind: "photo",
        at,
        wayId: spot.wayId,
        place: spot.place,
        receivedAt: receivedAt.toISOString(),
        capturedAt: capturedAt?.toISOString() ?? null,
        verdict,
        photoHash,
      };
      try {
        await store.save(report);
      } catch (err) {
        console.error("report store unreachable on save:", err instanceof Error ? err.message : err);
        await release();
        return Response.json({ duplicate: false, stored: false, report: viewOf(report) });
      }
      return Response.json({ duplicate: false, stored: true, report: viewOf(report) });
    } finally {
      await run.settle(succeeded);
    }
  };
}
