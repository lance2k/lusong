import { snapshotHandlerFromEnv } from "@/lib/advisory-snapshot-handler";

/** A snapshot ends within SNAPSHOT_LIMITS.deadlineMs (45 s), under this. */
export const maxDuration = 60;

export const POST = snapshotHandlerFromEnv();
