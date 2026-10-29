import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MuseSummary, WebFindings } from "./commute-muse";

describe("Muse Spark on the commute page", () => {
  it("its summary is plain text: markup in a sentence is shown, never run", () => {
    const html = renderToStaticMarkup(
      <MuseSummary summary={{ shown: true, label: "Muse Spark's summary", sentences: ['<img src=x onerror="alert(1)"> Banilad is flooded.'], note: null }} />,
    );
    expect(html).toContain("Muse Spark&#x27;s summary");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Banilad is flooded.");
    expect(html).not.toContain("<img");
  });

  it("says the explanation is unavailable when Muse Spark failed, and shows nothing when its summary was set aside", () => {
    const unavailable = renderToStaticMarkup(
      <MuseSummary summary={{ shown: false, label: "Muse Spark's summary", sentences: [], note: "Muse Spark's explanation is unavailable." }} />,
    );
    expect(unavailable).toContain("Muse Spark&#x27;s explanation is unavailable.");
    expect(renderToStaticMarkup(<MuseSummary summary={{ shown: false, label: "Muse Spark's summary", sentences: [], note: null }} />)).toBe("");
  });

  it("each web finding shows its link and whether it counts, and the search line", () => {
    const html = renderToStaticMarkup(
      <WebFindings
        web={{
          line: "Searched the web at 29 Oct, 12:00 p.m. PHT",
          findings: [{ place: "Colon St", url: "https://example.ph/colon", sourceDate: null, summary: "Flooded.", counted: false, note: "Shown, not counted: it has no date and no place on the map." }],
        }}
      />,
    );
    expect(html).toContain("Searched the web at 29 Oct, 12:00 p.m. PHT");
    expect(html).toContain('href="https://example.ph/colon"');
    expect(html).toContain("Shown, not counted: it has no date and no place on the map.");
  });
});
