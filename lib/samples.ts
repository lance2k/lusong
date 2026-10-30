import type { Point, Report } from "./answer";
import type { Verdict } from "./verdict";

/**
 * Demo mode only. Each sample is a labelled test-set photo taken somewhere else, carrying the verdict Lusong actually
 * recorded for it, pinned on a street of a demo trip. Real commute checks never see these.
 */

export const DEMO_TRIPS = {
  "banilad-itpark": { label: "Banilad → IT Park", from: { lat: 10.346, lon: 123.911 }, to: { lat: 10.3307, lon: 123.9058 } },
  "mabolo-cbp": { label: "Mabolo → Cebu Business Park", from: { lat: 10.3143, lon: 123.9147 }, to: { lat: 10.3162, lon: 123.9059 } },
} as const satisfies Record<string, { label: string; from: Point; to: Point }>;

export type DemoTripId = keyof typeof DEMO_TRIPS;

export const SCENARIOS = [
  { id: "none", label: "No reports" },
  { id: "flooded", label: "A flooded spot reported" },
  { id: "unclear", label: "A photo Lusong can't call" },
  // Only Banilad → IT Park has a saved Valhalla reply finding no way around its spot.
  { id: "no_way_around", label: "A flooded spot with no way around", trips: ["banilad-itpark"] },
] as const satisfies readonly { id: string; label: string; trips?: readonly DemoTripId[] }[];

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export function scenariosFor(trip: DemoTripId) {
  return SCENARIOS.filter((s) => !("trips" in s) || (s.trips as readonly DemoTripId[]).includes(trip));
}

export interface SampleSpec {
  id: string;
  trip: DemoTripId;
  scenarios: ScenarioId[];
  /** Where the pin sits, by street (Valhalla /locate, 2026-10-30, one lookup each) and, for most, barangay (OSM Nominatim). */
  place: string;
  at: Point;
  wayId: number | null;
  ageMin: number;
  verdict: Verdict;
  /** Where the photo was really taken, from its Wikimedia Commons caption. */
  origin: string;
  credit: string;
  sourceUrl: string;
  /** The recorded run, photo and draw the verdict was copied from. */
  recorded: { run: string; file: string; draw: number };
}

export const SAMPLE_SPECS: readonly SampleSpec[] = [
  {
    id: "sample-cavite-2013",
    trip: "banilad-itpark",
    scenarios: ["flooded"],
    place: "Governor M. Cuenco Avenue at Jose Maria Del Mar Avenue",
    // The plain route's midpoint, where the 2026-10-30 probe found a way around a 330 m box. /locate finds three ways
    // at 0 m there (Governor M. Cuenco, Jose Maria Del Mar, Paradise Village Road), so it has no single way id.
    at: { lat: 10.335398, lon: 123.910908 },
    wayId: null,
    ageMin: 40,
    verdict: {
      kind: "measured",
      rangeCm: { low: 27, high: 39 },
      passability: "NPLV",
      confidence: "low",
      readingsComplete: true,
      decidedBy: { label: "C1", landmark: "tyre_half", interval: { low: 27, high: 39 } },
      readingsUsed: ["C1"],
    },
    origin: "Aguinaldo Highway between Imus and Bacoor, Cavite, 19 August 2013",
    credit: "Au Morandarte from Chiswick/Romford, London, England, CC BY-SA 2.0, via Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Au_Morandarte_Flickr_Cavite_Floods_2013,_19_08_13_(9547554519).jpg",
    recorded: { run: "depth-runs/2026-10-28T19-17-05-421Z", file: "au-morandarte-flickr-cavite-floods-2013-19-08-13-9547554519.jpg", draw: 2 },
  },
  {
    id: "sample-manila-2009",
    trip: "banilad-itpark",
    scenarios: ["unclear"],
    place: "Jose Maria Del Mar Avenue, Apas (IT Park)",
    at: { lat: 10.333332, lon: 123.909442 },
    wayId: 1207204799,
    ageMin: 25,
    verdict: {
      kind: "measured",
      rangeCm: { low: 5, high: 10 },
      passability: "shallow",
      confidence: "medium",
      readingsComplete: true,
      decidedBy: { label: "P1", landmark: "ankle", interval: { low: 5, high: 10 } },
      readingsUsed: ["P1", "P4"],
    },
    origin: "A flooded neighbourhood in Manila, October 2009",
    credit: "SuSanA Secretariat (photo by Jörg Dietze), CC BY 2.0, via Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Flooded_urban_poor_area_in_Manila_(4046572324).jpg",
    recorded: { run: "acceptance-runs/2026-10-28T19-23-25-915Z", file: "manila-2009-pedicabs.jpg", draw: 1 },
  },
  {
    id: "sample-shah-alam-2021",
    trip: "banilad-itpark",
    scenarios: ["no_way_around"],
    // The trip's end, where the route's last street is V. Padriga Street (Valhalla route, 2026-10-30). The
    // 2026-10-30 02:24 PHT probe excluded the 330 m box around this point and Valhalla found no path. Not looked up
    // with /locate, so no way id: it can never be retired by a clear report, only by expiry.
    place: "V. Padriga Street at IT Park",
    at: { lat: 10.3307, lon: 123.9058 },
    wayId: null,
    ageMin: 15,
    verdict: {
      kind: "measured",
      rangeCm: { low: 18, high: 140 },
      passability: "NPATV",
      confidence: "low",
      readingsComplete: true,
      decidedBy: { label: "C1", landmark: "above_tyre", interval: { low: 66, high: 140 } },
      readingsUsed: ["C1", "C2", "C3", "C4", "C5", "P1", "C9", "C10"],
    },
    origin: "A residential area at Section 24, Shah Alam, Malaysia, during the December 2021 floods",
    credit: "Muhammad Zaim, CC BY-SA 4.0, via Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Section_24,_Shah_Alam_Floodings.jpg",
    recorded: { run: "acceptance-runs/2026-10-28T19-23-25-915Z", file: "shah-alam-2021.jpg", draw: 1 },
  },
  {
    id: "sample-quiapo-2024-waders",
    trip: "mabolo-cbp",
    scenarios: ["flooded"],
    place: "M.J. Cuenco Avenue at H. Joaquino Street, Mabolo",
    at: { lat: 10.313004, lon: 123.91213 },
    // The pin sits on the corner, where /locate finds two ways at 0 m, so it has no single way id.
    wayId: null,
    ageMin: 70,
    verdict: {
      kind: "measured",
      rangeCm: { low: 5, high: 72 },
      passability: "NPATV",
      confidence: "low",
      readingsComplete: true,
      decidedBy: { label: "P2", landmark: "mid_thigh", interval: { low: 50, high: 72 } },
      readingsUsed: ["P1", "P2", "P4", "P6"],
    },
    origin: "Quiapo, City of Manila, during the Habagat and Typhoon Carina (Gaemi) floods of July 2024",
    credit: "Michael Peronce (User:Mikeee 07), CC BY-SA 4.0, via Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Quiapo,_Manila_Floods_Habagat-Carina_2024-1.jpg",
    recorded: { run: "acceptance-runs/2026-10-28T19-23-25-915Z", file: "quiapo-1.jpg", draw: 1 },
  },
  {
    id: "sample-bacoor-2013",
    trip: "mabolo-cbp",
    scenarios: ["flooded"],
    place: "Leyte Loop, Cebu Business Park",
    at: { lat: 10.313981, lon: 123.908343 },
    wayId: 237982309,
    // Older than the 3-hour lifetime: shown, not counted.
    ageMin: 200,
    verdict: { kind: "cannot_measure" },
    origin: "Aguinaldo Highway at Bacoor, Cavite, 19 August 2013",
    credit: "Au Morandarte from Chiswick/Romford, London, England, CC BY-SA 2.0, via Wikimedia Commons",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Au_Morandarte_Flickr_Stranded_7_Eleven_store_in_Bacoor_due_to_floods,_19_08_13_(9550361920).jpg",
    recorded: {
      run: "depth-runs/2026-10-28T19-17-05-421Z",
      file: "au-morandarte-flickr-stranded-7-eleven-store-in-bacoor-due-t.jpg",
      draw: 1,
    },
  },
  {
    id: "sample-quiapo-2024-street",
    trip: "mabolo-cbp",
    scenarios: ["unclear"],
    place: "Mactan Road, Mabolo",
    at: { lat: 10.31257, lon: 123.90931 },
    wayId: 50873803,
    ageMin: 140,
    verdict: { kind: "cannot_measure" },
    origin: "Quiapo, City of Manila, during the Habagat and Typhoon Carina (Gaemi) floods of July 2024",
    credit: "Michael Peronce (User:Mikeee 07), CC BY-SA 4.0, via Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Quiapo,_Manila_Floods_Habagat-Carina_2024-2.jpg",
    recorded: { run: "acceptance-runs/2026-10-28T19-23-25-915Z", file: "quiapo-2.jpg", draw: 1 },
  },
];

export interface SampleReport extends Report {
  sample: true;
  origin: string;
  credit: string;
  sourceUrl: string;
}

export function sampleReports(trip: DemoTripId, scenario: ScenarioId, now: Date): SampleReport[] {
  return SAMPLE_SPECS.filter((s) => s.trip === trip && s.scenarios.includes(scenario)).map((s) => ({
    id: s.id,
    sample: true,
    at: s.at,
    wayId: s.wayId,
    receivedAt: new Date(now.getTime() - s.ageMin * 60_000),
    place: s.place,
    // A sample carries no capture time from Cebu, so even a dry photo could not clear a spot.
    reading: { source: "photo", verdict: s.verdict, capturedAt: null },
    origin: s.origin,
    credit: s.credit,
    sourceUrl: s.sourceUrl,
  }));
}
