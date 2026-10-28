import { makeCheckHandler } from "@/lib/check-handler";

/** The pipeline stops itself at PIPELINE_BUDGET_MS (lib/check.ts); this leaves headroom past it. */
export const maxDuration = 120;

export const POST = makeCheckHandler();
