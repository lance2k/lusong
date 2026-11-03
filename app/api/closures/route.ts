import { connection } from "next/server";
import { closuresFromEnv, type ClosuresStatus } from "../../../lib/closure-marks";

export const maxDuration = 10;

const HTTP_STATUS: Record<ClosuresStatus, number> = { ok: 200, paused: 503, down: 502 };

export async function GET() {
  // Read per request: with cacheComponents on, a GET that reads nothing from the request could be prerendered at build.
  await connection();
  const reply = await closuresFromEnv();
  return Response.json(reply, {
    status: HTTP_STATUS[reply.status],
    // Expected to spare the database most reads; not a bound (S3cP-6).
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
