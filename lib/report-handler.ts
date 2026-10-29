import { createHash, randomUUID } from "node:crypto";
import { admit } from "./admission";
import { counts, REPORT_LIFETIME_MS, roleOf, type Point, type Role } from "./answer";
import { blobStoreFromEnv, type BlobStore } from "./blob-store";
import { budgetFromEnv, PHOTO_REPORT_RESERVE_MICROS, RESERVE_MICROS, type Budget } from "./budget";
import { checkPhoto } from "./check";
import { clientIp } from "./check-handler";
import { depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { readCaptureTime } from "./exif";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { locateSpot } from "./locate";
import { MetaApiError, segmentReply, type Meter } from "./meta";
import { inMetroCebu } from "./metro-cebu";
import { beforeDeadline, readBody } from "./deadline";
import { PLATE_DETECTION_TRUSTED, publishPhoto, type PhotoInput, type PhotoOutcome, type SamCall } from "./photo-publish";
import type { SamReply } from "./sam";
import { reportStoreFromEnv, toReport, type ReportStore, type Saved, type StoredPhotoReport } from "./report-store";
import type { ValhallaGate } from "./router";

const MAX_BYTES = 3 * 1024 * 1024;
/** The photo plus the form's boundaries and the two coordinates. */
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
const MAX_SIDE = 1600;

/**
 * One deadline for the whole request, from its first byte, under the route's 120 s maxDuration: a paid read is always
 * saved, settled and answered, and nothing is claimed or reserved that there is no time left to use.
 */
export interface Timing {
  budgetMs: number;
  /** Each Upstash call (claim, admission, save, release, settle) is bounded at this by its own timeout. */
  storeCallMs: number;
  /** Kept back for writing the response. */
  responseMs: number;
  /** A photo read isn't started with less than this before it must end. */
  minReadMs: number;
  /** Below this much time to spare after the read, /locate is skipped and the report is stored without a way id. */
  locateMinMs: number;
  /** Below this much time to spare after the read, no plate call is made and the report shows no photo. Photo
   *  reports only; PHOTO_MIN_MS when unset. */
  photoMinMs?: number;
}

/** Enough for one SAM call's first attempt to answer, the blur and the blob put; less, and no plate call is made. */
const PHOTO_MIN_MS = 8_000;

export const TIMING: Timing = { budgetMs: 110_000, storeCallMs: 5_000, responseMs: 2_000, minReadMs: 20_000, locateMinMs: 3_000, photoMinMs: PHOTO_MIN_MS };
export const REQUEST_BUDGET_MS = TIMING.budgetMs;

/** A failed save, its release and the settle run one after another, then the response. */
function finishReserveMs(t: Timing): number {
  return 3 * t.storeCallMs + t.responseMs;
}
export const FINISH_RESERVE_MS = finishReserveMs(TIMING);

const OUT_OF_TIME = "Lusong ran out of time for this report. Try sending it again in a minute.";

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

export function durationWords(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "less than a minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function effectOf(report: StoredPhotoReport, role: Role, leftMs: number): string {
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
function viewOf(report: StoredPhotoReport, now: Date, stored: boolean): ReportView {
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

/**
 * The blurred copy of a report photo, or no photo: one `license plate` call on the run's meter, then the blur and the
 * put, all before `by`. A put that lands after `by` is deleted, since no record will point at it.
 */
async function photoFor(
  jpeg: Uint8Array,
  imageDataUrl: string,
  persons: SamReply,
  ctx: { meter: Meter; photos: BlobStore; trusted: boolean; blur?: PhotoInput["blur"]; by: number },
): Promise<string | null> {
  const plates: SamCall = await segmentReply(imageDataUrl, "license plate", ctx.by, ctx.meter).then(
    (reply) => ({ ok: true, ...reply }),
    () => ({ ok: false }),
  );
  const publishing = publishPhoto({
    jpeg,
    persons: { ok: true, ...persons },
    plates,
    store: ctx.photos,
    blur: ctx.blur,
    plateDetectionTrusted: ctx.trusted,
    signal: AbortSignal.timeout(Math.max(0, ctx.by - Date.now())),
  });
  const outcome: PhotoOutcome | "late" = await beforeDeadline(publishing, ctx.by);
  if (outcome === "late") {
    void publishing.then((o) => (o.published ? ctx.photos.delete(o.url) : undefined)).catch(() => {});
    return null;
  }
  if (!outcome.published) console.error("report photo not shown:", outcome.reason);
  return outcome.published ? outcome.url : null;
}

export function makeReportHandler(deps: {
  gate: () => ValhallaGate;
  budget?: () => Budget;
  store?: () => ReportStore | null;
  fetch?: typeof fetch;
  now?: () => Date;
  timing?: Timing;
  /** Where blurred photos go; null (BLOB_READ_WRITE_TOKEN unset) shows no photo and makes no plate call. */
  photos?: () => BlobStore | null;
  plateDetectionTrusted?: boolean;
  blur?: PhotoInput["blur"];
}) {
  const timing = deps.timing ?? TIMING;
  const photoStore = deps.photos ?? blobStoreFromEnv;
  const plateDetectionTrusted = deps.plateDetectionTrusted ?? PLATE_DETECTION_TRUSTED;
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.store ?? reportStoreFromEnv;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    const receivedAt = now();
    // Epoch ms, like lib/meta.ts's deadlines. Each step must start early enough for every later one to fit.
    const deadline = Date.now() + timing.budgetMs;
    const settleBy = deadline - timing.responseMs;
    const releaseBy = settleBy - timing.storeCallMs;
    const saveBy = releaseBy - timing.storeCallMs;
    const finishBy = deadline - finishReserveMs(timing);
    const admitBy = finishBy - timing.minReadMs;
    const claimBy = admitBy - timing.storeCallMs;

    const body = await readBody(request, { maxBytes: MAX_BODY_BYTES, deadline: claimBy });
    if (body === "too_large") return fail(413, "That photo is too large. Try a smaller one.");
    if (body === "too_slow") return fail(408, "Lusong didn't receive the whole photo in time. Try again on a steadier connection.");
    let form: FormData;
    try {
      form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
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
    const release = (token: string, by: number) =>
      beforeDeadline(store.releasePhoto(photoHash, token), by).catch((err: unknown) => {
        console.error("report store unreachable on release:", err instanceof Error ? err.message : err);
      });

    if (Date.now() > claimBy) return fail(503, OUT_OF_TIME);
    const claiming = store.claimPhoto(photoHash);
    let claim: Awaited<ReturnType<ReportStore["claimPhoto"]>> | "late";
    try {
      claim = await beforeDeadline(claiming, admitBy);
    } catch (err) {
      console.error("report store unreachable on claim:", err instanceof Error ? err.message : err);
      return fail(503, "Lusong can't take reports right now.");
    }
    if (claim === "late") {
      // The claim may still land; free it then, so the photo can be sent again.
      void claiming.then(
        async (c) => {
          if (c.state === "claimed") await release(c.token, Infinity);
        },
        () => {},
      );
      return fail(503, OUT_OF_TIME);
    }
    if (claim.state === "duplicate") return Response.json({ duplicate: true, stored: true, report: viewOf(claim.report, receivedAt, true) });
    if (claim.state === "in_flight") return fail(409, "Lusong is already reading this photo.");
    const { token } = claim;

    if (Date.now() > admitBy) {
      await release(token, releaseBy);
      return fail(503, OUT_OF_TIME);
    }
    // Publishing needs both a trusted plate finder and a store; without either, the plate call would buy nothing.
    const photos = plateDetectionTrusted ? photoStore() : null;
    const reserveMicros = photos ? PHOTO_REPORT_RESERVE_MICROS : RESERVE_MICROS;
    const admitting = admit(budget(), { clientIp: clientIp(request), reserveMicros, now: receivedAt });
    const admission = await beforeDeadline(admitting, finishBy - timing.minReadMs);
    if (admission === "late") {
      // No Meta call will start, so a reservation that lands late is refunded in full.
      void admitting.then(
        async (a) => {
          if (a.ok) await a.run.settle(true);
        },
        () => {},
      );
      await release(token, releaseBy);
      return fail(503, OUT_OF_TIME);
    }
    if (!admission.ok) {
      await release(token, releaseBy);
      return admission.response();
    }

    const { run } = admission;
    if (finishBy - Date.now() < timing.minReadMs) {
      await release(token, releaseBy);
      await beforeDeadline(run.settle(true), settleBy);
      return fail(503, OUT_OF_TIME);
    }
    let succeeded = false;
    try {
      const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
      let verdict: StoredPhotoReport["verdict"];
      let personReply: SamReply;
      try {
        ({ verdict, personReply } = await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }, run.meter, { deadline: finishBy }));
      } catch (err) {
        console.error("report read failed:", err instanceof MetaApiError ? err.message : err);
        await release(token, releaseBy);
        return fail(502, "The measuring service didn't answer. Try again in a minute.");
      }
      succeeded = true;

      const spare = finishBy - Date.now();
      const [spot, photoUrl] = await Promise.all([
        spare >= timing.locateMinMs ? locateSpot(at, { fetch: doFetch, gate: deps.gate() }, { deadline: finishBy }) : { wayId: null, place: null },
        photos && spare >= (timing.photoMinMs ?? PHOTO_MIN_MS)
          ? photoFor(jpeg.bytes, imageDataUrl, personReply, { meter: run.meter, photos, trusted: plateDetectionTrusted, blur: deps.blur, by: finishBy })
          : null,
      ]);
      const report: StoredPhotoReport = {
        id: randomUUID(),
        kind: "photo",
        at,
        wayId: spot.wayId,
        place: spot.place,
        receivedAt: receivedAt.toISOString(),
        capturedAt: capturedAt?.toISOString() ?? null,
        verdict,
        photoHash,
        ...(photoUrl ? { photoUrl } : {}),
      };
      const dropPhoto = () => {
        if (photoUrl && photos) void photos.delete(photoUrl).catch(() => {});
      };
      const saving = store.save(report, token);
      let saved: Saved | "unknown";
      try {
        saved = await beforeDeadline(saving, saveBy).then((s) => (s === "late" ? "unknown" : s));
      } catch (err) {
        console.error("report store unreachable on save:", err instanceof Error ? err.message : err);
        saved = "unknown";
      }
      if (saved === "unknown") {
        // A late or failed save may still commit, or may already have, with the photo's URL in it. Only the store's
        // own answer that it wrote nothing frees the photo; a save that never answers leaves an unlisted blurred blob,
        // never a stored URL to a deleted one.
        void saving.then(
          (s) => {
            if (s.state !== "saved") dropPhoto();
          },
          () => {},
        );
        await release(token, releaseBy);
        return Response.json({ duplicate: false, stored: false, report: viewOf(report, receivedAt, false) });
      }
      if (saved.state !== "saved") dropPhoto();
      if (saved.state === "duplicate" && saved.report.kind === "photo") {
        return Response.json({ duplicate: true, stored: true, report: viewOf(saved.report, receivedAt, true) });
      }
      // not_owner: the claim lapsed and the store says it wrote nothing.
      const stored = saved.state === "saved";
      return Response.json({ duplicate: false, stored, report: viewOf(report, receivedAt, stored) });
    } finally {
      // A settle cut off here keeps the whole reservation charged: the safe side.
      await beforeDeadline(run.settle(succeeded), settleBy);
    }
  };
}
