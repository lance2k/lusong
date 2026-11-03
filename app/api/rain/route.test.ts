import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LIVE: unknown = JSON.parse(
  (await import("node:fs")).readFileSync("test/fixtures/open-meteo/grid-3x3-metro-manila.json", "utf8"),
);

async function get(bbox?: string) {
  const { GET } = await import("./route");
  const url = `http://lusong.test/api/rain${bbox === undefined ? "" : `?bbox=${bbox}`}`;
  return GET(new Request(url));
}

describe("GET /api/rain", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers 200 with the reply shape and a five-minute public cache", async () => {
    const f = vi.fn(async () => Response.json(LIVE));
    vi.stubGlobal("fetch", f);
    const res = await get("14.5,120.9,14.7,121.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["credit", "modelTime", "points", "status"]);
    expect(body).toMatchObject({
      status: "ok",
      modelTime: "2026-11-03T15:00:00.000Z",
      credit: "Rain now: model estimate, Open-Meteo (CC BY 4.0)",
    });
    expect(body.points).toHaveLength(9);
    expect(Object.keys(body.points[0]).sort()).toEqual(["lat", "lon", "mm"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("answers 400 refused for a missing, malformed, wide or foreign box, without calling Open-Meteo", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const bbox of [undefined, "x", "12,120,16,121", "35.5,139.5,35.9,139.9"]) {
      const res = await get(bbox);
      expect(res.status, String(bbox)).toBe(400);
      expect((await res.json()).status).toBe("refused");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("answers 502 down when Open-Meteo fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const res = await get("14.5,120.9,14.7,121.1");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "down", points: [], modelTime: null });
  });

  it("answers 503 paused after 300 calls in an hour", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const n = new URL(url).searchParams.get("latitude")!.split(",").length;
      return Response.json(Array.from({ length: n }, () => ({ current: { time: "2026-11-03T15:00", precipitation: 0 } })));
    }));
    for (let i = 0; i < 300; i++) {
      const lat = 5 + Math.floor(i / 40) * 0.5;
      const lon = 117 + (i % 40) * 0.2;
      const bbox = [lat, lon, lat + 0.01, lon + 0.01].map((v) => v.toFixed(2)).join(",");
      expect((await get(bbox)).status).toBe(200);
    }
    const res = await get("20,120,20.1,120.1");
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("paused");
  });
});
