import { beforeDeadline } from "./deadline";

export type Download = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "too_slow" | "failed" };

/** Where the bot fetches a photo or voice note a rider sent. */
export interface TelegramFiles {
  /** Never throws. Gives up past `maxBytes` (stated or received) or once `deadline` (epoch ms) passes. */
  download(fileId: string, opts: { maxBytes: number; deadline: number }): Promise<Download>;
}

/**
 * getFile and the file URL from core.telegram.org/bots/api ("Use https://api.telegram.org/file/bot<token>/<file_path>
 * to get the file"). Both URLs hold the bot token, so neither is ever logged.
 */
export class TelegramFileApi implements TelegramFiles {
  constructor(
    private readonly token: string,
    private readonly doFetch: typeof fetch = (...args) => fetch(...args),
  ) {}

  async download(fileId: string, opts: { maxBytes: number; deadline: number }): Promise<Download> {
    const signal = AbortSignal.timeout(Math.max(0, opts.deadline - Date.now()));
    try {
      const res = await this.doFetch(`https://api.telegram.org/bot${this.token}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal,
      });
      const body = (await res.json().catch(() => null)) as { ok?: unknown; result?: { file_path?: unknown; file_size?: unknown } } | null;
      const path = body?.result?.file_path;
      if (!res.ok || body?.ok !== true || typeof path !== "string") {
        console.error(`Telegram getFile HTTP ${res.status}`);
        return { ok: false, reason: "failed" };
      }
      const stated = body.result?.file_size;
      if (typeof stated === "number" && stated > opts.maxBytes) return { ok: false, reason: "too_large" };

      const file = await this.doFetch(`https://api.telegram.org/file/bot${this.token}/${path}`, { signal });
      if (!file.ok || !file.body) {
        console.error(`Telegram file download HTTP ${file.status}`);
        return { ok: false, reason: "failed" };
      }
      return await readCapped(file.body, opts);
    } catch (err) {
      if (Date.now() >= opts.deadline) return { ok: false, reason: "too_slow" };
      console.error("Telegram file download failed:", err instanceof Error ? err.name : "error");
      return { ok: false, reason: "failed" };
    }
  }
}

/** Reads a stream to its end, cut off past `maxBytes` whatever the sender said its size was. */
async function readCapped(stream: ReadableStream<Uint8Array>, opts: { maxBytes: number; deadline: number }): Promise<Download> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read(), opts.deadline);
      if (next === "late") return { ok: false, reason: "too_slow" };
      if (next.done) break;
      size += next.value.length;
      if (size > opts.maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(next.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes: out };
}

export function telegramFilesFromEnv(env: Record<string, string | undefined> = process.env): TelegramFiles | null {
  return env.TELEGRAM_BOT_TOKEN ? new TelegramFileApi(env.TELEGRAM_BOT_TOKEN) : null;
}
