import { makeTripTextHandler } from "@/lib/trip-text-handler";

/** lib/trip-text-handler.ts gives the model 25 s and Photon about 7 s after it. */
export const maxDuration = 45;

export const POST = makeTripTextHandler();
