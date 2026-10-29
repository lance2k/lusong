import type { Channel, SendResult } from "../lib/channel";

/** Records every message instead of sending it; `next` sets what the following sends report. */
export class FakeChannel implements Channel {
  readonly sent: { chatId: string; text: string }[] = [];
  next: SendResult[] = [];

  async send(chatId: string, text: string): Promise<SendResult> {
    const result = this.next.shift() ?? { ok: true };
    if (result.ok) this.sent.push({ chatId, text });
    return result;
  }
}
