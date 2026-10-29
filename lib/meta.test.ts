import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Meter, MetaApiError, segment } from "./meta";

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
    const result = segment("data:image/jpeg;base64,", "person", 30_000, new Meter());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails instead of retrying early when Retry-After does not fit before the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(busy("60"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await segment("data:image/jpeg;base64,", "person", 30_000, new Meter()).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain("upstream detail");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an HTTP-date Retry-After: fails when it lands past the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(busy(new Date(60_000).toUTCString()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(segment("data:image/jpeg;base64,", "person", 30_000, new Meter())).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an HTTP-date Retry-After: waits for it when it fits", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(busy(new Date(5_000).toUTCString())).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const result = segment("data:image/jpeg;base64,", "person", 30_000, new Meter());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives an attempt no more time than the deadline leaves", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    await segment("data:image/jpeg;base64,", "person", 5_000, new Meter());
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it("does not start when the deadline has passed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(segment("data:image/jpeg;base64,", "person", -1, new Meter())).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the meter reads each operation's usage", () => {
  const sparkResponse = (usage: object | null, output: object[] = [{ type: "message" }]) => ({
    output,
    ...(usage ? { usage } : {}),
  });

  it("a Muse Spark reply from the Responses API is metered by its tokens, not as SAM images", () => {
    const meter = new Meter();
    meter.reply("spark-responses", sparkResponse({ input_tokens: 2_000, output_tokens: 3_000, images_processed: 1 }));
    expect(meter.usage()).toEqual({ samImages: 0, museInputTokens: 2_000, museOutputTokens: 3_000, transcribeSeconds: 0, complete: true });
  });

  it("a SAM reply is metered by its images, not its tokens", () => {
    const meter = new Meter();
    meter.reply("sam", { usage: { input_tokens: 0, output_tokens: 0, images_processed: 1 } });
    expect(meter.usage()).toEqual({ samImages: 1, museInputTokens: 0, museOutputTokens: 0, transcribeSeconds: 0, complete: true });
  });

  it("a Muse Spark chat reply is metered by its prompt and completion tokens", () => {
    const meter = new Meter();
    meter.reply("spark-chat", { usage: { prompt_tokens: 2_000, completion_tokens: 3_000 } });
    expect(meter.usage()).toEqual({ samImages: 0, museInputTokens: 2_000, museOutputTokens: 3_000, transcribeSeconds: 0, complete: true });
  });

  it("a Responses-API Spark reply without usage, or with only part of it, is not a complete count", () => {
    for (const usage of [null, { input_tokens: 2_000 }, { input_tokens: 2_000, output_tokens: "3000" }]) {
      const meter = new Meter();
      meter.reply("spark-responses", sparkResponse(usage));
      expect(meter.usage().complete).toBe(false);
    }
  });

  it("the tokens a partial usage block does report still count, so an overrun is charged", () => {
    const meter = new Meter();
    meter.reply("spark-responses", sparkResponse({ input_tokens: 2_000 }));
    expect(meter.usage()).toEqual({ samImages: 0, museInputTokens: 2_000, museOutputTokens: 0, transcribeSeconds: 0, complete: false });
  });

  it("a Spark reply that ran a tool with no price yet, such as web_search, is not a complete count", () => {
    const meter = new Meter();
    meter.reply(
      "spark-responses",
      sparkResponse({ input_tokens: 2_000, output_tokens: 3_000 }, [{ type: "web_search_call" }, { type: "message" }]),
    );
    expect(meter.usage().complete).toBe(false);
  });

  it("a Spark reply whose output is missing or not a list is not a complete count, and its tokens still count", () => {
    for (const body of [
      { usage: { input_tokens: 2_000, output_tokens: 3_000 } },
      { output: { type: "message" }, usage: { input_tokens: 2_000, output_tokens: 3_000 } },
      { output: null, usage: { input_tokens: 2_000, output_tokens: 3_000 } },
    ]) {
      const meter = new Meter();
      meter.reply("spark-responses", body);
      expect(meter.usage()).toEqual({ samImages: 0, museInputTokens: 2_000, museOutputTokens: 3_000, transcribeSeconds: 0, complete: false });
    }
  });

  it("a Voice Transcribe reply is metered in whole seconds of audio, rounded down, and never as a complete count", () => {
    const meter = new Meter();
    meter.reply("voice-transcribe", { sessionId: "s", transcript: "baha", audioDurationMs: 12_999, turns: [] });
    expect(meter.usage()).toEqual({ samImages: 0, museInputTokens: 0, museOutputTokens: 0, transcribeSeconds: 12, complete: false });
  });

  it("a Voice Transcribe reply without a duration counts no seconds and is not a complete count", () => {
    for (const body of [{ transcript: "baha" }, { transcript: "baha", audioDurationMs: -5 }, { audioDurationMs: "12000" }, null]) {
      const meter = new Meter();
      meter.reply("voice-transcribe", body);
      expect(meter.usage()).toMatchObject({ transcribeSeconds: 0, complete: false });
    }
  });

  it("reasoning and function calls are paid for in tokens, so they keep the count complete", () => {
    const meter = new Meter();
    meter.reply(
      "spark-responses",
      sparkResponse({ input_tokens: 10, output_tokens: 20 }, [{ type: "reasoning" }, { type: "function_call" }, { type: "message" }]),
    );
    expect(meter.usage().complete).toBe(true);
  });
});
