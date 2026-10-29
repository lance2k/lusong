import { makeReportHandler } from "@/lib/report-handler";
import { makeValhallaGate, slotStoreFromEnv } from "@/lib/router";

/** The photo read stops itself at PIPELINE_BUDGET_MS (lib/check.ts); /locate adds the 4 s slot wait and 10 s. */
export const maxDuration = 120;

export const POST = makeReportHandler({ gate: () => makeValhallaGate(slotStoreFromEnv()) });
