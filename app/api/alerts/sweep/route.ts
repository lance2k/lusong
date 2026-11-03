import { sweepHandlerFromEnv } from "@/lib/alerts-handler";

/** lib/sweep.ts keeps an invocation inside SWEEP_LIMITS.budgetMs (45 s): no page is started with less than its worst case left. Under this. */
export const maxDuration = 60;

export const POST = sweepHandlerFromEnv();
