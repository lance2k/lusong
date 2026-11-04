import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CommuteResult, PageAdvisory, PageProduct } from "./commute-result";
import { Advisory, Evidence } from "./evidence";

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

describe("the sweep's posts in the evidence (S4b)", () => {
  const reply = JSON.parse(readFileSync("test/fixtures/commute/mabolo-flooded-advisory-active.reply-f52f847.json", "utf8")) as CommuteResult;
  const render = (r: CommuteResult) =>
    renderToStaticMarkup(<Evidence result={r} onShowReport={() => {}} onReport={() => {}} />).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("are listed as unconfirmed with their source, and leave the answer's evidence as it was", () => {
    const post = { id: "sweep:1", text: "The Cebu City government reports a road closure at Gorordo Avenue, posted 4 Nov, 9:30 a.m. PHT. Unconfirmed by Lusong.", link: "https://cebucity.gov.ph/a/1" };
    const t = render({ ...reply, sweepWarnings: [post] });
    expect(t).toContain("Posts near your way");
    expect(t).toContain("hasn't confirmed them. They don't change the answer.");
    expect(t).toContain(post.text);
    expect(renderToStaticMarkup(<Evidence result={{ ...reply, sweepWarnings: [post] }} onShowReport={() => {}} onReport={() => {}} />)).toContain('href="https://cebucity.gov.ph/a/1"');
    expect(render({ ...reply, sweepWarnings: [] })).not.toContain("Posts near your way");
    expect(render(reply)).not.toContain("Posts near your way");
  });
});

describe("where the route meets the road (#41)", () => {
  const reply = JSON.parse(readFileSync("test/fixtures/commute/mabolo-flooded-advisory-active.reply-f52f847.json", "utf8")) as CommuteResult;
  const render = (r: CommuteResult) =>
    renderToStaticMarkup(<Evidence result={r} onShowReport={() => {}} onReport={() => {}} />).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("says the answer is for the route from the road when the route starts away from the pick, and nothing otherwise", () => {
    expect(render({ ...reply, route: { ...reply.route, roadGap: { fromM: 115, toM: null } } })).toContain(
      "This route starts on the road 115 m from your start; the answer is for the route from there.",
    );
    expect(render(reply)).not.toContain("on the road");
  });
});
