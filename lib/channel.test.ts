import { describe, expect, it, vi } from "vitest";
import { channelFromEnv, TelegramChannel } from "./channel";

/** No request leaves the test: every call is answered here. */
function fakeTelegram(status: number, body: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("the Telegram channel (no real call: fetch is faked)", () => {
  it("sends one text message to the chat through the Bot API's sendMessage, with link previews off", async () => {
    const fetch = fakeTelegram(200, { ok: true, result: { message_id: 1 } });
    const result = await new TelegramChannel("TEST-TOKEN", fetch).send("4242", "Go");
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botTEST-TOKEN/sendMessage");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ chat_id: "4242", text: "Go", link_preview_options: { is_disabled: true } });
  });

  it("calls a 403 a refusal for good: the rider has blocked the bot", async () => {
    const fetch = fakeTelegram(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    expect(await new TelegramChannel("T", fetch).send("1", "x")).toEqual({ ok: false, rejected: true, permanent: true });
  });

  it("calls a 429 or a 400 a refusal worth another try: Telegram answered and didn't take the message", async () => {
    for (const status of [429, 400]) {
      const fetch = fakeTelegram(status, { ok: false, error_code: status });
      expect(await new TelegramChannel("T", fetch).send("1", "x")).toEqual({ ok: false, rejected: true, permanent: false });
    }
  });

  it.each([
    ["a 500", 500, { ok: false }],
    ["a 502 from a gateway", 502, "<html>Bad Gateway</html>"],
    ["a 200 that isn't ok", 200, { ok: false }],
  ])("calls %s uncertain: the message may have been delivered", async (_label, status, body) => {
    const fetch = fakeTelegram(status, body);
    expect(await new TelegramChannel("T", fetch).send("1", "x")).toEqual({ ok: false, rejected: false });
  });

  it("calls a dropped connection or a timeout uncertain, and never throws", async () => {
    for (const error of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw error;
      });
      expect(await new TelegramChannel("T", fetch).send("1", "x")).toEqual({ ok: false, rejected: false });
    }
  });

  it("is missing without a bot token", () => {
    expect(channelFromEnv({})).toBeNull();
    expect(channelFromEnv({ TELEGRAM_BOT_TOKEN: "T" })).toBeInstanceOf(TelegramChannel);
  });
});
