import { makeCommuteHandler } from "@/lib/commute-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";

/** PAGASA's reading is bounded at 15 s and routing at two 10 s attempts plus the 4 s slot wait. */
export const maxDuration = 60;

export const POST = makeCommuteHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
