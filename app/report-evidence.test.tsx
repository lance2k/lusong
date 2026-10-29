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
