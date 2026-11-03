import { placesDepsFromEnv, roundBias, searchPlaces } from "@/lib/places";

export const maxDuration = 15;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deps = placesDepsFromEnv();
  const bias = roundBias(url.searchParams.get("lat"), url.searchParams.get("lon"), deps.bound);
  const reply = await searchPlaces(url.searchParams.get("q"), bias, deps);
  return Response.json(reply, { headers: { "Cache-Control": "no-store" } });
}
