import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pinPopup } from "./map-props";
import { ReportEvidence, type PageReport } from "./report-evidence";

const REPORT: PageReport = {
  id: "r1",
  sample: false,
  place: "Governor M. Cuenco Avenue",
  at: { lat: 10.338566, lon: 123.911461 },
  age: "40 min ago",
  depth: "about knee-deep",
  passability: "Not passable to light vehicles",
  origin: null,
  credit: null,
  sourceUrl: null,
  photoUrl: "https://blob.test/report-photos/a.jpg",
  counts: true,
  onRoute: true,
  onDetour: false,
  routes: ["plain"],
  role: "block",
};
const ALT = "The reporter's photo, with people and number plates blurred";
const MODEL_WORDS = /SAM|Muse|model|mask|segment|AI\b/i;

describe("blurred photos in the evidence list (#8, criterion 4)", () => {
  it("a report with a published photo shows it, with plain alt text", () => {
    const html = renderToStaticMarkup(<ReportEvidence r={REPORT} />);
    const img = /<img[^>]*>/.exec(html)?.[0] ?? "";
    expect(img).toContain('src="https://blob.test/report-photos/a.jpg"');
    expect(img).toContain(`alt="${ALT.replace("'", "&#x27;")}"`);
    expect(img).not.toMatch(MODEL_WORDS);
  });

  it("a report with no published photo shows none", () => {
    expect(renderToStaticMarkup(<ReportEvidence r={{ ...REPORT, photoUrl: null }} />)).not.toContain("<img");
  });
});

describe("where a counted report lies, in its status line (review C-4)", () => {
  const status = (r: Partial<PageReport>) => renderToStaticMarkup(<ReportEvidence r={{ ...REPORT, ...r }} />);

  it("one on the plain route says only what it does to the spot", () => {
    expect(status({})).toContain("Marks the spot not passable.");
    expect(status({})).not.toContain("On ");
  });

  it("one on the shown way around says it is on the other way", () => {
    expect(status({ onRoute: false, onDetour: true, routes: ["detour"] })).toContain("On the other way. Marks the spot not passable.");
  });

  it("one only on a way around Lusong judged and isn't showing says so, with its role", () => {
    const html = status({ onRoute: false, onDetour: false, routes: ["detour-2"] });
    expect(html).toContain("On a way around Lusong checked and isn&#x27;t showing. Marks the spot not passable.");
    expect(html).not.toContain("Not on your route.");
  });

  it("one on no judged route is not on your route", () => {
    expect(status({ onRoute: false, onDetour: false, routes: [] })).toContain("Not on your route.");
  });

  it("an old one is shown, not counted, wherever it lies", () => {
    expect(status({ counts: false, onRoute: false, routes: ["detour-2"] })).toContain("Older than 3 hours: shown, not counted.");
  });
});

describe("blurred photos on report pins (#8, criterion 4)", () => {
  const pin = { id: "r1", at: REPORT.at, sample: false, place: REPORT.place, age: REPORT.age, depth: REPORT.depth, passability: REPORT.passability, counts: true, role: "block" as const };

  it("a pin whose report has a published photo shows it in its popup, with the same plain alt text", () => {
    const popup = pinPopup({ ...pin, photoUrl: "https://blob.test/report-photos/a.jpg" });
    expect(popup.photo).toEqual({ src: "https://blob.test/report-photos/a.jpg", alt: ALT });
    expect(popup.lines).toEqual(["Governor M. Cuenco Avenue", "40 min ago", "Water about knee-deep.", "Not passable to light vehicles."]);
  });

  it("a pin with no published photo shows none", () => {
    expect(pinPopup({ ...pin, photoUrl: null }).photo).toBeNull();
  });
});
