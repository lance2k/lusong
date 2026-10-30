import { makeCommuteCheck } from "@/lib/commute-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";
import { makeTickHandler, tickFromEnv } from "@/lib/watch-handler";

/** lib/watch-tick.ts keeps the whole tick inside TICK_LIMITS.budgetMs (45 s), under this. */
export const maxDuration = 60;

const commute = makeCommuteCheck({ gate: () => makeValhallaGate(slotStoreFromEnv()) });

export const POST = makeTickHandler({ secret: () => process.env.WATCH_TICK_SECRET, tick: tickFromEnv(commute.checkTrip) });
