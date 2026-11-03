import type { Place } from "./built-in-places";

/** The typed box's limits: a sentence like "Talamban to IT Park, leaving around 7" is under 40 characters. */
export const TRIP_TEXT_MIN = 3;
export const TRIP_TEXT_MAX = 160;
/** Candidates the reply carries for each end. */
export const TRIP_TEXT_CANDIDATES = 3;
/** Typed trips one address may send per UTC day, apart from its daily checks. */
export const TRIP_TEXT_PER_IP_DAILY = 20;

/** Why a typed trip gave no candidates. The page words each one itself; the server sends only the id. */
export const TRIP_TEXT_REASONS = ["text", "model", "budget", "ip", "unavailable", "no_place", "search"] as const;
export type TripTextReason = (typeof TRIP_TEXT_REASONS)[number];

export const TO_THE_BOXES = "Search From and To in the boxes below instead.";

export const TRIP_TEXT_LINES: Record<TripTextReason, string> = {
  text: `Type your trip in ${TRIP_TEXT_MIN} to ${TRIP_TEXT_MAX} characters, like “Talamban to IT Park, leaving around 7”.`,
  model: `Lusong couldn't read that trip just now. ${TO_THE_BOXES}`,
  budget: `Lusong can't read typed trips for the rest of today. ${TO_THE_BOXES}`,
  ip: `You've typed today's ${TRIP_TEXT_PER_IP_DAILY} trips. They start again at 8:00 a.m. Philippine time. ${TO_THE_BOXES}`,
  unavailable: `Lusong can't read typed trips right now. ${TO_THE_BOXES}`,
  no_place: `Lusong couldn't find both places. ${TO_THE_BOXES}`,
  search: `Place search can't be reached right now. ${TO_THE_BOXES}`,
};

/** Shown under the typed box, before anything is sent. */
export const TRIP_TEXT_PRIVACY =
  "The words you type here are sent to Lusong's server and to Meta's Model API to read the place names, and those names to Photon to find them; Lusong doesn't keep them.";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A 24-hour "HH:MM", or null. */
export function leaveAtOf(value: unknown): string | null {
  return typeof value === "string" && HHMM.test(value) ? value : null;
}

export function leavingLine(leaveAt: string): string {
  return `Leaving around ${leaveAt}`;
}

/** What /api/trip-text answers: the place search's own places and a checked time, or why there are none. */
export type TripTextReply = { status: "ok"; from: Place[]; to: Place[]; leave_at: string | null } | { status: "failed"; reason: TripTextReason };
