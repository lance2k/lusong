import { describe, expect, it } from "vitest";
import { activeRouteAdvisory, NO_ROUTE_ADVISORY, productView, UNREADABLE_ROUTE_ADVISORY } from "../test/route-advisory";
import type { Report } from "./answer";
import { evidenceSentences, type EvidenceFacts } from "./evidence-words";
import type { Verdict } from "./verdict";

const NOW = new Date("2026-10-30T02:00:00Z"); // 10:00 PHT
const AT = { lat: 10.33, lon: 123.91 };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function photo(id: string, verdict: Verdict, extra: Partial<Report> & { sample?: true } = {}): Report {
  return { id, at: AT, wayId: null, receivedAt: minutesAgo(40), place: "Governor M. Cuenco Avenue", reading: { source: "photo", verdict, capturedAt: null }, ...extra };
}
const measured = (low: number, high: number, passability: "NPLV" | "NPATV" | "shallow" | "unsure"): Verdict =>
  ({ kind: "measured", rangeCm: { low, high }, passability, confidence: "high", readingsComplete: true }) as unknown as Verdict;

const ACTIVE = activeRouteAdvisory(productView({ expires: "2026-10-30T05:27:00+08:00" }));

function facts(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    now: NOW,
    reports: [
      photo("s1", measured(50, 90, "NPLV"), { sample: true } as Partial<Report>),
      photo("p2", { kind: "no_flood" } as Verdict, { place: "Banilad Road", receivedAt: minutesAgo(10) }),
      photo("p3", { kind: "cannot_measure" } as Verdict, { place: "Banilad Road", receivedAt: minutesAgo(10) }),
      { id: "v1", at: AT, wayId: null, receivedAt: minutesAgo(10), place: "Banilad", reading: { source: "voice", says: "not_passable" } },
      { id: "v2", at: AT, wayId: null, receivedAt: minutesAgo(10), place: "Banilad", reading: { source: "voice", says: "unsure" } },
    ],
    web: [],
    advisory: ACTIVE,
    rainingHere: false,
    routes: [
      { routeId: "plain", state: "blocked" },
      { routeId: "detour", state: "passable" },
      { routeId: "muse-1", state: "unknown" },
    ],
    ...overrides,
  };
}

describe("Lusong's own words for the evidence Muse Spark picked (review 🔴1)", () => {
  it.each([
    ["s1", "A sample report 40 min ago on Governor M. Cuenco Avenue reads knee- to waist-deep (50–90 cm): not passable to light vehicles (MMDA gauge, Metro Manila)."],
    ["p2", "A report 10 min ago on Banilad Road shows no flood water."],
    ["p3", "A report 10 min ago on Banilad Road has a photo Lusong couldn't measure the water in."],
    ["v1", "A voice report 10 min ago on Banilad says the road is not passable."],
    ["v2", "A voice report 10 min ago on Banilad says nothing Lusong could read about the water."],
    ["advisory", "PAGASA's flood advisory for Cebu is active until 30 Oct, 5:27 a.m. PHT."],
    ["rain_tap", "You didn't tap “raining here”."],
    ["plain", "A report on your usual way blocks it."],
    ["detour", "Nothing reported blocks the other way."],
    ["muse-1", "Lusong can't tell from the reports whether the way Muse Spark suggested is passable."],
  ])("%s ⇒ %s", (id, sentence) => {
    expect(evidenceSentences([id], facts())).toEqual([sentence]);
  });

  it("keeps the model's order", () => {
    expect(evidenceSentences(["detour", "plain"], facts())).toEqual(["Nothing reported blocks the other way.", "A report on your usual way blocks it."]);
  });

  it.each([
    [NO_ROUTE_ADVISORY, "PAGASA has no advisory covering this way right now."],
    [UNREADABLE_ROUTE_ADVISORY, "Lusong couldn't read all of PAGASA's advisories, so it counts one as active."],
    [
      activeRouteAdvisory(
        productView({ kind: "cyclone", areas: ["Batanes"], expires: "2026-10-24T16:50:27+08:00" }),
        productView({ areas: ["Batanes"] }),
        productView({ kind: "other", counts: false }),
      ),
      "PAGASA's tropical cyclone warning for Batanes is active until 24 Oct, 4:50 p.m. PHT. 1 more advisory covers this way.",
    ],
  ])("the advisory when it is %o", (advisory, sentence) => {
    expect(evidenceSentences(["advisory"], facts({ advisory }))).toEqual([sentence]);
  });

  it("the rain tap when the rider tapped it", () => {
    expect(evidenceSentences(["rain_tap"], facts({ rainingHere: true }))).toEqual(["You tapped “raining here”."]);
  });

  it.each([
    ["closed", "2026-10-30", "A page on news.example.ph dated 2026-10-30 reports Osmeña Blvd closed."],
    ["flooded", null, "A page on news.example.ph, undated, reports Osmeña Blvd flooded."],
    ["not_passable", null, "A page on news.example.ph, undated, reports Osmeña Blvd not passable."],
    ["other_blocking", null, "A page on news.example.ph, undated, reports Osmeña Blvd blocked."],
  ] as const)("a web finding of kind %s, dated %s", (kind, sourceDate, sentence) => {
    const web = [{ id: "web-0", place: "Osmeña Blvd", at: null, url: "https://news.example.ph/a?b=1", sourceDate, kind }];
    expect(evidenceSentences(["web-0"], facts({ web }))).toEqual([sentence]);
  });

  it("an id it has no facts for means no sentences at all, not a partial list", () => {
    expect(evidenceSentences(["plain", "v9"], facts())).toBeNull();
  });
});
