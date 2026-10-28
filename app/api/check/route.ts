import { checkPhoto } from "@/lib/check";
import { JpegError, sanitizeJpeg } from "@/lib/jpeg";
import { MetaApiError } from "@/lib/meta";

/** The pipeline stops itself at PIPELINE_BUDGET_MS (lib/check.ts); this leaves headroom past it. */
export const maxDuration = 120;

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 4096;

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
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

  const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
  try {
    return Response.json(await checkPhoto(imageDataUrl, { width: jpeg.width, height: jpeg.height }));
  } catch (err) {
    console.error("check failed:", err instanceof MetaApiError ? err.message : err);
    return fail(502, "The measuring service didn't answer. Try again in a minute.");
  }
}
