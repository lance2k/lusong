import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MusePick, WebFindings } from "./commute-muse";

describe("Muse Spark on the commute page", () => {
  const LABEL = "Muse Spark picked this evidence";

  it("the picked evidence is shown in Lusong's sentences, labelled, as plain text", () => {
    const html = renderToStaticMarkup(
      <MusePick pick={{ shown: true, label: LABEL, sentences: ["Nothing reported blocks the other way.", "<b>x</b>"], note: null }} />,
    );
    expect(html).toContain("Muse Spark picked this evidence");
    expect(html).toContain("Nothing reported blocks the other way.");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Muse Spark chose which evidence to show. Lusong wrote these lines, and its rules picked the answer.");
  });

  it("says the pick is unavailable when Muse Spark failed, and shows nothing when its pick was set aside", () => {
    const unavailable = renderToStaticMarkup(
      <MusePick pick={{ shown: false, label: LABEL, sentences: [], note: "Muse Spark couldn't pick the evidence for this check." }} />,
    );
    expect(unavailable).toContain("Muse Spark couldn&#x27;t pick the evidence for this check.");
    expect(renderToStaticMarkup(<MusePick pick={{ shown: false, label: LABEL, sentences: [], note: null }} />)).toBe("");
  });

  it("each web finding shows its link and whether it counts, and the search line", () => {
    const html = renderToStaticMarkup(
      <WebFindings
        web={{
          line: "Searched the web at 29 Oct, 12:00 p.m. PHT",
          findings: [{ place: "Colon St", url: "https://example.ph/colon", site: "example.ph", sourceDate: null, description: "Flooded, says an undated page on example.ph.", counted: false, note: "Shown, not counted: it has no date and no place on the map." }],
        }}
      />,
    );
    expect(html).toContain("Searched the web at 29 Oct, 12:00 p.m. PHT");
    expect(html).toContain('href="https://example.ph/colon"');
    expect(html).toContain("Shown, not counted: it has no date and no place on the map.");
    expect(html).toContain("Flooded, says an undated page on example.ph.");
  });
});
