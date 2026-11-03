import { makeTripTextHandler } from "@/lib/trip-text-handler";

/** lib/trip-text-handler.ts keeps the whole request inside TRIP_TEXT_TIMING.totalMs (40 s), under this. */
export const maxDuration = 45;

export const POST = makeTripTextHandler();
