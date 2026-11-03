import { closuresFromEnv, type ClosuresStatus } from "../../../lib/closure-marks";

export const dynamic = "force-dynamic";

const HTTP_STATUS: Record<ClosuresStatus, number> = { ok: 200, paused: 503, down: 502 };

export async function GET() {
  const reply = await closuresFromEnv();
  return Response.json(reply, {
    status: HTTP_STATUS[reply.status],
    // Expected to spare the database most reads; not a bound (S3cP-6).
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
