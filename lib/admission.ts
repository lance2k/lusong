import type { Budget, RefusalReason } from "./budget";
import { Meter } from "./meta";

const REFUSALS: Record<RefusalReason, { status: number; message: string }> = {
  budget: { status: 503, message: "Today's free checks are used up. They start again at 8:00 a.m. Philippine time." },
  ip: { status: 429, message: "You've used today's checks. They start again at 8:00 a.m. Philippine time." },
  unavailable: { status: 503, message: "Lusong can't take new checks right now." },
};

/** One admitted run: pass `meter` to every Meta call it makes, then settle it once. */
export interface AdmittedRun {
  readonly meter: Meter;
  /** Refunds the reservation down to the metered cost when the run succeeded and every call was
   *  fully metered; otherwise keeps it all. Never throws; calls after the first do nothing. */
  settle(succeeded: boolean): Promise<void>;
}

export type AdmissionResult =
  | { ok: true; run: AdmittedRun }
  | { ok: false; reason: RefusalReason; response(): Response };

/**
 * Reserves `reserveMicros`, the run's worst case with every retry used, against the daily spending
 * cap. A null `clientIp` is a run no client asked for, such as a scheduled watcher run: it counts
 * against the cap and against no address's limit.
 */
export async function admit(
  budget: Budget,
  request: { clientIp: string | null; reserveMicros: number; now: Date },
): Promise<AdmissionResult> {
  const admission = await budget.admit(request.clientIp, request.now, request.reserveMicros);
  if (!admission.ok) {
    const { reason } = admission;
    const { status, message } = REFUSALS[reason];
    return { ok: false, reason, response: () => Response.json({ error: message, reason }, { status }) };
  }
  const meter = new Meter();
  let settled = false;
  return {
    ok: true,
    run: {
      meter,
      async settle(succeeded) {
        if (settled) return;
        settled = true;
        await budget.settle(admission, meter.usage(), succeeded);
      },
    },
  };
}
