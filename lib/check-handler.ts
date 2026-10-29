import { admit } from "./admission";
import { budgetFromEnv, RESERVE_MICROS, type Budget } from "./budget";
import { checkPhoto, forPage } from "./check";
import { JpegError, sanitizeJpeg } from "./jpeg";
import { MetaApiError } from "./meta";

const MAX_BYTES = 3 * 1024 * 1024;
/** The page shrinks every photo to this; the budget's input-token bound was measured at this size. */
const MAX_SIDE = 1600;

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

    const admission = await admit(deps.budget(), { clientIp: clientIp(request), reserveMicros: RESERVE_MICROS, now: now() });
    if (!admission.ok) return admission.response();

    const { run } = admission;
    let succeeded = false;
    try {
      const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
      const result = await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }, run.meter);
      succeeded = true;
      return Response.json(forPage(result));
    } catch (err) {
      console.error("check failed:", err instanceof MetaApiError ? err.message : err);
      return fail(502, "The measuring service didn't answer. Try again in a minute.");
    } finally {
      await run.settle(succeeded);
    }
  };
}
