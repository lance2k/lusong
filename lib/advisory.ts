import { childOf, childrenOf, parseXml, textOf, type XmlElement } from "./xml";

export const FEED_URL = "https://publicalert.pagasa.dost.gov.ph/feeds/";
export const USER_AGENT = "Lusong/0.1 (hackathon entry; github.com/lance2k/lusong)";

const ATOM = "http://www.w3.org/2005/Atom";
const CAP = "urn:oasis:names:tc:emergency:cap:1.2";

/**
 * Only GFA entries updated this recently are followed. Both Central Visayas records saved (2026-10-25 and -26)
 * expire 12 h after they were sent; 24 h leaves room for a longer one (2 records, an assumption beyond that).
 */
export const ADVISORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface AdvisoryLimits {
  /** At most this many CAP records are fetched per reading; more candidates than that is 'unreadable'. */
  maxCapFetches: number;
  maxBytes: number;
  /** Per request. */
  timeoutMs: number;
  /** For the whole reading, feed and records together. */
  deadlineMs: number;
}

export const DEFAULT_LIMITS: AdvisoryLimits = { maxCapFetches: 12, maxBytes: 256 * 1024, timeoutMs: 5_000, deadlineMs: 15_000 };

export interface FloodAdvisory {
  id: string;
  headline: string | null;
  event: string | null;
  rainForecast: string | null;
  riversForCebu: string | null;
  sent: string;
  expires: string;
  link: string;
}

export type AdvisoryReading =
  | { state: "active"; advisory: FloodAdvisory }
  | { state: "none" }
  | { state: "unreadable"; why: string };

class Unreadable extends Error {}

function time(text: string | null, what: string): number {
  const t = text === null ? NaN : Date.parse(text);
  if (!Number.isFinite(t)) throw new Unreadable(`${what} is not a time`);
  return t;
}

async function fetchText(url: string, deps: { fetch: typeof fetch }, limits: AdvisoryLimits, deadline: AbortSignal): Promise<string> {
  const res = await deps.fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/cap+xml, text/xml" },
    signal: AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), deadline]),
  });
  if (!res.ok) throw new Unreadable(`HTTP ${res.status} from ${url}`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limits.maxBytes) {
      await reader.cancel();
      throw new Unreadable(`${url} is larger than ${limits.maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

interface FeedEntry {
  title: string;
  updated: number;
  link: string;
}

function readFeed(xml: string): FeedEntry[] {
  const root = parseXml(xml);
  if (root.ns !== ATOM || root.name !== "feed") throw new Unreadable("not an Atom feed");
  return childrenOf(root, ATOM, "entry").flatMap((entry) => {
    const title = textOf(entry, ATOM, "title") ?? "";
    if (!/\bGFA\b/.test(title)) return [];
    const link = childrenOf(entry, ATOM, "link").find((l) => /\.cap$/.test(l.attrs.href ?? "") || l.attrs.type === "application/cap+xml");
    if (!link?.attrs.href) throw new Unreadable(`GFA entry "${title}" has no CAP link`);
    return [{ title, updated: time(textOf(entry, ATOM, "updated"), `"${title}" updated`), link: new URL(link.attrs.href, FEED_URL).href }];
  });
}

interface CapRecord {
  advisory: FloodAdvisory | null;
  references: string[];
}

const CEBU = /\bcebu\b/i;

function riversFor(description: string): string | null {
  const line = /\*\*Cebu\*\*\s*-\s*(.+)$/im.exec(description);
  if (!line) return null;
  return line[1]
    .trim()
    .replace(/^rivers and its tributaries\s*(particularly\s*)?/i, "")
    .replace(/\.$/, "");
}

/** An advisory for Cebu counts only while it is a live Alert or Update, not an all-clear, and not yet expired. */
function readCap(xml: string, link: string, now: number): CapRecord {
  const alert = parseXml(xml);
  if (alert.ns !== CAP || alert.name !== "alert") throw new Unreadable(`${link} is not a CAP alert`);
  const id = textOf(alert, CAP, "identifier");
  if (!id) throw new Unreadable(`${link} has no identifier`);
  const sentText = textOf(alert, CAP, "sent");
  const sent = time(sentText, `${link} sent`);
  const references = (textOf(alert, CAP, "references") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => ref.split(",")[1])
    .filter((ref): ref is string => Boolean(ref));

  const live =
    textOf(alert, CAP, "status") === "Actual" && ["Alert", "Update"].includes(textOf(alert, CAP, "msgType") ?? "") && sent <= now;
  const infos = childrenOf(alert, CAP, "info");
  if (infos.length === 0) throw new Unreadable(`${link} has no info block`);
  const forCebu = infos.find((info: XmlElement) => {
    const expires = time(textOf(info, CAP, "expires"), `${link} expires`);
    const allClear = childrenOf(info, CAP, "responseType").some((r) => r.text.trim() === "AllClear");
    const inCebu = childrenOf(info, CAP, "area").some((area) => CEBU.test(textOf(area, CAP, "areaDesc") ?? ""));
    return live && !allClear && expires > now && inCebu;
  });
  if (!forCebu) return { advisory: null, references };
  const description = childOf(forCebu, CAP, "description")?.text ?? "";
  return {
    references,
    advisory: {
      id,
      headline: textOf(forCebu, CAP, "headline"),
      event: textOf(forCebu, CAP, "event"),
      rainForecast: /rainfall forecast is\s+([^.\n]+?)\s*\.?\s*$/im.exec(description)?.[1] ?? null,
      riversForCebu: riversFor(description),
      sent: sentText!,
      expires: textOf(forCebu, CAP, "expires")!,
      link,
    },
  };
}

/**
 * PAGASA's General Flood Advisory for Cebu, from its public CAP Atom feed. Only an advisory actually read from a record
 * counts as active; any failure, malformed record or unfollowed candidate makes the reading 'unreadable', never 'none'.
 */
export async function readAdvisory(deps: {
  fetch: typeof fetch;
  now: Date;
  limits?: Partial<AdvisoryLimits>;
}): Promise<AdvisoryReading> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now.getTime();
  const deadline = AbortSignal.timeout(limits.deadlineMs);
  let candidates: FeedEntry[];
  try {
    candidates = readFeed(await fetchText(FEED_URL, deps, limits, deadline))
      .filter((e) => e.updated <= now && now - e.updated < ADVISORY_LOOKBACK_MS)
      .sort((a, b) => b.updated - a.updated);
  } catch (err) {
    return { state: "unreadable", why: `feed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const replaced = new Set<string>();
  const seen = new Set<string>();
  let failure: string | null = candidates.length > limits.maxCapFetches ? `${candidates.length} candidates, limit ${limits.maxCapFetches}` : null;
  for (const entry of candidates.slice(0, limits.maxCapFetches)) {
    if (seen.has(entry.link)) continue;
    seen.add(entry.link);
    try {
      const record = readCap(await fetchText(entry.link, deps, limits, deadline), entry.link, now);
      // Newest first, so every record that replaces this one has already been read.
      if (record.advisory && !replaced.has(record.advisory.id)) return { state: "active", advisory: record.advisory };
      for (const ref of record.references) replaced.add(ref);
    } catch (err) {
      failure ??= `${entry.link}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return failure ? { state: "unreadable", why: failure } : { state: "none" };
}
