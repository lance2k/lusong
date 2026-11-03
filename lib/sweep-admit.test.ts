import { describe, expect, it } from "vitest";
import { alertMessage, MemoryAlertStore, type SweepFields } from "./alerts";
import type { Place } from "./built-in-places";
import type { SafeFetchResult } from "./safe-fetch";
import { admitCandidate, blocksAt, canonicalUrl, organisationOf, publishedAt, roadName, robotsChecker, SWEEP_BLOCKING, type AdmitDeps, type Candidate } from "./sweep-admit";

const NOW = new Date("2026-11-04T10:00:00+08:00");
const ROAD = { key: "highway", type: "street" };
const MANDAUE_PLACE: Place = { id: "osm:way1", name: "A. S. Fortuna Street", area: "Banilad, Mandaue", lat: 10.338, lon: 123.918, source: "osm", feature: ROAD };
const DAVAO_PLACE: Place = { id: "osm:way2", name: "A.S. Fortuna Street", area: "Davao City", lat: 7.07, lon: 125.61, source: "osm", feature: ROAD };
const FAR_IN_CEBU: Place = { id: "osm:way3", name: "A.S. Fortuna St.", area: "Bogo", lat: 11.05, lon: 124.0, source: "osm", feature: ROAD };

/** A page as a site would serve it: its own publication time in its metadata, the text in its body. */
function page(body: string, published: string | null = "2026-11-04T08:30:00+08:00", extraHead = ""): string {
  const meta = published ? `<meta property="article:published_time" content="${published}">` : "";
  return `<!doctype html><html><head><title>Advisory</title>${meta}${extraHead}<script>var x = "closed flood";</script></head><body><article>${body}</article><footer>Mandaue City, Cebu</footer></body></html>`;
}

const CLOSED = "Traffic advisory: A.S. Fortuna Street in Mandaue City, Cebu is closed to traffic due to flooding until further notice.";

function harness(pages: Record<string, string | SafeFetchResult>, places: Place[] | "busy" = [MANDAUE_PLACE], robots: Record<string, string> = {}) {
  const fetched: string[] = [];
  const geocoded: string[] = [];
  const fetchPage = async (url: string): Promise<SafeFetchResult> => {
    fetched.push(url);
    const host = new URL(url).host;
    if (url.endsWith("/robots.txt")) return robots[host] !== undefined ? { ok: true, url, status: 200, contentType: "text/plain", body: robots[host] } : { ok: true, url, status: 404, contentType: "text/html", body: "" };
    const p = pages[url];
    if (p === undefined) return { ok: true, url, status: 404, contentType: "text/html", body: "" };
    return typeof p === "string" ? { ok: true, url, status: 200, contentType: "text/html; charset=utf-8", body: p } : p;
  };
  const deps: AdmitDeps = {
    fetchPage,
    geocode: async (q) => {
      geocoded.push(q);
      return places === "busy" ? { status: "unavailable" } : { status: "ok", places };
    },
    now: NOW,
  };
  const robotsFor = robotsChecker(fetchPage);
  return { fetched, geocoded, admit: (c: Candidate) => admitCandidate(c, { ...deps, robots: robotsFor }) };
}

const URL_GOV = "https://mandauecity.gov.ph/advisories/fortuna";
const CANDIDATE: Candidate = { url: URL_GOV, place: "A.S. Fortuna Street", province: "Cebu", kind: "closure" };

describe("admitting a sweep candidate (ledger #4/#10)", () => {
  it("admits a fresh official page naming the place, the province and a closure term, as a warning at the geocoded spot", async () => {
    const h = harness({ [URL_GOV]: page(CLOSED) });
    const got = await h.admit(CANDIDATE);
    expect(got.outcome).toBe("admitted");
    if (got.outcome !== "admitted") return;
    expect(got.alert).toMatchObject({
      kind: "office_post",
      severity: "warn",
      origin: "sweep",
      sourceOrg: "the Mandaue City government",
      sourceUrl: URL_GOV,
      eventAt: "2026-11-04T00:30:00.000Z",
      expiresAt: "2026-11-04T12:30:00.000Z",
      scope: { point: { lat: 10.338, lon: 123.918 }, radiusM: 500 },
    });
    expect(alertMessage(got.alert, [])).toBe(
      "The Mandaue City government reports a road closure at A. S. Fortuna Street, Banilad, Mandaue, posted 4 Nov, 8:30 a.m. PHT. Unconfirmed by Lusong. https://mandauecity.gov.ph/advisories/fortuna",
    );
  });

  it.each([
    ["the page lacks the place", page("Colon Street in Cebu is closed to traffic.")],
    ["the page lacks a closure or flood term", page("A.S. Fortuna Street in Mandaue City, Cebu will host a fiesta parade.")],
    ["the term is far from the place", page(`A.S. Fortuna Street in Mandaue City, Cebu. ${"Lorem ipsum dolor sit amet. ".repeat(40)} Another road is closed.`)],
  ])("refuses an unsupported item: %s", async (_name, html) => {
    expect((await harness({ [URL_GOV]: html }).admit(CANDIDATE)).outcome).toBe("refused");
  });

  it("refuses a page that doesn't name the province the item says", async () => {
    const got = await harness({ [URL_GOV]: page(CLOSED.replace(", Cebu", "")).replace("Mandaue City, Cebu", "Mandaue City") }).admit(CANDIDATE);
    expect(got).toEqual({ outcome: "refused", why: "the page doesn't name the province" });
  });

  it("refuses a page that doesn't name the place the item says (ledger #4)", async () => {
    const html = page("Traffic advisory: a street in Mandaue City, Cebu is closed to traffic due to flooding until further notice.");
    expect(await harness({ [URL_GOV]: html }).admit(CANDIDATE)).toEqual({ outcome: "refused", why: "the page doesn't name the place" });
  });

  it("refuses a page that names the place with no closure or flood term near it (ledger #4)", async () => {
    const html = page("A.S. Fortuna Street in Mandaue City, Cebu hosts the city's fiesta parade this weekend.");
    expect(await harness({ [URL_GOV]: html }).admit(CANDIDATE)).toEqual({ outcome: "refused", why: "no closure or flood term near the place" });
  });

  it.each([
    ["older than 48 hours", "2026-11-02T09:59:00+08:00", "older than 48 hours"],
    ["dated in the future", "2026-11-04T10:05:00+08:00", "published in the future"],
    ["past its 12 hours", "2026-11-03T21:00:00+08:00", "its 12 hours have passed"],
    ["without structured publication data", null, "no structured publication time"],
  ])("refuses a page %s", async (_name, published, why) => {
    expect(await harness({ [URL_GOV]: page(CLOSED, published) }).admit(CANDIDATE)).toEqual({ outcome: "refused", why });
  });

  it("an item placed outside the province its page names is a province-wide warning, never a spot", async () => {
    const got = await harness({ [URL_GOV]: page(CLOSED) }, [DAVAO_PLACE]).admit(CANDIDATE);
    expect(got).toMatchObject({ outcome: "admitted", alert: { severity: "warn", scope: { codes: ["0702200000"] }, fields: { place: "a place in Cebu" } } });
  });

  it("a sole same-province answer with an unrelated name is a province-wide warning, never a spot (S4D-2)", async () => {
    const other: Place = { ...MANDAUE_PLACE, id: "osm:way9", name: "Completely Different Road" };
    const got = await harness({ [URL_GOV]: page(CLOSED) }, [other]).admit(CANDIDATE);
    expect(got).toMatchObject({ outcome: "admitted", alert: { scope: { codes: ["0702200000"] }, fields: { place: "a place in Cebu" } } });
  });

  it("a city, locality or other centroid answer named as the page names it is never a spot (S4D-2)", async () => {
    const centroids: Place[] = [
      { ...MANDAUE_PLACE, id: "osm:r1", feature: { key: "place", type: "city" } },
      { ...MANDAUE_PLACE, id: "osm:r2", feature: { key: "boundary", type: "district" } },
      { ...MANDAUE_PLACE, id: "osm:r3", feature: { key: "landuse", type: "locality" } },
      { ...MANDAUE_PLACE, id: "built-in:x", source: "built-in", feature: undefined },
    ];
    for (const c of centroids) {
      const got = await harness({ [URL_GOV]: page(CLOSED) }, [c]).admit(CANDIDATE);
      expect(got, c.id).toMatchObject({ outcome: "admitted", alert: { scope: { codes: ["0702200000"] } } });
    }
  });

  it("the road's name matches across case, diacritics and St./Street (S4D-2)", async () => {
    const spelled: Place = { ...MANDAUE_PLACE, name: "A.S. FORTUNA St." };
    const got = await harness({ [URL_GOV]: page(CLOSED) }, [spelled]).admit(CANDIDATE);
    expect(got).toMatchObject({ outcome: "admitted", alert: { scope: { point: { lat: 10.338, lon: 123.918 } } } });
    expect(roadName("Avenida Rizal, Cebu")).toBe(roadName("AVENIDA RIZAL"));
    expect(roadName("Sto. Niño St.")).toBe("santo nino street");
  });

  it("an ambiguous place (two far-apart answers in the province) is a province-wide warning", async () => {
    const got = await harness({ [URL_GOV]: page(CLOSED) }, [MANDAUE_PLACE, FAR_IN_CEBU]).admit(CANDIDATE);
    expect(got).toMatchObject({ outcome: "admitted", alert: { scope: { codes: ["0702200000"] } } });
  });

  it("a busy geocoder leaves the item for the next run rather than guessing", async () => {
    expect(await harness({ [URL_GOV]: page(CLOSED) }, "busy").admit(CANDIDATE)).toEqual({ outcome: "retry", why: "the geocoder is busy" });
  });

  it("the same page, place and kind is one item: a re-seen item keeps its first time and expiry", async () => {
    const tracked = `${URL_GOV}?utm_source=fb#top`;
    const first = await harness({ [URL_GOV]: page(CLOSED) }).admit(CANDIDATE);
    const again = await harness({ [URL_GOV]: page(CLOSED, "2026-11-04T09:30:00+08:00") }).admit({ ...CANDIDATE, url: tracked, place: "a.s. fortuna  street" });
    if (first.outcome !== "admitted" || again.outcome !== "admitted") throw new Error("both admitted");
    expect(again.alert.id).toBe(first.alert.id);
    const store = new MemoryAlertStore();
    expect(await store.addIfAbsent([first.alert])).toBe(1);
    expect(await store.addIfAbsent([again.alert])).toBe(0);
    expect(await store.all(NOW.getTime())).toEqual([first.alert]);
    expect(canonicalUrl(tracked)).toBe(URL_GOV);
  });

  it("nothing the model wrote reaches the rider: organisation from the host, time from the page, place from the geocoder", async () => {
    const model = { ...CANDIDATE, organisation: "The Totally Official Office", event_date: "2026-10-01", place: "a.s. FORTUNA street" } as Candidate;
    const got = await harness({ [URL_GOV]: page(CLOSED) }).admit(model);
    if (got.outcome !== "admitted") throw new Error("admitted");
    const text = alertMessage(got.alert, []);
    expect(text).not.toMatch(/Totally|2026-10-01|FORTUNA/);
    expect(text).toContain("A. S. Fortuna Street, Banilad, Mandaue");
    expect(organisationOf("www.rappler.com")).toBe("Rappler");
    expect(organisationOf("lgu-somewhere.gov.ph")).toBe("lgu-somewhere.gov.ph");
  });

  it("never fetches a host off the allowlist (Facebook), nor a page robots.txt disallows", async () => {
    const h = harness({ "https://www.facebook.com/mandauecdrrmo/posts/1": page(CLOSED), [URL_GOV]: page(CLOSED) }, [MANDAUE_PLACE], { "mandauecity.gov.ph": "User-agent: *\nDisallow: /advisories\n" });
    expect(await h.admit({ ...CANDIDATE, url: "https://www.facebook.com/mandauecdrrmo/posts/1" })).toEqual({ outcome: "refused", why: "www.facebook.com is not on the allowlist" });
    expect(await h.admit(CANDIDATE)).toEqual({ outcome: "refused", why: "robots.txt disallows it" });
    expect(h.fetched).toEqual(["https://mandauecity.gov.ph/robots.txt"]);
  });

  it("a news page is a closure item named for the paper, never an office post", async () => {
    const news = "https://www.sunstar.com.ph/cebu/fortuna-flooded";
    const got = await harness({ [news]: page("Floodwaters made A.S. Fortuna Street in Mandaue, Cebu impassable on Wednesday morning.") }).admit({ ...CANDIDATE, url: news, kind: "flood" });
    expect(got).toMatchObject({ outcome: "admitted", alert: { kind: "closure", sourceOrg: "SunStar", severity: "warn" } });
  });
});

describe("publication times from structured data only (S4P-7)", () => {
  it("reads article:published_time, JSON-LD datePublished, then <time datetime>", () => {
    expect(publishedAt('<meta content="2026-11-04T08:30:00+08:00" property="article:published_time">')).toBe(Date.parse("2026-11-04T08:30:00+08:00"));
    expect(publishedAt('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-04T00:30:00Z"}</script>')).toBe(Date.parse("2026-11-04T00:30:00Z"));
    expect(publishedAt('<p>Posted <time datetime="2026-11-04T08:30">8:30</time></p>')).toBe(Date.parse("2026-11-04T08:30:00+08:00"));
    expect(publishedAt("<p>Posted November 4, 2026</p>")).toBeNull();
  });

  it("a date alone is read as 00:00 PHT", () => {
    expect(publishedAt('<meta property="article:published_time" content="2026-11-04">')).toBe(Date.parse("2026-11-04T00:00:00+08:00"));
  });

  it("a fresh article about an old closure is dated by its publication, and says 'posted' (the narrowed residual risk)", async () => {
    const old = page("A.S. Fortuna Street in Mandaue City, Cebu, closed on October 1 for repairs, is in the news again.", "2026-11-04T08:30:00+08:00");
    const got = await harness({ [URL_GOV]: old }).admit(CANDIDATE);
    if (got.outcome !== "admitted") throw new Error("admitted");
    expect((got.alert.fields as SweepFields).posted).toBe("2026-11-04T00:30:00.000Z");
    expect(alertMessage(got.alert, [])).toContain("posted 4 Nov, 8:30 a.m. PHT. Unconfirmed by Lusong.");
  });
});

describe("the blocking gate's fixtures (S4P-10): with SWEEP_BLOCKING false, every one only warns", () => {
  const cases: [string, string, string, boolean][] = [
    ["negation", "Fortuna Street is not closed to traffic, the city said.", "Fortuna Street", false],
    ["reopening", "Fortuna Street reopened after being closed by floods on Tuesday.", "Fortuna Street", false],
    ["several roads: the open one", "Road A is open to all vehicles. Road B is closed due to flooding.", "Road A", false],
    ["several roads: the closed one", "Road A is open to all vehicles. Road B is closed due to flooding.", "Road B", true],
    ["a plain closure", "Fortuna Street is impassable to light vehicles.", "Fortuna Street", true],
  ];

  it.each(cases)("%s: the classifier says %s", (_name, text, place, blocks) => {
    expect(blocksAt(text, place)).toBe(blocks);
  });

  it("the gate is closed and every admitted item is a warning, even a plain closure on an official page", async () => {
    expect(SWEEP_BLOCKING).toBe(false);
    let admitted = 0;
    for (const [, text, place] of cases) {
      const html = page(`${text} ${place} is in Mandaue City, Cebu.`);
      const got = await harness({ [URL_GOV]: html }).admit({ ...CANDIDATE, place });
      if (got.outcome === "admitted") {
        admitted += 1;
        expect(got.alert.severity).toBe("warn");
      }
    }
    // Positive control: the loop must have checked something, or the test passes on no admissions at all.
    expect(admitted).toBeGreaterThan(0);
  });
});
