import { describe, expect, it, vi } from "vitest";
import { FEED_URL } from "./advisory";
import { MemoryAdvisoryStore, readStoredSnapshot } from "./advisory-snapshot";
import { makeSnapshotHandler } from "./advisory-snapshot-handler";
import { ALL_SAVED, DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE, feedOf } from "../test/pagasa-fixtures";

const SECRET = "tick-secret_1";
const served: Record<string, string> = { [FEED_URL]: feedOf([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]), [DAVAO_GFA1_ALERT]: ALL_SAVED[DAVAO_GFA1_ALERT], [DAVAO_GFA1_UPDATE]: ALL_SAVED[DAVAO_GFA1_UPDATE] };

function setup(secret: { value: string | undefined } = { value: SECRET }) {
  const store = new MemoryAdvisoryStore();
  const fetchMock = vi.fn(async (url: string | URL) => (String(url) in served ? new Response(served[String(url)]) : Promise.reject(new TypeError("fetch failed"))));
  const handler = makeSnapshotHandler({ secret: () => secret.value, store: () => store, fetch: fetchMock as unknown as typeof fetch, now: () => new Date("2026-10-30T21:30:00+08:00") });
  return { store, fetchMock, handler };
}

const post = (auth?: string) => new Request("https://lusong.example/api/advisory/snapshot", { method: "POST", headers: auth ? { authorization: auth } : {} });

describe("POST /api/advisory/snapshot", () => {
  it("refuses a call without the tick's secret, and every call while it is unset, asking PAGASA nothing", async () => {
    const { handler, fetchMock } = setup();
    expect((await handler(post())).status).toBe(401);
    expect((await handler(post("Bearer wrong"))).status).toBe(401);
    expect((await setup({ value: undefined }).handler(post(`Bearer ${SECRET}`))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the secret, refreshes and publishes the snapshot, answering with counts only", async () => {
    const { handler, store } = setup();
    const res = await handler(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "published", complete: true, why: null, entries: 2, products: 1, fetchedAt: "2026-10-30T13:30:00.000Z" });
    expect((await readStoredSnapshot(store))!.products.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);
  });

  it("when PAGASA's feed times out twice, keeps the fresh complete snapshot and answers 503 with how old the kept one is (#59)", async () => {
    const { handler, store } = setup();
    expect((await handler(post(`Bearer ${SECRET}`))).status).toBe(200);
    const failing = makeSnapshotHandler({
      secret: () => SECRET,
      store: () => store,
      fetch: (async () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))) as unknown as typeof fetch,
      now: () => new Date("2026-10-30T21:40:00+08:00"),
    });
    const res = await failing(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      outcome: "kept",
      complete: true,
      why: "feed: The operation was aborted due to timeout",
      entries: 2,
      products: 1,
      fetchedAt: "2026-10-30T13:30:00.000Z",
      keptMinutes: 10,
    });
    expect((await readStoredSnapshot(store))!.fetchedAt).toBe("2026-10-30T13:30:00.000Z");
  });
});
