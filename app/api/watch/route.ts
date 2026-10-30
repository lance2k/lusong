import { budgetFromEnv } from "@/lib/budget";
import { makeWatchHandler } from "@/lib/watch-handler";
import { watchStoreFromEnv } from "@/lib/watch-store";

/** The watcher works only once the bot, its webhook and the scheduler are all set up (docs/watcher-setup.md). */
function botUsername(): string | null {
  const env = process.env;
  const ready = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.WATCH_TICK_SECRET;
  return ready && env.TELEGRAM_BOT_USERNAME ? env.TELEGRAM_BOT_USERNAME : null;
}

/** Room for the request body's 10 s, a switch-off's wait for a send under way (up to 10 s) and the store calls. */
export const maxDuration = 30;

export const POST = makeWatchHandler({ store: () => watchStoreFromEnv(), budget: budgetFromEnv, botUsername });
