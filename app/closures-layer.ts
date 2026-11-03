import type { ClosureMark, ClosuresReply } from "../lib/closure-marks";

export const CLOSURES_REFRESH_MS = 10 * 60_000;
const MAX_LISTED = 3;

const STATUSES = new Set(["ok", "paused", "down"]);

/** What came back, trusted no further than its shape: anything else reads as the layer being down. */
export function closuresReplyOf(body: unknown): ClosuresReply {
  const b = body as Partial<ClosuresReply> | null;
  const lifetimeHours = typeof b?.lifetimeHours === "number" && b.lifetimeHours > 0 ? b.lifetimeHours : 12;
  if (!b || typeof b !== "object" || typeof b.status !== "string" || !STATUSES.has(b.status) || !Array.isArray(b.marks)) {
    return { status: "down", marks: [], lifetimeHours };
  }
  const marks = b.marks.filter(
    (m): m is ClosureMark =>
      typeof m?.id === "string" &&
      typeof m.words === "string" &&
      typeof m.sourceUrl === "string" &&
      m.sourceUrl.startsWith("https://") &&
      Number.isFinite(Date.parse(m.expiresAt)) &&
      (m.spot === null ||
        (typeof m.spot?.point?.lat === "number" && typeof m.spot.point.lon === "number" && typeof m.spot.radiusM === "number")),
  );
  return { status: b.status, marks, lifetimeHours };
}

/** Marks whose time is up go at once, even when the refresh that would drop them hasn't come back (S3cP-5). */
export const liveMarks = (marks: readonly ClosureMark[], nowMs: number) => marks.filter((m) => Date.parse(m.expiresAt) > nowMs);

/** The legend row's lines. Never claims a time window the store can't vouch for (S3cP-2). */
export function closureRowLines(reply: ClosuresReply | null, loading: boolean, nowMs: number): string[] {
  if (!reply) return [loading ? "Loading road closures…" : "Switch on to see web-sweep reports"];
  if (reply.status !== "ok") return ["Can't load road closures right now"];
  const lifetime = `A sweep report shows for ${reply.lifetimeHours} hours after its page was posted. Unconfirmed by Lusong.`;
  const marks = liveMarks(reply.marks, nowMs);
  if (marks.length === 0) return ["No web-sweep reports right now", lifetime];
  const wide = marks.filter((m) => m.spot === null);
  const drawn = marks.length - wide.length;
  const head = `${marks.length} from the web sweep${wide.length > 0 ? `: ${drawn} on the map, ${wide.length} for a whole province` : ""}`;
  const listed = wide.slice(0, MAX_LISTED).map((m) => m.words);
  if (wide.length > MAX_LISTED) listed.push(`and ${wide.length - MAX_LISTED} more`);
  return [head, ...listed, lifetime];
}
