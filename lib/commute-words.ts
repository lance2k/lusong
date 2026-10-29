import type { Verdict } from "./verdict";

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
