import { createHash, randomUUID } from "node:crypto";
import { admit } from "./admission";
import { counts, REPORT_LIFETIME_MS, roleOf, type Point, type Role } from "./answer";
import { budgetFromEnv, RESERVE_MICROS, type Budget } from "./budget";
import { checkPhoto } from "./check";
import { clientIp } from "./check-handler";
import { depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { readCaptureTime } from "./exif";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { locateSpot } from "./locate";
import { MetaApiError } from "./meta";
import { inMetroCebu } from "./metro-cebu";
import { reportStoreFromEnv, toReport, type ReportStore, type StoredReport } from "./report-store";
import type { ValhallaGate } from "./router";

const MAX_BYTES = 3 * 1024 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
const MAX_SIDE = 1600;

/** One deadline for the whole request, under the route's 120 s maxDuration, so a paid read is always saved and answered. */
export const REQUEST_BUDGET_MS = 110_000;
/** Kept back from every step for saving the report and settling the reservation, each one Upstash call bounded at 5 s. */
export const FINISH_RESERVE_MS = 12_000;
/** Below this much time to spare, /locate is skipped and the report is stored without a way id. */
export const LOCATE_MIN_MS = 3_000;

export interface Timing {
  budgetMs: number;
  finishReserveMs: number;
  locateMinMs: number;
}

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pinFrom(form: FormData): Point | null {
  const lat = Number(form.get("lat"));
  const lon = Number(form.get("lon"));
  if (form.get("lat") === null || form.get("lon") === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
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
  /** Whether the report counts in commute checks right now. */
  counts: boolean;
  effect: string;
  mmdaCredit: string;
}

function durationWords(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "less than a minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function effectOf(report: StoredReport, role: Role, leftMs: number): string {
  const left = durationWords(leftMs);
  if (role === "clear") return `Others checking a trip through here will count this spot as clear for the next ${left}.`;
  if (role === "block") {
    return `Others checking a trip through here will count this spot as not passable for the next ${left}, unless a newer photo of the same road shows it clear.`;
  }
  if (report.verdict.kind !== "no_flood") return "Others will see this report, but it neither clears nor blocks the spot.";
  if (report.capturedAt === null) {
    return "Your photo carries no time it was taken, so Lusong can't tell it is recent: others will see it, but it can't mark the spot clear.";
  }
  return "Your photo's capture time (read as Philippine time) isn't within the hour before you sent it, so others will see it, but it can't mark the spot clear.";
}

/** What the report does for others as of `now`: nothing if it wasn't saved or its 3 h are up. */
function viewOf(report: StoredReport, now: Date, stored: boolean): ReportView {
  const asRule = toReport(report);
  const role = roleOf(asRule, now);
  const live = stored && counts(asRule, now);
  const effect = !stored
    ? "Lusong couldn't save the report, so it doesn't count in anyone's check. Try sending it again in a minute."
    : !live
      ? "Lusong received this photo over 3 hours ago, so it no longer counts in anyone's check. Send a new photo of the street."
      : effectOf(report, role, REPORT_LIFETIME_MS - (now.getTime() - asRule.receivedAt.getTime()));
  return {
    id: report.id,
    place: report.place,
    received: phtTime(report.receivedAt),
    captured: report.capturedAt === null ? null : phtTime(report.capturedAt),
    depth: depthWords(report.verdict),
    passability: passabilityLine(report.verdict),
    role,
    counts: live,
    effect,
    mmdaCredit: MMDA_CREDIT,
  };
}

export function makeReportHandler(deps: {
  gate: () => ValhallaGate;
  budget?: () => Budget;
  store?: () => ReportStore | null;
  fetch?: typeof fetch;
  now?: () => Date;
  timing?: Timing;
}) {
  const timing = deps.timing ?? { budgetMs: REQUEST_BUDGET_MS, finishReserveMs: FINISH_RESERVE_MS, locateMinMs: LOCATE_MIN_MS };
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.store ?? reportStoreFromEnv;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    const receivedAt = now();
    // Epoch ms, like lib/meta.ts's deadlines; everything after the read must still fit before `finishBy`.
    const finishBy = Date.now() + timing.budgetMs - timing.finishReserveMs;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "Send the photo as a form upload.");
    }
    const at = pinFrom(form);
    if (!at) return fail(400, "Lusong needs your phone's location to place the report.");
    if (!inMetroCebu(at)) return fail(400, "Lusong takes reports from streets in Metro Cebu only.");
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
    if (claim.state === "duplicate") return Response.json({ duplicate: true, stored: true, report: viewOf(claim.report, receivedAt, true) });
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
        verdict = (await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }, run.meter, { deadline: finishBy })).verdict;
      } catch (err) {
        console.error("report read failed:", err instanceof MetaApiError ? err.message : err);
        await release();
        return fail(502, "The measuring service didn't answer. Try again in a minute.");
      }
      succeeded = true;

      const spot =
        finishBy - Date.now() >= timing.locateMinMs
          ? await locateSpot(at, { fetch: doFetch, gate: deps.gate() }, { deadline: finishBy })
          : { wayId: null, place: null };
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
        return Response.json({ duplicate: false, stored: false, report: viewOf(report, receivedAt, false) });
      }
      return Response.json({ duplicate: false, stored: true, report: viewOf(report, receivedAt, true) });
    } finally {
      await run.settle(succeeded);
    }
  };
}
