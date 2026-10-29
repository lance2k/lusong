import { describe, expect, it } from "vitest";
import type { AdvisoryReading } from "./advisory";
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

const ACTIVE: AdvisoryReading = {
  state: "active",
  advisory: {
    id: "gfa",
    headline: "General Flood Advisory",
    event: null,
    rainForecast: null,
    riversForCebu: null,
    sent: "2026-10-30T01:00:00+08:00",
    expires: "2026-10-30T05:27:00+08:00",
    link: "https://publicalert.pagasa.dost.gov.ph/output/gfa/x.cap",
  },
} as AdvisoryReading;

function facts(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    now: NOW,
    reports: [
      photo("s1", measured(50, 90, "NPLV"), { sample: true } as Partial<Report>),
      photo("p2", { kind: "no_flood" } as Verdict, { place: "Banilad Road", receivedAt: minutesAgo(10) }),
      photo("p3", { kind: "cannot_measure" } as Verdict, { place: "Banilad Road", receivedAt: minutesAgo(10) }),
      { id: "v1", at: AT, wayId: null, receivedAt: minutesAgo(10), place: "Banilad", reading: { source: "voice", says: "not_passable" } },
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
    [{ state: "none" } as AdvisoryReading, "PAGASA has no flood advisory for Cebu right now."],
    [{ state: "unreadable" } as AdvisoryReading, "Lusong couldn't read PAGASA's flood advisory, so it counts one as active."],
  ])("the advisory when it is %o", (advisory, sentence) => {
    expect(evidenceSentences(["advisory"], facts({ advisory }))).toEqual([sentence]);
  });

  it("the rain tap when the rider tapped it", () => {
    expect(evidenceSentences(["rain_tap"], facts({ rainingHere: true }))).toEqual(["You tapped “raining here”."]);
  });

  it("an id it has no facts for means no sentences at all, not a partial list", () => {
    expect(evidenceSentences(["plain", "v9"], facts())).toBeNull();
  });
});
