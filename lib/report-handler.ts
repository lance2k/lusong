import { createHash, randomUUID } from "node:crypto";
import { admit } from "./admission";
import { counts, REPORT_LIFETIME_MS, roleOf, type Point, type Role } from "./answer";
import { blobStoreFromEnv, type BlobStore } from "./blob-store";
import { budgetFromEnv, PHOTO_REPORT_RESERVE_MICROS, RESERVE_MICROS, type Budget, type RefusalReason } from "./budget";
import { checkPhoto } from "./check";
import { clientIp } from "./check-handler";
import { depthWords, MMDA_CREDIT, passabilityLine, phtTime } from "./commute-words";
import { readCaptureTime } from "./exif";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { locateSpot } from "./locate";
import { MetaApiError, segmentReply, type Meter } from "./meta";
import { inServerTripBound } from "./province-index";
import { beforeDeadline, readBody } from "./deadline";
import { PLATE_DETECTION_TRUSTED, publishPhoto, type PhotoInput, type PhotoOutcome, type SamCall } from "./photo-publish";
import type { SamReply } from "./sam";
import { reportStoreFromEnv, toReport, type ReportStore, type Saved, type StoredPhotoReport } from "./report-store";
import type { ValhallaGate } from "./router";

export const MAX_BYTES = 3 * 1024 * 1024;
/** The photo plus the form's boundaries and the two coordinates. */
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
export const MAX_SIDE = 1600;

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

/** When each step of a photo report must start or end, counted back from the moment the whole report must be done. */
export function photoSchedule(deadline: number, timing: Timing = TIMING) {
  const settleBy = deadline - timing.responseMs;
  const releaseBy = settleBy - timing.storeCallMs;
  const saveBy = releaseBy - timing.storeCallMs;
  const finishBy = deadline - finishReserveMs(timing);
  const admitBy = finishBy - timing.minReadMs;
  const claimBy = admitBy - timing.storeCallMs;
  return { settleBy, releaseBy, saveBy, finishBy, admitBy, claimBy };
}

/** `never`: no plate call and no blurred copy, whatever PLATE_DETECTION_TRUSTED says. */
export type PublishPolicy = "never" | "when_trusted";

export interface PhotoReportInput {
  /** The photo as sent, metadata and all; it is sanitized here and never kept. */
  upload: Uint8Array;
  at: Point;
  capturedAt: Date | null;
  receivedAt: Date;
  /** Whose daily limit the report counts against: an address, or `tg:<chat id>`. */
  admitKey: string | null;
  /** Epoch ms by which the report is settled and done; every step's own limit is counted back from it. */
  deadline: number;
  publish: PublishPolicy;
}

export type PhotoRefusal = "too_large" | "not_jpeg" | "store_down" | "out_of_time" | "in_flight" | "unread";

export type PhotoReportOutcome =
  | { ok: true; duplicate: boolean; stored: boolean; report: ReportView }
  | { ok: false; refused: PhotoRefusal }
  | { ok: false; refused: "admission"; reason: RefusalReason; response: () => Response };

export interface PhotoReportDeps {
  gate: () => ValhallaGate;
  budget?: () => Budget;
  store?: () => ReportStore | null;
  fetch?: typeof fetch;
  timing?: Timing;
  /** Where blurred photos go; null (BLOB_READ_WRITE_TOKEN unset) shows no photo and makes no plate call. */
  photos?: () => BlobStore | null;
  plateDetectionTrusted?: boolean;
  blur?: PhotoInput["blur"];
}

/** The photo report's steps after the upload is in hand, shared by the page's route and the Telegram bot. */
export function makePhotoReporter(deps: PhotoReportDeps) {
  const timing = deps.timing ?? TIMING;
  const photoStore = deps.photos ?? blobStoreFromEnv;
  const plateDetectionTrusted = deps.plateDetectionTrusted ?? PLATE_DETECTION_TRUSTED;
  const budget = deps.budget ?? budgetFromEnv;
  const reportStore = deps.store ?? reportStoreFromEnv;
  const doFetch: typeof fetch = (...args) => (deps.fetch ?? fetch)(...args);
  const refused = (r: PhotoRefusal): PhotoReportOutcome => ({ ok: false, refused: r });

  return async function processPhotoReport(input: PhotoReportInput): Promise<PhotoReportOutcome> {
    const { at, capturedAt, receivedAt } = input;
    const { settleBy, releaseBy, saveBy, finishBy, admitBy, claimBy } = photoSchedule(input.deadline, timing);

    let jpeg: ReturnType<typeof sanitizeJpeg>;
    try {
      jpeg = sanitizeJpeg(input.upload);
    } catch (err) {
      if (err instanceof JpegError) return refused("not_jpeg");
      throw err;
    }
    if (jpeg.width > MAX_SIDE || jpeg.height > MAX_SIDE) return refused("too_large");
    // The stripped bytes, so a resend whose metadata was edited is still the same photo.
    const photoHash = createHash("sha256").update(jpeg.bytes).digest("hex");

    const store = reportStore();
    if (!store) return refused("store_down");
    const release = (token: string, by: number) =>
      beforeDeadline(store.releasePhoto(photoHash, token), by).catch((err: unknown) => {
        console.error("report store unreachable on release:", err instanceof Error ? err.message : err);
      });

    if (Date.now() > claimBy) return refused("out_of_time");
    const claiming = store.claimPhoto(photoHash);
    let claim: Awaited<ReturnType<ReportStore["claimPhoto"]>> | "late";
    try {
      claim = await beforeDeadline(claiming, admitBy);
    } catch (err) {
      console.error("report store unreachable on claim:", err instanceof Error ? err.message : err);
      return refused("store_down");
    }
    if (claim === "late") {
      // The claim may still land; free it then, so the photo can be sent again.
      void claiming.then(
        async (c) => {
          if (c.state === "claimed") await release(c.token, Infinity);
        },
        () => {},
      );
      return refused("out_of_time");
    }
    if (claim.state === "duplicate") return { ok: true, duplicate: true, stored: true, report: viewOf(claim.report, receivedAt, true) };
    if (claim.state === "in_flight") return refused("in_flight");
    const { token } = claim;

    if (Date.now() > admitBy) {
      await release(token, releaseBy);
      return refused("out_of_time");
    }
    // Publishing needs both a trusted plate finder and a store; without either, the plate call would buy nothing.
    const photos = input.publish === "when_trusted" && plateDetectionTrusted ? photoStore() : null;
    const reserveMicros = photos ? PHOTO_REPORT_RESERVE_MICROS : RESERVE_MICROS;
    const admitting = admit(budget(), { clientIp: input.admitKey, reserveMicros, now: receivedAt });
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
      return refused("out_of_time");
    }
    if (!admission.ok) {
      await release(token, releaseBy);
      return { ok: false, refused: "admission", reason: admission.reason, response: admission.response };
    }

    const { run } = admission;
    if (finishBy - Date.now() < timing.minReadMs) {
      await release(token, releaseBy);
      await beforeDeadline(run.settle(true), settleBy);
      return refused("out_of_time");
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
        return refused("unread");
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
        return { ok: true, duplicate: false, stored: false, report: viewOf(report, receivedAt, false) };
      }
      if (saved.state !== "saved") dropPhoto();
      if (saved.state === "duplicate" && saved.report.kind === "photo") {
        return { ok: true, duplicate: true, stored: true, report: viewOf(saved.report, receivedAt, true) };
      }
      // not_owner: the claim lapsed and the store says it wrote nothing.
      const stored = saved.state === "saved";
      return { ok: true, duplicate: false, stored, report: viewOf(report, receivedAt, stored) };
    } finally {
      // A settle cut off here keeps the whole reservation charged: the safe side.
      await beforeDeadline(run.settle(succeeded), settleBy);
    }
  };
}

const PHOTO_REFUSALS: Record<PhotoRefusal, { status: number; message: string }> = {
  too_large: { status: 413, message: "That photo is too large. Try a smaller one." },
  not_jpeg: { status: 415, message: "Lusong reads JPEG photos only." },
  store_down: { status: 503, message: "Lusong can't take reports right now." },
  out_of_time: { status: 503, message: OUT_OF_TIME },
  in_flight: { status: 409, message: "Lusong is already reading this photo." },
  unread: { status: 502, message: "The measuring service didn't answer. Try again in a minute." },
};

export function makeReportHandler(deps: PhotoReportDeps & { now?: () => Date }) {
  const timing = deps.timing ?? TIMING;
  const now = deps.now ?? (() => new Date());
  const processPhotoReport = makePhotoReporter(deps);

  return async function POST(request: Request): Promise<Response> {
    const receivedAt = now();
    // Epoch ms, like lib/meta.ts's deadlines. Each step must start early enough for every later one to fit.
    const deadline = Date.now() + timing.budgetMs;
    const { claimBy } = photoSchedule(deadline, timing);

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
    if (!inServerTripBound(at)) return fail(400, "Lusong takes reports from streets in the Philippines only.");
    const photo = form.get("photo");
    if (!(photo instanceof File)) return fail(400, "No photo was attached.");
    if (photo.size > MAX_BYTES) return fail(413, "That photo is too large. Try a smaller one.");

    const upload = new Uint8Array(await photo.arrayBuffer());
    const capturedAt = readCaptureTime(upload);
    const outcome = await processPhotoReport({ upload, at, capturedAt, receivedAt, admitKey: clientIp(request), deadline, publish: "when_trusted" });
    if (outcome.ok) return Response.json({ duplicate: outcome.duplicate, stored: outcome.stored, report: outcome.report });
    if (outcome.refused === "admission") return outcome.response();
    const { status, message } = PHOTO_REFUSALS[outcome.refused];
    return fail(status, message);
  };
}
