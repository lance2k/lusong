export type SendResult = { ok: true } | { ok: false; permanent: boolean };

/** Where a watcher's messages go. */
export interface Channel {
  /** Never throws. `permanent` means the chat can't be messaged again, so the watcher should be switched off. */
  send(chatId: string, text: string): Promise<SendResult>;
}

/**
 * Telegram's Bot API, written from core.telegram.org/bots/api (sendMessage, LinkPreviewOptions), never called in tests.
 * Keep under one message per second per chat (core.telegram.org/bots/faq): a tick sends at most one per watcher.
 */
export class TelegramChannel implements Channel {
  constructor(
    private readonly token: string,
    private readonly doFetch: typeof fetch = (...args) => fetch(...args),
  ) {}

  async send(chatId: string, text: string): Promise<SendResult> {
    try {
      const res = await this.doFetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json().catch(() => null)) as { ok?: unknown; description?: unknown } | null;
      if (res.ok && body?.ok === true) return { ok: true };
      // The URL holds the bot token, so only the status and Telegram's description are logged.
      console.error(`Telegram sendMessage HTTP ${res.status}: ${typeof body?.description === "string" ? body.description : "no description"}`);
      // UNVERIFIED: that a blocked bot or a deleted chat answers 403. The docs say only that error_code "is subject to change".
      return { ok: false, permanent: res.status === 403 };
    } catch (err) {
      console.error("Telegram unreachable:", err instanceof Error ? err.name : "error");
      return { ok: false, permanent: false };
    }
  }
}

export function channelFromEnv(env: Record<string, string | undefined> = process.env): Channel | null {
  return env.TELEGRAM_BOT_TOKEN ? new TelegramChannel(env.TELEGRAM_BOT_TOKEN) : null;
}
