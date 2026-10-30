import type { Verdict } from "./verdict";
import type { VoiceClaim, VoiceSays } from "./voice-claim";

/**
 * Depth by body part, the way Cebu news describes floods. Each word covers depths up to its bound in cm, set from
 * the MMDA gauge's body anchors (half-knee 25, knee 48, waist 94, chest 114) and lib/verdict.ts's landmark rows.
 */
const BODY_WORDS: readonly [number, string][] = [
  [10, "ankle"],
  [27, "half-knee"],
  [54, "knee"],
  [72, "thigh"],
  [112, "waist"],
  [Infinity, "chest"],
];

function bodyWord(cm: number): string {
  return BODY_WORDS.find(([upTo]) => cm <= upTo)![1];
}

export function depthWords(v: Verdict): string {
  if (v.kind === "no_flood") return "no flood water seen";
  if (v.kind === "cannot_measure") return "depth not measured";
  const { low, high } = v.rangeCm;
  const from = bodyWord(low);
  const to = bodyWord(high);
  return `${from === to ? `${to}-deep` : `${from}- to ${to}-deep`} (${low}–${high} cm)`;
}

export const MMDA_CREDIT =
  "The passability lines are from Metro Manila's MMDA flood gauge. Cebu has no gauge of its own that Lusong found.";

export function passabilityLine(v: Verdict): string {
  if (v.kind === "no_flood") return "No flood water in the photo";
  if (v.kind === "cannot_measure") return "Lusong couldn't measure the water in this photo";
  switch (v.passability) {
    case "NPLV":
      return "Not passable to light vehicles (MMDA gauge, Metro Manila)";
    case "NPATV":
      return "Not passable to any vehicle (MMDA gauge, Metro Manila)";
    case "shallow":
      return "Shallow, but Lusong doesn't count it as safe: it has read knee-deep water as shallow before";
    case "unsure":
      return "Lusong couldn't tell how deep";
  }
}

export function ageWords(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "just now";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min ago`;
  return m === 0 ? `${h} h ago` : `${h} h ${m} min ago`;
}

const PHT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function phtTime(iso: string): string {
  const parts = Object.fromEntries(PHT.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const period = parts.dayPeriod.toLowerCase().startsWith("a") ? "a.m." : "p.m.";
  return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${period} PHT`;
}

/** The detour's extra distance and time, against the plain route, in one phrase. */
export function detourWords(extra: { extraKm: number; extraMin: number }): string {
  const longer = (n: number) => (n > 0 ? "longer" : "shorter");
  const km = `${Math.abs(extra.extraKm).toFixed(1)} km`;
  const min = `${Math.abs(extra.extraMin)} min`;
  const usual = "than your usual way";
  if (extra.extraMin === 0) return `${km} ${longer(extra.extraKm)} ${usual}, about the same time`;
  if (extra.extraKm === 0) return `${min} ${longer(extra.extraMin)} ${usual}, about the same distance`;
  if (Math.sign(extra.extraKm) === Math.sign(extra.extraMin)) return `${km} and ${min} ${longer(extra.extraKm)} ${usual}`;
  return `${km} ${longer(extra.extraKm)} and ${min} ${longer(extra.extraMin)} ${usual}`;
}

const VOICE_DEPTH_WORDS: Record<VoiceClaim["depth"], string | null> = {
  dry: "no flood water",
  below_knee: "below the knee",
  knee_or_deeper: "knee-deep or deeper",
  not_said: null,
};

export function voiceDepthWords(depth: VoiceClaim["depth"]): string | null {
  return VOICE_DEPTH_WORDS[depth];
}

export function voicePassabilityLine(says: VoiceSays): string {
  switch (says) {
    case "knee_deep_or_deeper":
    case "not_passable":
      return "Not passable, says a voice report";
    case "passable":
      return "Passable, says a voice report, but only a recent photo can mark a street clear";
    case "unsure":
      return "A voice report that doesn't say whether vehicles can pass";
  }
}

/** What Lusong understood from the reporter's own note, as one fixed sentence. */
export function voiceHeard(claim: VoiceClaim): string {
  const depth = { dry: "there is no flood water", below_knee: "the water is below the knee", knee_or_deeper: "the water is knee-deep or deeper", not_said: null }[claim.depth];
  const pass = { yes: "vehicles can pass", no: "vehicles can't pass", not_said: null }[claim.passable];
  const parts = [depth, pass].filter((p) => p !== null);
  if (parts.length === 0) return "Lusong couldn't tell from your note how deep the water is or whether vehicles can pass.";
  return `Lusong heard that ${parts.join(" and ")}.`;
}
