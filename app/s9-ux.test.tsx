import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapLegend } from "./map-legend";
import { DEFAULT_LAYERS, legendRows } from "./map-layers";
import ReportStreet, { REPORT_PICK_LINE } from "./report";

describe("S9 UX polish", () => {
  it("says at the report button that the photo is shown before anything is sent (#48 replaced the pick-sends line)", () => {
    expect(renderToStaticMarkup(<ReportStreet />)).toContain(REPORT_PICK_LINE.replace(/'/g, "&#x27;"));
  });

  it("makes each whole legend row the switch's label, named by its title and described by its lines", () => {
    const html = renderToStaticMarkup(<MapLegend rows={legendRows(null, null)} layers={DEFAULT_LAYERS} onToggle={() => {}} samplesShown={false} />);
    expect(html).toMatch(/<label for="layer-rain" class="[^"]*min-h-11/);
    expect(html).toContain('aria-labelledby="layer-rain-name"');
    expect(html).toContain('aria-describedby="layer-rain-lines"');
    expect(html).toMatch(/<span id="layer-rain-name"[^>]*>Rain now<\/span>/);
    // One label per row: no label nested in another.
    expect((html.match(/<label/g) ?? []).length).toBe(5);
  });
});
