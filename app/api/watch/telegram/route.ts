import { channelFromEnv } from "@/lib/channel";
import { makeTelegramWebhook } from "@/lib/watch-handler";
import { watchStoreFromEnv } from "@/lib/watch-store";

export const POST = makeTelegramWebhook({
  secret: () => process.env.TELEGRAM_WEBHOOK_SECRET,
  store: () => watchStoreFromEnv(),
  channel: () => channelFromEnv(),
});
