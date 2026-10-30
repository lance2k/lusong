import type { ReportStore, Saved, StoredReport } from "../lib/report-store";

/** Stores a report the way a report route does: its media's hash claimed first, then saved under that claim. */
export async function seedReport(store: ReportStore, report: StoredReport): Promise<Saved> {
  const claim = report.kind === "voice" ? await store.claimVoice(report.audioHash) : await store.claimPhoto(report.photoHash);
  if (claim.state !== "claimed") throw new Error(`seedReport: the ${report.kind}'s hash is already ${claim.state}`);
  return store.save(report, claim.token);
}
