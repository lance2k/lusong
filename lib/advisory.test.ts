import { describe, expect, it, vi } from "vitest";
import { FEED_URL, readAdvisory } from "./advisory";

import { CAP_EDITS, CV_GFA5, CV_GFA5_LONG, CV_GFA6_FINAL, FEED, feedWith, GFA_URL, NEWEST_PER_REGION, SAVED } from "../test/pagasa-fixtures";

type Served = Record<string, string | (() => Promise<Response>)>;

/** Serves the feed and the given CAP records; every other URL fails as a dropped connection. */
function pagasa(served: Served) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const body = served[u];
    if (typeof body === "function") return body();
    if (body === undefined) throw new TypeError("fetch failed");
    void init;
    return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

const at = (iso: string) => new Date(iso);
const only = (...urls: string[]): Served => Object.fromEntries([[FEED_URL, FEED], ...urls.map((u) => [u, SAVED[u]])]);

describe("reading PAGASA's flood advisory for Cebu", () => {
  it("the Central Visayas advisory sent 2026-10-25 17:27 PHT is active at 20:00 PHT, with its forecast, rivers and times", async () => {
    const { fetch } = pagasa(only(CV_GFA5));
    const result = await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") });
    expect(result).toEqual({
      state: "active",
      advisory: {
        id: "f1232c02-5d52-4786-90aa-46865ab991a4",
        headline: "General Flood Advisory",
        event: "General Flood Advisory (Moderate)",
        rainForecast: "light to moderate rains and thunderstorms",
        riversForCebu: "Kotkot, Mananga, Guinabasan, Balamban and Sabangdaku",
        sent: "2026-10-25T17:27:04+08:00",
        expires: "2026-10-26T05:27:04+08:00",
        link: CV_GFA5,
      },
    });
  });

  it("follows only entries titled GFA, newest first, and asks each URL once", async () => {
    const { fetch, calls } = pagasa(only(CV_GFA5));
    await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") });
    expect(calls[0]).toBe(FEED_URL);
    const feedTitles = new Map(
      [...FEED.matchAll(/<title>([^<]*)<\/title>[\s\S]*?href="([^"]+\.cap)"/g)].map((m) => [m[2], m[1]] as const),
    );
    const followed = calls.slice(1);
    expect(followed.length).toBeGreaterThan(0);
    expect(followed.every((u) => /\bGFA\b/.test(feedTitles.get(u) ?? ""))).toBe(true);
    expect(new Set(calls).size).toBe(calls.length);
    // The Central Visayas advisory is the third-newest GFA entry at that time: the reader stops once it finds it.
    expect(followed).toEqual([
      GFA_URL("3c0fc291-74a3-414b-8ffc-61e3bc7e18fa"),
      GFA_URL("e615201c-d5a9-49ed-880e-052a3a781da7"),
      CV_GFA5,
    ]);
  });

  it("with Typhoon Rosal's warnings in the window (2026-10-24 12:00 PHT), none of those records is fetched", async () => {
    const { fetch, calls } = pagasa(only());
    await readAdvisory({ fetch, now: at("2026-10-24T12:00:00+08:00") });
    expect(FEED).toContain("output/wcp/21b29a06");
    expect(calls.filter((u) => /\/output\/(acp|wcp)\//.test(u))).toEqual([]);
  });

  it("after every Cebu advisory has expired or been closed, with each record read, there is none", async () => {
    const { fetch } = pagasa(only(...NEWEST_PER_REGION));
    expect(await readAdvisory({ fetch, now: at("2026-10-26T17:35:00+08:00") })).toEqual({ state: "none" });
  });

  it("at the feed's date, with each of the eight regions' newest record read and none active: none", async () => {
    const { fetch, calls } = pagasa(only(...NEWEST_PER_REGION));
    expect(await readAdvisory({ fetch, now: at("2026-10-29T12:00:00+08:00") })).toEqual({ state: "none" });
    expect(calls.slice(1).sort()).toEqual([...NEWEST_PER_REGION].sort());
  });

  it("an advisory still active more than 24 h after it was sent is read as active (🔴3)", async () => {
    const noFinalForCebu = feedWith((t) => !t.startsWith("GFA #6 (Final) - Region 7"));
    const { fetch } = pagasa({ ...only(...NEWEST_PER_REGION), [FEED_URL]: noFinalForCebu, [CV_GFA5]: CV_GFA5_LONG });
    const result = await readAdvisory({ fetch, now: at("2026-10-26T20:00:00+08:00") });
    expect(result).toMatchObject({ state: "active", advisory: { id: "f1232c02-5d52-4786-90aa-46865ab991a4", expires: "2026-10-28T05:27:04+08:00" } });
  });

  it("a region's older records are not fetched once its newest is read", async () => {
    const { fetch, calls } = pagasa(only(...NEWEST_PER_REGION));
    await readAdvisory({ fetch, now: at("2026-10-29T12:00:00+08:00") });
    expect(calls).not.toContain(CV_GFA5);
  });

  it("without region names in the titles, a later record that references an earlier one still replaces it", async () => {
    const unnamed = feedWith((t) => t.includes("Region 7")).replace(/ - Region 7 \(Central Visayas\)/g, "");
    const { fetch } = pagasa({ [FEED_URL]: unnamed, [CV_GFA5]: SAVED[CV_GFA5], [CV_GFA6_FINAL]: SAVED[CV_GFA6_FINAL] });
    const result = await readAdvisory({ fetch, now: at("2026-10-26T05:25:00+08:00"), limits: { maxCapFetches: 20 } });
    expect(result.state).not.toBe("active");
  });

  it("a Final advisory (responseType AllClear) is not an active one, though it hasn't expired", async () => {
    const { fetch } = pagasa(only(CV_GFA6_FINAL));
    const result = await readAdvisory({ fetch, now: at("2026-10-26T06:00:00+08:00") });
    expect(result.state).not.toBe("active");
  });

  it("an advisory that a later record references is replaced by it, before its own expiry", async () => {
    const { fetch } = pagasa(only(CV_GFA5, CV_GFA6_FINAL));
    const result = await readAdvisory({ fetch, now: at("2026-10-26T05:25:00+08:00") });
    expect(result.state).not.toBe("active");
  });

  it("an advisory past its expiry is not active (the feed as it stood before the Final records of 2026-10-26)", async () => {
    const beforeFinals = FEED.replace(/<entry>[\s\S]*?<\/entry>\s*/g, (e) => (e.includes("<updated>2026-10-26") ? "" : e));
    expect(beforeFinals).not.toContain("GFA #6 (Final)");
    const { fetch } = pagasa({ [FEED_URL]: beforeFinals, [CV_GFA5]: SAVED[CV_GFA5] });
    const result = await readAdvisory({ fetch, now: at("2026-10-26T05:30:00+08:00") });
    expect(result.state).not.toBe("active");
  });

  it.each([
    { name: "a Test message", edit: (cap: string) => cap.replace("<status>Actual</status>", "<status>Test</status>") },
    { name: "a Cancel message", edit: (cap: string) => cap.replace("<msgType>Update</msgType>", "<msgType>Cancel</msgType>") },
  ])("$name is not an active advisory", async ({ edit }) => {
    const { fetch } = pagasa({ ...only(), [CV_GFA5]: edit(SAVED[CV_GFA5]) });
    expect((await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") })).state).not.toBe("active");
  });

  it("finds Cebu in any <area>, not only the first", async () => {
    const swapped = SAVED[CV_GFA5].replace(/(<area>[\s\S]*?<\/area>)(<area>[\s\S]*?<\/area>)/, "$2$1");
    expect(swapped.indexOf("<areaDesc>Bohol")).toBeLessThan(swapped.indexOf("<areaDesc>Cebu"));
    const { fetch } = pagasa({ ...only(), [CV_GFA5]: swapped });
    expect((await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") })).state).toBe("active");
  });

  it("reads the feed and the CAP by namespace, not by prefix", async () => {
    const prefixedFeed = FEED.replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns:a="http://www.w3.org/2005/Atom"').replace(
      /<(\/?)(feed|entry|id|title|updated|author|name|link|rights)\b/g,
      "<$1a:$2",
    );
    const prefixedCap = SAVED[CV_GFA5].replace('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"', '<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"')
      .replace("</alert>", "</cap:alert>")
      .replace(
      /<(\/?)(identifier|sender|sent|status|msgType|scope|references|info|category|event|responseType|urgency|severity|certainty|expires|senderName|headline|description|instruction|web|contact|parameter|valueName|value|area|areaDesc|polygon|geocode)>/g,
      "<$1cap:$2>",
    );
    const { fetch } = pagasa({ [FEED_URL]: prefixedFeed, [CV_GFA5]: prefixedCap });
    expect((await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") })).state).toBe("active");
  });

  it("elements of the right name in another namespace are not read as the feed", async () => {
    const foreign = FEED.replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns="http://example.com/not-atom"');
    const { fetch } = pagasa({ [FEED_URL]: foreign, [CV_GFA5]: SAVED[CV_GFA5] });
    expect((await readAdvisory({ fetch, now: at("2026-10-25T20:00:00+08:00") })).state).toBe("unreadable");
  });
});

describe("a record missing what decides its state is 'unreadable', never inactive (🔴2)", () => {
  const onlyCebuEntry = feedWith((t) => t === "GFA #5 - Region 7 (Central Visayas)");
  const now = at("2026-10-25T20:00:00+08:00");
  const cap = SAVED[CV_GFA5];

  it("the saved record, alone in the feed, is active (positive control)", async () => {
    const { fetch } = pagasa({ [FEED_URL]: onlyCebuEntry, [CV_GFA5]: cap });
    expect((await readAdvisory({ fetch, now })).state).toBe("active");
  });

  it.each(CAP_EDITS.map((e) => [e.name, e.edit] as const))("%s ⇒ unreadable", async (_name, edit) => {
    const edited = edit(cap);
    expect(edited).not.toBe(cap);
    const { fetch } = pagasa({ [FEED_URL]: onlyCebuEntry, [CV_GFA5]: edited });
    expect((await readAdvisory({ fetch, now })).state).toBe("unreadable");
  });
});

describe("anything malformed or failed is 'unreadable', never 'none'", () => {
  const now = at("2026-10-25T20:00:00+08:00");

  it.each([
    { name: "the feed request fails", served: {} },
    { name: "the feed answers HTTP 500", served: { [FEED_URL]: async () => new Response("down", { status: 500 }) } },
    { name: "the feed is cut off mid-document", served: { [FEED_URL]: FEED.slice(0, 5_000) } },
    { name: "the feed is an HTML error page", served: { [FEED_URL]: "<!doctype html><html><body>502</body></html>" } },
    { name: "an entry's updated time is unparseable", served: { [FEED_URL]: FEED.replace("2026-10-25T17:27:04+08:00", "yesterday") } },
  ])("$name", async ({ served }) => {
    const { fetch } = pagasa(served as Served);
    expect((await readAdvisory({ fetch, now })).state).toBe("unreadable");
  });

  const FINALS = NEWEST_PER_REGION;
  const afterFinals = at("2026-10-26T17:35:00+08:00");

  it("every record read and none active, but more candidates than it may fetch", async () => {
    const { fetch } = pagasa(only(...FINALS));
    expect((await readAdvisory({ fetch, now: afterFinals, limits: { maxCapFetches: 2 } })).state).toBe("unreadable");
  });

  it("a feed served with HTTP 500, even when its body parses", async () => {
    const { fetch } = pagasa({ ...only(...FINALS), [FEED_URL]: async () => new Response(FEED, { status: 500 }) });
    expect((await readAdvisory({ fetch, now: afterFinals })).state).toBe("unreadable");
  });

  it("a GFA entry whose updated time can't be read is not quietly dropped", async () => {
    const broken = FEED.replace("<updated>2026-10-26T05:22:53+08:00</updated>", "<updated>this morning</updated>");
    const { fetch } = pagasa({ ...only(...FINALS), [FEED_URL]: broken });
    expect((await readAdvisory({ fetch, now: afterFinals })).state).toBe("unreadable");
  });

  it("a CAP record that fails, with no active advisory found elsewhere", async () => {
    const { fetch } = pagasa(only());
    expect((await readAdvisory({ fetch, now })).state).toBe("unreadable");
  });

  it("a malformed CAP record, with no active advisory found elsewhere", async () => {
    const { fetch } = pagasa({ ...only(), [CV_GFA5]: SAVED[CV_GFA5].replace("</expires>", "") });
    expect((await readAdvisory({ fetch, now, limits: { maxCapFetches: 3 } })).state).toBe("unreadable");
  });

  it("a CAP record with an unparseable expiry", async () => {
    const { fetch } = pagasa({ ...only(), [CV_GFA5]: SAVED[CV_GFA5].replace("2026-10-26T05:27:04+08:00", "soon") });
    expect((await readAdvisory({ fetch, now, limits: { maxCapFetches: 3 } })).state).toBe("unreadable");
  });

  it("more GFA entries in the window than it may fetch, none of them active: stops at the limit", async () => {
    const { fetch, calls } = pagasa(only(CV_GFA5));
    expect((await readAdvisory({ fetch, now, limits: { maxCapFetches: 2 } })).state).toBe("unreadable");
    expect(calls).toHaveLength(3);
  });

  it("a feed larger than its byte limit", async () => {
    const { fetch } = pagasa(only(CV_GFA5));
    expect((await readAdvisory({ fetch, now, limits: { maxBytes: 1_000 } })).state).toBe("unreadable");
  });

  it("a feed that never answers is given up on at the time limit", async () => {
    const hang = (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    const result = await readAdvisory({ fetch: vi.fn(hang) as unknown as typeof fetch, now, limits: { timeoutMs: 50 } });
    expect(result.state).toBe("unreadable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks PAGASA with Lusong's named User-Agent", async () => {
    const seen: (string | null)[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("user-agent"));
      return new Response(FEED);
    });
    await readAdvisory({ fetch: fetchMock as unknown as typeof fetch, now: at("2026-10-29T12:00:00+08:00") });
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set(["Lusong/0.1 (hackathon entry; github.com/lance2k/lusong)"]));
  });
});
