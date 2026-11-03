import type { AdvisoryKind, RouteAdvisory } from "./advisory-snapshot";
import type { Report, RouteState } from "./answer";
import { ageWords, depthWords, passabilityLine, phtTime } from "./commute-words";
import type { ClosureKind, WebFinding } from "./web-search";

/**
 * The sentences shown for the evidence Muse Spark picked (review 🔴1). Every word is Lusong's, built from fields Lusong
 * read or checked itself; the model only chooses which evidence and in what order.
 */
export interface EvidenceFacts {
  now: Date;
  reports: readonly (Report & { sample?: boolean })[];
  web: readonly WebFinding[];
  /** The advisory on the route the answer is about. */
  advisory: RouteAdvisory;
  rainingHere: boolean;
  routes: readonly { routeId: string; state: RouteState }[];
}

const VOICE_WORDS: Record<Extract<Report["reading"], { source: "voice" }>["says"], string> = {
  passable: "the road is passable",
  knee_deep_or_deeper: "the water is knee-deep or deeper",
  not_passable: "the road is not passable",
  unsure: "nothing Lusong could read about the water",
};

function routeName(routeId: string): string {
  if (routeId === "plain") return "your usual way";
  if (routeId === "detour") return "the other way";
  return "the way Muse Spark suggested";
}

function routeSentence(routeId: string, state: RouteState): string {
  const name = routeName(routeId);
  if (state === "blocked") return `A report on ${name} blocks it.`;
  if (state === "passable") return `Nothing reported blocks ${name}.`;
  return `Lusong can't tell from the reports whether ${name} is passable.`;
}

function reportSentence(r: Report & { sample?: boolean }, now: Date): string {
  const reading = r.reading;
  const age = ageWords(now.getTime() - r.receivedAt.getTime());
  if (reading.source === "voice") return `A voice report ${age} on ${r.place} says ${VOICE_WORDS[reading.says]}.`;
  const lead = `${r.sample ? "A sample report" : "A report"} ${age} on ${r.place}`;
  if (reading.source === "web") return `${lead} says it is closed.`;
  const v = reading.verdict;
  if (v.kind === "no_flood") return `${lead} shows no flood water.`;
  if (v.kind === "cannot_measure") return `${lead} has a photo Lusong couldn't measure the water in.`;
  const line = passabilityLine(v);
  return `${lead} reads ${depthWords(v)}: ${line.startsWith("Lusong") ? line : line[0].toLowerCase() + line.slice(1)}.`;
}

const KIND_WORDS: Record<AdvisoryKind, string> = {
  flood: "flood advisory",
  rainfall: "rainfall warning",
  cyclone: "tropical cyclone warning",
  other: "alert",
};

function advisorySentence(advisory: RouteAdvisory): string {
  if (advisory.state === "unreadable") return "Lusong couldn't read all of PAGASA's advisories, so it counts one as active.";
  const counting = advisory.covering.filter((p) => p.counts);
  if (counting.length === 0) return "PAGASA has no advisory covering this way right now.";
  const [first, ...more] = counting;
  const others = more.length === 0 ? "" : ` ${more.length} more ${more.length === 1 ? "advisory covers" : "advisories cover"} this way.`;
  return `PAGASA's ${KIND_WORDS[first.kind]} for ${first.areas.join(", ")} is active until ${phtTime(first.expires)}.${others}`;
}

const CLOSURE_WORDS: Record<ClosureKind, string> = { closed: "closed", flooded: "flooded", not_passable: "not passable", other_blocking: "blocked" };

function webSentence(f: WebFinding): string {
  const site = new URL(f.url).hostname;
  return `A page on ${site}${f.sourceDate ? ` dated ${f.sourceDate}` : ", undated,"} reports ${f.place} ${CLOSURE_WORDS[f.kind]}.`;
}

function sentenceFor(id: string, facts: EvidenceFacts): string | null {
  if (id === "advisory") return advisorySentence(facts.advisory);
  if (id === "rain_tap") return facts.rainingHere ? "You tapped “raining here”." : "You didn't tap “raining here”.";
  const route = facts.routes.find((r) => r.routeId === id);
  if (route) return routeSentence(route.routeId, route.state);
  const finding = facts.web.find((f) => f.id === id);
  if (finding) return webSentence(finding);
  const report = facts.reports.find((r) => r.id === id);
  return report ? reportSentence(report, facts.now) : null;
}

/** One sentence per picked id, in the model's order; null when any id has no facts, so a pick is never shown in part. */
export function evidenceSentences(ids: readonly string[], facts: EvidenceFacts): string[] | null {
  const sentences = ids.map((id) => sentenceFor(id, facts));
  return sentences.every((s): s is string => s !== null) ? sentences : null;
}
