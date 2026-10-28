import { budgetFromEnv, type Budget, type RefusalReason } from "./budget";
import { checkPhoto } from "./check";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { Meter, MetaApiError } from "./meta";

const MAX_BYTES = 3 * 1024 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
const MAX_SIDE = 1600;

const REFUSALS: Record<RefusalReason, { status: number; message: string }> = {
  budget: { status: 503, message: "Today's free checks are used up. They start again at 8:00 a.m. Philippine time." },
  ip: { status: 429, message: "You've used today's checks. They start again at 8:00 a.m. Philippine time." },
  unavailable: { status: 503, message: "Lusong can't take new checks right now." },
};

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** Vercel overwrites X-Forwarded-For with the client's address (docs, request headers). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function makeCheckHandler(deps: { budget: () => Budget; now?: () => Date } = { budget: budgetFromEnv }) {
  const now = deps.now ?? (() => new Date());

  return async function POST(request: Request): Promise<Response> {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "Send the photo as a form upload.");
    }
    const photo = form.get("photo");
    if (!(photo instanceof File)) return fail(400, "No photo was attached.");
    if (photo.size > MAX_BYTES) return fail(413, "That photo is too large. Try a smaller one.");

    let jpeg: ReturnType<typeof sanitizeJpeg>;
    try {
      jpeg = sanitizeJpeg(new Uint8Array(await photo.arrayBuffer()));
    } catch (err) {
      if (err instanceof JpegError) return fail(415, "Lusong reads JPEG photos only.");
      throw err;
    }
    if (jpeg.width > MAX_SIDE || jpeg.height > MAX_SIDE) return fail(413, "That photo is too large. Try a smaller one.");

    const budget = deps.budget();
    const admission = await budget.admit(clientIp(request), now());
    if (!admission.ok) {
      const refusal = REFUSALS[admission.reason];
      return Response.json({ error: refusal.message, reason: admission.reason }, { status: refusal.status });
    }

    const meter = new Meter();
    let succeeded = false;
    try {
      const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
      const result = await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }, meter);
      succeeded = true;
      return Response.json(result);
    } catch (err) {
      console.error("check failed:", err instanceof MetaApiError ? err.message : err);
      return fail(502, "The measuring service didn't answer. Try again in a minute.");
    } finally {
      await budget.settle(admission, meter.usage(), succeeded);
    }
  };
}
