import { childOf, childrenOf, parseXml, textOf, type XmlElement } from "./xml";

export const FEED_URL = "https://publicalert.pagasa.dost.gov.ph/feeds/";
export const USER_AGENT = "Lusong/0.1 (hackathon entry; github.com/lance2k/lusong)";

const ATOM = "http://www.w3.org/2005/Atom";
const CAP = "urn:oasis:names:tc:emergency:cap:1.2";

export interface AdvisoryLimits {
  /** At most this many CAP records are fetched per reading; needing more than that to settle every region is 'unreadable'. */
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
  /** "Region 7 (Central Visayas)" from "GFA #5 - Region 7 (Central Visayas)"; null when the title names none. */
  region: string | null;
}

function regionOf(title: string): string | null {
  const dash = title.lastIndexOf(" - ");
  const region = dash < 0 ? "" : title.slice(dash + 3).trim();
  return region === "" ? null : region;
}

function readFeed(xml: string): FeedEntry[] {
  const root = parseXml(xml);
  if (root.ns !== ATOM || root.name !== "feed") throw new Unreadable("not an Atom feed");
  return childrenOf(root, ATOM, "entry").flatMap((entry) => {
    const title = textOf(entry, ATOM, "title") ?? "";
    if (!/\bGFA\b/.test(title)) return [];
    const link = childrenOf(entry, ATOM, "link").find((l) => /\.cap$/.test(l.attrs.href ?? "") || l.attrs.type === "application/cap+xml");
    if (!link?.attrs.href) throw new Unreadable(`GFA entry "${title}" has no CAP link`);
    return [
      {
        title,
        updated: time(textOf(entry, ATOM, "updated"), `"${title}" updated`),
        link: new URL(link.attrs.href, FEED_URL).href,
        region: regionOf(title),
      },
    ];
  });
}

interface CapRecord {
  advisory: FloodAdvisory | null;
  references: string[];
}

const CEBU = /\bcebu\b/i;
/** Cebu province's SAME geocode prefix: PAGASA codes it 072200000 (saved records, 2026-10-25/26). */
const CEBU_SAME_PREFIX = "0722";
/** A point in Cebu City; a polygon containing it covers Cebu. */
const CEBU_CITY = { lat: 10.3157, lon: 123.8854 };

export type AreaCoverage = "cebu" | "outside" | "unknown";

/** CAP polygons are "lat,lon" pairs, at least four, first equal to last; anything else can't be read. */
function readPolygon(text: string): { lat: number; lon: number }[] | null {
  const points = text.trim().split(/\s+/).map((pair) => {
    const parts = pair.split(",");
    return parts.length === 2 ? { lat: Number(parts[0]), lon: Number(parts[1]) } : null;
  });
  if (points.length < 4 || points.some((p) => !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) return null;
  const ring = points as { lat: number; lon: number }[];
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return first.lat === last.lat && first.lon === last.lon ? ring : null;
}

function contains(ring: readonly { lat: number; lon: number }[], p: { lat: number; lon: number }): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) within = !within;
  }
  return within;
}

/**
 * Lean-safe: an area is in Cebu when any indicator says so (its name, a SAME geocode, a polygon). It is outside only
 * when every indicator it carries is readable and says outside, and at least one of them is a geocode or polygon, since
 * a name alone ("Unknown") can't rule Cebu out. Anything else is unknown.
 */
function coverageOf(area: XmlElement, link: string): AreaCoverage {
  const desc = textOf(area, CAP, "areaDesc") ?? "";
  if (desc === "") throw new Unreadable(`${link} has an area with no areaDesc`);
  let cebu = CEBU.test(desc);
  let outsideReadings = 0;
  let unusable = 0;
  for (const g of childrenOf(area, CAP, "geocode")) {
    const value = textOf(g, CAP, "value") ?? "";
    if (textOf(g, CAP, "valueName") !== "SAME" || !/^\d{9}$/.test(value)) unusable++;
    else if (value.startsWith(CEBU_SAME_PREFIX)) cebu = true;
    else outsideReadings++;
  }
  for (const p of childrenOf(area, CAP, "polygon")) {
    const ring = readPolygon(p.text);
    if (!ring) unusable++;
    else if (contains(ring, CEBU_CITY)) cebu = true;
    else outsideReadings++;
  }
  if (cebu) return "cebu";
  return unusable === 0 && outsideReadings > 0 ? "outside" : "unknown";
}

/** Each <area> of every <info>, in order: how Lusong reads its geography. */
export function areaCoverage(xml: string): AreaCoverage[] {
  return childrenOf(parseXml(xml), CAP, "info").flatMap((info) => childrenOf(info, CAP, "area").map((a) => coverageOf(a, "record")));
}

function riversFor(description: string): string | null {
  const line = /\*\*Cebu\*\*\s*-\s*(.+)$/im.exec(description);
  if (!line) return null;
  return line[1]
    .trim()
    .replace(/^rivers and its tributaries\s*(particularly\s*)?/i, "")
    .replace(/\.$/, "");
}

/**
 * CAP 1.2's code lists: each value appears in the OASIS CAP 1.2 spec,
 * docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html (checked 2026-10-30, 19 of 19). Anything else is a record
 * Lusong can't read.
 */
const STATUSES = new Set(["Actual", "Exercise", "System", "Test", "Draft"]);
const MSG_TYPES = new Set(["Alert", "Update", "Cancel", "Ack", "Error"]);
const RESPONSE_TYPES = new Set(["Shelter", "Evacuate", "Prepare", "Execute", "Avoid", "Monitor", "Assess", "AllClear", "None"]);

function required(el: XmlElement, name: string, link: string): string {
  const value = textOf(el, CAP, name);
  if (!value) throw new Unreadable(`${link} has no ${name}`);
  return value;
}

/**
 * Every field the state depends on is checked before the state is decided, so a record missing one is 'unreadable'
 * rather than quietly inactive. An advisory for Cebu counts only while it is a live Alert or Update, not an all-clear,
 * and not yet expired.
 */
function readCap(xml: string, link: string, now: number): CapRecord {
  const alert = parseXml(xml);
  if (alert.ns !== CAP || alert.name !== "alert") throw new Unreadable(`${link} is not a CAP alert`);
  const id = required(alert, "identifier", link);
  const sentText = required(alert, "sent", link);
  const sent = time(sentText, `${link} sent`);
  const status = required(alert, "status", link);
  if (!STATUSES.has(status)) throw new Unreadable(`${link} has status ${status}`);
  const msgType = required(alert, "msgType", link);
  if (!MSG_TYPES.has(msgType)) throw new Unreadable(`${link} has msgType ${msgType}`);
  const references = (textOf(alert, CAP, "references") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => ref.split(",")[1])
    .filter((ref): ref is string => Boolean(ref));

  const infos = childrenOf(alert, CAP, "info");
  if (infos.length === 0) throw new Unreadable(`${link} has no info block`);
  const read = infos.map((info) => {
    const expiresText = required(info, "expires", link);
    const expires = time(expiresText, `${link} expires`);
    const responses = childrenOf(info, CAP, "responseType").map((r) => r.text.trim());
    if (responses.some((r) => !RESPONSE_TYPES.has(r))) throw new Unreadable(`${link} has an unknown responseType`);
    const areas = childrenOf(info, CAP, "area").map((area) => coverageOf(area, link));
    if (areas.length === 0) throw new Unreadable(`${link} has no usable area`);
    const inCebu = areas.includes("cebu");
    if (!inCebu && areas.includes("unknown")) throw new Unreadable(`${link} has an area Lusong can't place in or outside Cebu`);
    return { info, expiresText, expires, allClear: responses.includes("AllClear"), inCebu };
  });

  const live = status === "Actual" && (msgType === "Alert" || msgType === "Update") && sent <= now;
  const active = read.find((r) => live && !r.allClear && r.expires > now && r.inCebu);
  if (!active) return { advisory: null, references };
  const description = childOf(active.info, CAP, "description")?.text ?? "";
  return {
    references,
    advisory: {
      id,
      headline: textOf(active.info, CAP, "headline"),
      event: textOf(active.info, CAP, "event"),
      rainForecast: /rainfall forecast is\s+([^.\n]+?)\s*\.?\s*$/im.exec(description)?.[1] ?? null,
      riversForCebu: riversFor(description),
      sent: sentText,
      expires: active.expiresText,
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
  let entries: FeedEntry[];
  try {
    entries = readFeed(await fetchText(FEED_URL, deps, limits, deadline))
      .filter((e) => e.updated <= now)
      .sort((a, b) => b.updated - a.updated);
  } catch (err) {
    return { state: "unreadable", why: `feed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Each region's newest record is its current state, however old: older records of a settled region are skipped.
  const settled = new Set<string>();
  const replaced = new Set<string>();
  const seen = new Set<string>();
  let fetched = 0;
  let failure: string | null = null;
  for (const entry of entries) {
    if (entry.region !== null && settled.has(entry.region)) continue;
    if (seen.has(entry.link)) continue;
    if (fetched >= limits.maxCapFetches) {
      failure ??= `more than ${limits.maxCapFetches} records needed`;
      break;
    }
    seen.add(entry.link);
    fetched++;
    if (entry.region !== null) settled.add(entry.region);
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
