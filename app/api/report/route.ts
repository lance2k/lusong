import { makeReportHandler } from "@/lib/report-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";

/** lib/report-handler.ts keeps the whole request inside REQUEST_BUDGET_MS (110 s), under this. */
export const maxDuration = 120;

export const POST = makeReportHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
