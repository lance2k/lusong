import { createHash } from "node:crypto";
import { allProvinces, boundOfName, provinceOf } from "./advisory-geo";
import type { Alert } from "./alerts";
import { distanceM, type Point } from "./answer";
import type { Place } from "./built-in-places";
import { robotsAllow, type SafeFetchResult } from "./safe-fetch";

/**
 * Deterministic admission of the sweep's candidates (plan S4b, dispositions S4P-7 and S4P-10). The model's list is a
 * list of pages to look at and nothing more: every field a rider sees comes from the fetched page's own matched text,
 * its structured publication time, the geocoder, or the fixed host map below.
 */

/** Sweep items only ever warn: the blocking gate's fixtures and diff duck haven't cleared it (plan S4b, S4P-10). */
export const SWEEP_BLOCKING = false;

/** A page older than this, or published in the future, is refused (S4P-7). */
export const MAX_AGE_MS = 48 * 3_600_000;
/** An item lasts this long after its page was published; seeing it again never extends it. */
export const ITEM_LIFETIME_MS = 12 * 3_600_000;
/** A confident place is a spot this wide. */
export const SPOT_RADIUS_M = 500;
/** Photon answers this close together are one place. */
const SAME_PLACE_M = 1_000;
/** The term must be this close to the place on the page, so a footer mention elsewhere doesn't count. */
const NEAR_CHARS = 400;

/** News sites whose pages may be admitted. */
const NEWS_HOSTS: Record<string, string> = {
  "rappler.com": "Rappler",
  "inquirer.net": "the Philippine Daily Inquirer",
  "philstar.com": "The Philippine Star",
  "gmanetwork.com": "GMA News",
  "news.abs-cbn.com": "ABS-CBN News",
  "sunstar.com.ph": "SunStar",
  "mb.com.ph": "Manila Bulletin",
  "pna.gov.ph": "the Philippine News Agency",
};

/** Named official hosts; any other *.gov.ph host is named by its own address. */
const OFFICIAL_HOSTS: Record<string, string> = {
  "pagasa.dost.gov.ph": "PAGASA",
  "bagong.pagasa.dost.gov.ph": "PAGASA",
  "ndrrmc.gov.ph": "the NDRRMC",
  "ocd.gov.ph": "the Office of Civil Defense",
  "dpwh.gov.ph": "the DPWH",
  "mmda.gov.ph": "the MMDA",
  "pia.gov.ph": "the Philippine Information Agency",
  "cebucity.gov.ph": "the Cebu City government",
  "cebu.gov.ph": "the Cebu provincial government",
  "mandauecity.gov.ph": "the Mandaue City government",
  "lapulapucity.gov.ph": "the Lapu-Lapu City government",
  "davaocity.gov.ph": "the Davao City government",
  "quezoncity.gov.ph": "the Quezon City government",
  "manila.gov.ph": "the City of Manila",
  "marikina.gov.ph": "the Marikina City government",
};

function suffixMatch(host: string, map: Record<string, string>): string | null {
  for (const [suffix, org] of Object.entries(map)) if (host === suffix || host.endsWith(`.${suffix}`)) return org;
  return null;
}

export function isOfficialHost(host: string): boolean {
  return host === "gov.ph" || host.endsWith(".gov.ph");
}

/** Official (*.gov.ph) and the listed news hosts; Facebook and every other site are never fetched. */
export function allowedHost(host: string): boolean {
  return isOfficialHost(host) || suffixMatch(host, NEWS_HOSTS) !== null;
}

/** The organisation a rider is told of, from the host alone (S4P-7). */
export function organisationOf(host: string): string {
  return suffixMatch(host, OFFICIAL_HOSTS) ?? suffixMatch(host, NEWS_HOSTS) ?? host.replace(/^www\./, "");
}

/** Lowercased host, no fragment, no tracking parameters, no trailing slash: one page, one key. */
export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return null;
  }
}

export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ntilde: "ñ", Ntilde: "Ñ" };

/** The page's visible text: scripts, styles and tags dropped, common entities decoded. Untrusted data, never shown. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e] ?? m;
    })
    .replace(/\s+/g, " ");
}

const PHT = "+08:00";

/** An ISO date or time; a date alone is 00:00 PHT, and a time without a zone is PHT. */
function parseTime(value: string): number | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00${PHT}`);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return null;
  const zone = m[3] ? (m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : PHT;
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isFinite(t) ? t : null;
}

/**
 * The page's own publication time from structured data only (S4P-7): `article:published_time`, JSON-LD
 * `datePublished`, or the first `<time datetime>`. Null when it has none: such a page is refused.
 */
export function publishedAt(html: string): number | null {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  for (const meta of metas) {
    const prop = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(meta)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(meta)?.[1];
    if (content && (prop === "article:published_time" || prop === "datepublished")) {
      const t = parseTime(content);
      if (t !== null) return t;
    }
  }
  const ld = /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  if (ld) {
    const t = parseTime(ld);
    if (t !== null) return t;
  }
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  return time ? parseTime(time) : null;
}

const CLOSURE_TERMS = /\b(closed|closure|impassable|not passable|no entry|close[sd]? to (?:all )?(?:vehicles|traffic|motorists)|rerouting|re-routing|road block|roadblock)\b/;
const FLOOD_TERMS = /\b(flood|floods|flooded|flooding|floodwaters?|baha|binaha|submerged|knee deep|waist deep|gutter deep)\b/;
const BLOCK_TERMS = /\b(closed|impassable|not passable)\b/;
const NOT_BLOCKING = /\b(not closed|not yet closed|no longer closed|reopened|re-opened|now open|open to (?:all )?(?:vehicles|traffic|motorists)|passable to all|lifted|resumed)\b/;

/** Every stretch of the folded text within NEAR_CHARS of a mention of the place. */
function windowsAround(folded: string, place: string): string[] {
  const out: string[] = [];
  for (let at = folded.indexOf(place); at !== -1; at = folded.indexOf(place, at + 1)) {
    out.push(folded.slice(Math.max(0, at - NEAR_CHARS), at + place.length + NEAR_CHARS));
  }
  return out;
}

/** The sentence holding each mention of the place, for the blocking classifier. */
function sentencesWith(text: string, place: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(fold)
    .filter((s) => s.includes(place));
}

/**
 * Would this page block at the place if the gate were open: a block term in the sentence naming the place, with no
 * negation or reopening in that sentence. Only the gate's fixtures read it while SWEEP_BLOCKING is false.
 */
export function blocksAt(text: string, place: string): boolean {
  const sentences = sentencesWith(text, fold(place));
  return sentences.length > 0 && sentences.every((s) => BLOCK_TERMS.test(s) && !NOT_BLOCKING.test(s));
}

/** One province's own name, or Metro Manila for its districts; null for anything wider. */
function boundName(codes: readonly string[]): string | null {
  if (codes.length > 0 && codes.every((c) => c.startsWith("13"))) return "Metro Manila";
  if (codes.length !== 1) return null;
  return allProvinces().find((p) => p.code === codes[0] && !p.name.includes("Not a Province"))?.name ?? null;
}

export interface Candidate {
  url: string;
  place: string;
  province: string;
  kind: "closure" | "flood";
}

export type Geocoded = { status: "ok"; places: Place[] } | { status: "unavailable" };

export interface AdmitDeps {
  fetchPage: (url: string) => Promise<SafeFetchResult>;
  geocode: (query: string) => Promise<Geocoded>;
  now: Date;
}

export type Admission = { outcome: "admitted"; alert: Alert } | { outcome: "refused"; why: string } | { outcome: "retry"; why: string };

const refused = (why: string): Admission => ({ outcome: "refused", why });

/** robots.txt per host, read once a run. A 4XX means no rules; anything else unreadable means don't fetch. */
export function robotsChecker(fetchPage: AdmitDeps["fetchPage"]) {
  const cache = new Map<string, Promise<string | null | "refuse">>();
  return async (url: URL): Promise<boolean> => {
    if (!cache.has(url.host)) {
      cache.set(
        url.host,
        fetchPage(`https://${url.host}/robots.txt`).then((r) => (r.ok ? (r.status === 200 ? r.body : r.status >= 400 && r.status < 500 ? null : "refuse") : "refuse")),
      );
    }
    const robots = await cache.get(url.host)!;
    if (robots === "refuse") return false;
    return robots === null || robotsAllow(robots, `${url.pathname}${url.search}`);
  };
}

/** One candidate, admitted as a warn-only alert or refused with the reason. */
export async function admitCandidate(c: Candidate, deps: AdmitDeps & { robots: (url: URL) => Promise<boolean> }): Promise<Admission> {
  const canonical = canonicalUrl(c.url);
  if (!canonical) return refused("not a URL");
  const url = new URL(canonical);
  if (url.protocol !== "https:" || !allowedHost(url.hostname)) return refused(`${url.hostname} is not on the allowlist`);
  const place = c.place.replace(/\s+/g, " ").trim();
  const foldedPlace = fold(place);
  if (foldedPlace.length < 3 || place.length > 80) return refused("no usable place name");
  const bound = boundOfName(c.province);
  if (!bound || bound.kind !== "provinces") return refused("not a province Lusong knows");
  const provinceName = boundName(bound.codes);
  if (!provinceName) return refused("not one province: a region is too wide for a warning anyone could act on");

  if (!(await deps.robots(url))) return refused("robots.txt disallows it");
  const page = await deps.fetchPage(canonical);
  if (!page.ok) return refused(`fetch: ${page.why}`);
  if (page.status !== 200) return refused(`HTTP ${page.status}`);
  if (!/html|text\/plain/i.test(page.contentType)) return refused("not a page");

  const posted = publishedAt(page.body);
  const now = deps.now.getTime();
  if (posted === null) return refused("no structured publication time");
  if (posted > now) return refused("published in the future");
  if (now - posted > MAX_AGE_MS) return refused("older than 48 hours");
  const expires = posted + ITEM_LIFETIME_MS;
  if (expires <= now) return refused("its 12 hours have passed");

  const text = pageText(page.body);
  const folded = fold(text);
  const near = windowsAround(folded, foldedPlace);
  if (near.length === 0) return refused("the page doesn't name the place");
  if (!folded.includes(fold(c.province))) return refused("the page doesn't name the province");
  const words = near.some((w) => CLOSURE_TERMS.test(w)) ? "closure" : near.some((w) => FLOOD_TERMS.test(w)) ? "flood" : null;
  if (!words) return refused("no closure or flood term near the place");

  const found = await deps.geocode(`${place}, ${c.province}`);
  if (found.status === "unavailable") return { outcome: "retry", why: "the geocoder is busy" };
  const inside = found.places.filter((p) => {
    const province = provinceOf(p);
    return province !== null && bound.codes.includes(province.code);
  });
  const spot: Point | null = inside.length > 0 && inside.every((p) => distanceM(p, inside[0]) <= SAME_PLACE_M) ? { lat: inside[0].lat, lon: inside[0].lon } : null;

  const official = isOfficialHost(url.hostname);
  const id = `sweep:${createHash("sha256").update(`${canonical}|${foldedPlace}|${words}`).digest("hex").slice(0, 24)}`;
  const alert: Alert = {
    id,
    version: 1,
    kind: official ? "office_post" : "closure",
    // Ambiguous, or not inside the province the page names: a warning for the whole province, never a spot.
    scope: spot ? { point: spot, radiusM: SPOT_RADIUS_M } : { codes: bound.codes },
    sourceUrl: canonical,
    sourceOrg: organisationOf(url.hostname),
    eventAt: new Date(posted).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    severity: SWEEP_BLOCKING && official && spot && blocksAt(text, place) ? "block" : "warn",
    origin: "sweep",
    // The geocoder's name for a confident spot, else the province's own name: never the model's spelling.
    fields: { place: spot ? [inside[0].name, inside[0].area].filter(Boolean).join(", ") : `a place in ${provinceName}`, posted: new Date(posted).toISOString(), words },
  };
  return { outcome: "admitted", alert };
}
