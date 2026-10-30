import { makeCommuteHandler } from "@/lib/commute-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";

/** COMMUTE_DEADLINE_MS (80 s) for the whole check, Muse Spark included, plus SETTLE_ROOM_MS to settle the budget. */
export const maxDuration = 90;

export const POST = makeCommuteHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
