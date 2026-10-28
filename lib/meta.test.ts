import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError, segment } from "./meta";

const ok = () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "" }] }] }), { status: 200 });
const busy = (retryAfter?: string) =>
  new Response("upstream detail that must not leak", { status: 503, headers: retryAfter ? { "retry-after": retryAfter } : {} });

describe("postJson retries within one deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.MODEL_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries once after a short Retry-After and succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(busy("1")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const result = segment("data:image/jpeg;base64,", "person", 30_000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails instead of retrying early when Retry-After does not fit before the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(busy("60"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await segment("data:image/jpeg;base64,", "person", 30_000).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain("upstream detail");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an HTTP-date Retry-After: fails when it lands past the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(busy(new Date(60_000).toUTCString()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(segment("data:image/jpeg;base64,", "person", 30_000)).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an HTTP-date Retry-After: waits for it when it fits", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(busy(new Date(5_000).toUTCString())).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const result = segment("data:image/jpeg;base64,", "person", 30_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives an attempt no more time than the deadline leaves", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    await segment("data:image/jpeg;base64,", "person", 5_000);
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it("does not start when the deadline has passed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(segment("data:image/jpeg;base64,", "person", -1)).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
