import { makeCommuteHandler } from "@/lib/commute-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";

/** lib/commute-handler.ts keeps the whole check inside COMMUTE_TIMING.budgetMs (50 s), under this. */
export const maxDuration = 60;

export const POST = makeCommuteHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
