import type { ReportView } from "../lib/report-handler";
import type { VoiceReportView } from "../lib/voice-report-handler";

/** Told as a toast when a photo report finishes while the rider is elsewhere: the reading's own lines. */
export function photoOutcomeLine(outcome: { report: Pick<ReportView, "passability" | "effect"> } | { message: string }): string {
  return "report" in outcome ? `Lusong read your photo: ${outcome.report.passability}. ${outcome.report.effect}` : outcome.message;
}

/** The same for a voice note. */
export function voiceOutcomeLine(outcome: { report: Pick<VoiceReportView, "heard" | "effect"> } | { message: string }): string {
  return "report" in outcome ? `${outcome.report.heard} ${outcome.report.effect}` : outcome.message;
}

/** Said when the rider leaves the Report view mid-recording: the note is dropped, never sent half-made. */
export const RECORDING_STOPPED_LINE = "Recording stopped; nothing was sent.";
