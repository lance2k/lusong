import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";
import { makeVoiceReportHandler } from "@/lib/voice-report-handler";

/** lib/voice-report-handler.ts keeps the whole request inside VOICE_TIMING.budgetMs (110 s), under this. */
export const maxDuration = 120;

export const POST = makeVoiceReportHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
