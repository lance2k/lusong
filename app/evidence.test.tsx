import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PageAdvisory, PageProduct } from "./commute-result";
import { Advisory } from "./evidence";

const PRODUCT: PageProduct = {
  counts: true,
  event: "General Flood Advisory",
  area: "Cebu",
  sent: "3 Nov, 9:00 p.m. PHT",
  expires: "4 Nov, 3:00 a.m. PHT",
  link: "https://pagasa.example/cap/1",
  rainForecast: "light to moderate rains",
  rivers: "Butuanon",
};
const text = (a: PageAdvisory) => renderToStaticMarkup(<Advisory advisory={a} />).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the advisory card in the evidence (S1's wording, moved)", () => {
  it("lists every covering product with its forecast, rivers, times and record", () => {
    const t = text({ state: "active", about: "the other way", products: [PRODUCT, { ...PRODUCT, counts: false, event: "Thunderstorm Advisory", link: "l2" }], warnings: [], incomplete: false, note: null });
    expect(t).toContain("PAGASA advisories on the other way");
    expect(t).toContain("General Flood Advisory for Cebu");
    expect(t).toContain("Thunderstorm Advisory for Cebu (shown only)");
    expect(t).toContain("Rain forecast: light to moderate rains.");
    expect(t).toContain("Rivers named: Butuanon.");
    expect(t).toContain("Sent 3 Nov, 9:00 p.m. PHT. Expires 4 Nov, 3:00 a.m. PHT.");
    expect(t).toContain("PAGASA's record");
  });

  it("an incomplete read is flagged and its note is not repeated; products it couldn't place are listed", () => {
    const t = text({ state: "unreadable", about: "your way", products: [], warnings: [PRODUCT], incomplete: true, note: "Lusong couldn't read all of PAGASA's advisories, so it counts one as active." });
    expect(t).toContain("Incomplete: Lusong couldn't read all of PAGASA's feed, so it counts an advisory as active.");
    expect(t).not.toContain("so it counts one as active");
    expect(t).toContain("PAGASA advisories Lusong couldn't place on the map:");
  });

  it("with nothing covering the way, the server's note shows", () => {
    const t = text({ state: "none", about: "your way", products: [], warnings: [], incomplete: false, note: "No PAGASA advisory in its feed covers this way right now." });
    expect(t).toContain("No PAGASA advisory in its feed covers this way right now.");
  });
});
