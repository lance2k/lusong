import { deliverHandlerFromEnv } from "@/lib/alerts-handler";

/** lib/alert-delivery.ts keeps a run inside DELIVERY_LIMITS.budgetMs (45 s), under this. */
export const maxDuration = 60;

export const POST = deliverHandlerFromEnv();
