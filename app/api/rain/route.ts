import { sharedRain, type RainStatus } from "../../../lib/rain";

export const maxDuration = 10;

const HTTP_STATUS: Record<RainStatus, number> = { ok: 200, refused: 400, paused: 503, down: 502 };

export async function GET(request: Request) {
  const reply = await sharedRain().rain(new URL(request.url).searchParams.get("bbox"));
  return Response.json(reply, {
    status: HTTP_STATUS[reply.status],
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
