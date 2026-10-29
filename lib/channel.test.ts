import { describe, expect, it, vi } from "vitest";
import { channelFromEnv, TelegramChannel } from "./channel";

/** No request leaves the test: every call is answered here. */
function fakeTelegram(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("the Telegram channel (no real call: fetch is faked)", () => {
  it("sends one text message to the chat through the Bot API's sendMessage, with link previews off", async () => {
    const fetch = fakeTelegram(200, { ok: true, result: { message_id: 1 } });
    const result = await new TelegramChannel("TEST-TOKEN", fetch as unknown as typeof globalThis.fetch).send("4242", "Go");
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botTEST-TOKEN/sendMessage");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ chat_id: "4242", text: "Go", link_preview_options: { is_disabled: true } });
  });

  it("calls a 403 permanent: the rider has blocked the bot", async () => {
    const fetch = fakeTelegram(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    expect(await new TelegramChannel("T", fetch as unknown as typeof globalThis.fetch).send("1", "x")).toEqual({ ok: false, permanent: true });
  });

  it.each([
    ["a 429", 429, { ok: false, error_code: 429, parameters: { retry_after: 3 } }],
    ["a 500", 500, { ok: false }],
    ["a 200 that isn't ok", 200, { ok: false }],
  ])("calls %s worth another try", async (_label, status, body) => {
    const fetch = fakeTelegram(status, body);
    expect(await new TelegramChannel("T", fetch as unknown as typeof globalThis.fetch).send("1", "x")).toEqual({ ok: false, permanent: false });
  });

  it("calls a dropped connection worth another try, and never throws", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await new TelegramChannel("T", fetch as unknown as typeof globalThis.fetch).send("1", "x")).toEqual({ ok: false, permanent: false });
  });

  it("is missing without a bot token", () => {
    expect(channelFromEnv({})).toBeNull();
    expect(channelFromEnv({ TELEGRAM_BOT_TOKEN: "T" })).toBeInstanceOf(TelegramChannel);
  });
});
