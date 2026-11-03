import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

describe("GET /api/closures", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "VERCEL"]) vi.stubEnv(k, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers 503 paused without a store, with a one-minute public cache", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({ status: "paused", marks: [], lifetimeHours: 12 });
  });

  it("answers 200 with the sweep's live reports from the store", async () => {
    vi.stubEnv("LUSONG_BUDGET_STORE", "memory");
    const { alertStoreFromEnv } = await import("../../../lib/alerts");
    const now = Date.now();
    await alertStoreFromEnv()!.addIfAbsent([
      {
        id: "sweep:x",
        version: 1,
        kind: "closure",
        scope: { point: { lat: 10.31, lon: 123.89 }, radiusM: 500 },
        sourceUrl: "https://news.example.ph/x",
        sourceOrg: "the MMDA",
        eventAt: new Date(now - 3_600_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        severity: "warn",
        origin: "sweep",
        fields: { place: "Osmeña Boulevard, Cebu City", posted: new Date(now - 3_600_000).toISOString(), words: "closure" },
      },
    ]);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marks.map((m: { id: string }) => m.id)).toEqual(["sweep:x"]);
  });
});
