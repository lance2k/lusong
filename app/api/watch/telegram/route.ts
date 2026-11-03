import { channelFromEnv } from "@/lib/channel";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";
import { telegramReportsFromEnv } from "@/lib/telegram-reports";
import { makeTelegramWebhook } from "@/lib/watch-handler";
import { watchStoreFromEnv } from "@/lib/watch-store";

/** lib/telegram-reports.ts handles a report update within WEBHOOK_BUDGET_MS (100 s), under this. */
export const maxDuration = 120;

export const POST = makeTelegramWebhook({
  secret: () => process.env.TELEGRAM_WEBHOOK_SECRET,
  store: () => watchStoreFromEnv(),
  channel: () => channelFromEnv(),
  reports: () => telegramReportsFromEnv({ gate: () => makeValhallaGate(slotStoreFromEnv()) }),
});
