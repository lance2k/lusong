import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FEED_URL } from "./advisory";
import {
  capKey,
  judgeRoute,
  kindOf,
  MemoryAdvisoryStore,
  readStoredSnapshot,
  recordUrl,
  refreshSnapshot,
  SNAPSHOT_KEY,
  SNAPSHOT_LEASE_KEY,
  SNAPSHOT_LEASE_MS,
  snapshotForCheck,
  UpstashAdvisoryStore,
  type AdvisoryStore,
  type SnapshotReading,
} from "./advisory-snapshot";
import {
  ALL_SAVED,
  CAGAYAN_GFA4,
  CAGAYAN_GFA4_CANCEL,
  CAGAYAN_GFA4_REISSUED,
  CAGAYAN_GFA6_BATANES,
  CV_GFA5,
  DAVAO_GFA1_ALERT,
  DAVAO_GFA1_UPDATE,
  DAVAO_GFA2,
  DAVAO_GFA3_FINAL,
  feedOf,
  ROSAL_ALERT_PAR,
  ROSAL_SIGNAL1_BATANES,
} from "../test/pagasa-fixtures";

const at = (iso: string) => new Date(iso);

const CEBU_ROUTE = [
  { lat: 10.2935, lon: 123.902 },
  { lat: 10.3304, lon: 123.9058 },
];
const DAVAO_CITY_ROUTE = [
  { lat: 7.0731, lon: 125.6128 },
  { lat: 7.09, lon: 125.62 },
];
const DAVAO_DE_ORO_ROUTE = [
  { lat: 7.55, lon: 125.95 },
  { lat: 7.6078, lon: 125.9664 },
];
const BASCO_ROUTE = [
  { lat: 20.4487, lon: 121.9702 },
  { lat: 20.43, lon: 121.96 },
];
const TUGUEGARAO_ROUTE = [
  { lat: 17.6132, lon: 121.727 },
  { lat: 17.63, lon: 121.74 },
];

type Served = Record<string, string | (() => Promise<Response>)>;

/** Serves the given URLs; every other one fails as a dropped connection. */
function pagasa(served: Served) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const body = served[u];
    if (typeof body === "function") return body();
    if (body === undefined) throw new TypeError("fetch failed");
    return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

/** A feed listing these saved records, served with them (edited where asked). */
function listing(links: string[], edits: Record<string, (cap: string) => string> = {}): Served {
  return Object.fromEntries([[FEED_URL, feedOf(links)], ...links.map((l) => [l, (edits[l] ?? ((c: string) => c))(ALL_SAVED[l])])]);
}

async function snapshotAt(iso: string, served: Served, store: AdvisoryStore = new MemoryAdvisoryStore()) {
  const net = pagasa(served);
  const outcome = await refreshSnapshot({ store, fetch: net.fetch, now: () => at(iso) });
  if (outcome.outcome !== "published") throw new Error(`refresh ${outcome.outcome}`);
  const reading: SnapshotReading = { snapshot: outcome.snapshot };
  return { reading, snapshot: outcome.snapshot, net, store, judge: (line: { lat: number; lon: number }[], when = iso) => judgeRoute(reading, line, at(when)) };
}

describe("the kinds of PAGASA products", () => {
  it("maps every event name in the saved feeds and records, flood, rainfall and cyclone counting", () => {
    expect(kindOf("General Flood Advisory (Moderate)")).toBe("flood");
    expect(kindOf("General Flood Advisory (Severe)")).toBe("flood");
    expect(kindOf("General Flood Advisory (Final)")).toBe("flood");
    expect(kindOf("Tropical Cyclone Warning")).toBe("cyclone");
    expect(kindOf("Tropical Cyclone Alert")).toBe("cyclone");
    expect(kindOf("Heavy Rainfall Warning")).toBe("rainfall");
    expect(kindOf("Tsunami Information")).toBe("other");
  });
});

describe("the whole-feed snapshot, product by product", () => {
  it("flood and cyclone products in one region both apply: Batanes's GFA #6 and Rosal's Signal #1 at 2026-10-24 06:00 PHT", async () => {
    const { judge, snapshot } = await snapshotAt("2026-10-24T06:00:00+08:00", listing([CAGAYAN_GFA6_BATANES, ROSAL_SIGNAL1_BATANES]));
    expect(snapshot.complete).toBe(true);
    const basco = judge(BASCO_ROUTE);
    expect(basco.state).toBe("active");
    expect(basco.covering.map((p) => [p.kind, p.event])).toEqual([
      ["flood", "General Flood Advisory (Severe)"],
      ["cyclone", "Tropical Cyclone Warning"],
    ]);
    expect(basco.covering.every((p) => p.counts && p.areas.includes("Batanes"))).toBe(true);
    expect(judge(CEBU_ROUTE)).toMatchObject({ state: "none", covering: [], warnings: [], incomplete: null });
  });

  it("a cancellation removes only its own product: Cagayan Valley's GFA #4, cancelled, and its reissue, at 2026-10-23 05:45 PHT", async () => {
    const links = [CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL, CAGAYAN_GFA4_REISSUED];
    const { snapshot, judge } = await snapshotAt("2026-10-23T05:45:00+08:00", listing(links));
    expect(snapshot.products.map((p) => p.id)).toEqual(["855536fb-a3b5-4721-9015-92cc1dd493dc"]);
    expect(judge(TUGUEGARAO_ROUTE).covering.map((p) => p.link)).toEqual([CAGAYAN_GFA4_REISSUED]);

    // Control: without the cancellation, both are live.
    const uncancelled = await snapshotAt("2026-10-23T05:45:00+08:00", listing([CAGAYAN_GFA4, CAGAYAN_GFA4_REISSUED]));
    expect(uncancelled.snapshot.products.map((p) => p.link).sort()).toEqual([CAGAYAN_GFA4, CAGAYAN_GFA4_REISSUED].sort());
  });

  it("an update replaces its own product: Davao's GFA #1 alert, then its update five minutes later", async () => {
    const both = listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]);
    const before = await snapshotAt("2026-10-30T21:08:00+08:00", both);
    expect(before.snapshot.products.map((p) => p.link)).toEqual([DAVAO_GFA1_ALERT]);
    const after = await snapshotAt("2026-10-30T21:30:00+08:00", both);
    expect(after.snapshot.products.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);
    expect(after.judge(DAVAO_CITY_ROUTE).covering.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);
    expect(after.judge(CEBU_ROUTE).state).toBe("none");
  });

  it("the Final all-clear ends Davao's chain: no product left, the Davao route has none", async () => {
    const { snapshot, judge } = await snapshotAt("2026-10-31T18:00:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE, DAVAO_GFA2, DAVAO_GFA3_FINAL]));
    expect(snapshot.complete).toBe(true);
    expect(snapshot.products).toEqual([]);
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("none");
  });

  it("an info past its expiry drops out when the snapshot is read, not only when it is built", async () => {
    const { judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]));
    // The update expires at 2026-10-31 09:11:07 PHT; this reads it 10 minutes later.
    expect(judge(DAVAO_CITY_ROUTE, "2026-10-31T09:21:00+08:00").covering).toEqual([]);
  });

  it("a nationwide CAP record covers both a Cebu and a Davao route", async () => {
    const nationwide = (cap: string) =>
      cap.replace(/<areaDesc>[^<]*<\/areaDesc>/, "<areaDesc>Philippines</areaDesc>").replace(/<polygon>[^<]*<\/polygon>/g, "");
    const { judge } = await snapshotAt("2026-10-24T12:00:00+08:00", listing([ROSAL_ALERT_PAR], { [ROSAL_ALERT_PAR]: nationwide }));
    for (const route of [CEBU_ROUTE, DAVAO_CITY_ROUTE]) {
      const advisory = judge(route);
      expect(advisory.state).toBe("active");
      expect(advisory.covering.map((p) => p.areas)).toEqual([["Philippines"]]);
    }
  });

  it("the real Tropical Cyclone Alert's area-of-responsibility polygon covers Cebu and Davao routes too", async () => {
    const { judge } = await snapshotAt("2026-10-24T12:00:00+08:00", listing([ROSAL_ALERT_PAR]));
    expect(judge(CEBU_ROUTE).covering.map((p) => p.event)).toEqual(["Tropical Cyclone Alert"]);
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("active");
  });

  it("a Manila route judged after a Cebu route from the same snapshot gets none of Cebu's advisory (ledger #2)", async () => {
    const { judge } = await snapshotAt("2026-10-25T20:00:00+08:00", listing([CV_GFA5]));
    expect(judge(CEBU_ROUTE).state).toBe("active");
    const manila = judge([
      { lat: 14.6191, lon: 121.0537 },
      { lat: 14.5683, lon: 121.0244 },
    ]);
    expect(manila).toMatchObject({ state: "none", covering: [] });
  });

  it("an unplaceable area named for Davao de Oro (118200000, no polygon) doesn't touch a Cebu route and does touch one in Davao de Oro", async () => {
    // Davao de Oro's area alone, with its polygon taken away: only its geocode and name place it.
    const unplaced = (cap: string) => cap.replace(/(<\/area>)[\s\S]*(<\/info>)/, "$1$2").replace(/<polygon>[^<]*<\/polygon>/g, "");
    expect(unplaced(ALL_SAVED[DAVAO_GFA1_UPDATE])).toContain("<value>118200000</value>");
    const { judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE], { [DAVAO_GFA1_UPDATE]: unplaced }));
    expect(judge(CEBU_ROUTE)).toMatchObject({ state: "none", covering: [], warnings: [] });
    expect(judge(DAVAO_DE_ORO_ROUTE)).toMatchObject({ state: "active", covering: [{ areas: ["Davao De Oro"] }] });
    // Davao City is in Davao del Sur: the area is bounded by its own province, never widened to the region.
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("none");
  });

  it("an area that can't be bounded at all is a warning on every route, never covering", async () => {
    const unbounded = (cap: string) =>
      cap
        .replace(/(<\/area>)[\s\S]*(<\/info>)/, "$1$2")
        .replace(/<polygon>[^<]*<\/polygon>/g, "")
        .replace(/<geocode>[\s\S]*?<\/geocode>/g, "")
        .replace("<areaDesc>Davao De Oro</areaDesc>", "<areaDesc>Somewhere Lusong can't place</areaDesc>");
    const { judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE], { [DAVAO_GFA1_UPDATE]: unbounded }));
    for (const route of [CEBU_ROUTE, DAVAO_DE_ORO_ROUTE]) {
      const advisory = judge(route);
      expect(advisory.state).toBe("none");
      expect(advisory.covering).toEqual([]);
      expect(advisory.warnings.map((w) => w.areas)).toEqual([["Somewhere Lusong can't place"]]);
    }
  });
});

describe("only live records change what is live (diff duck round 1, S1G-1, S1G-2)", () => {
  const links = [CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL, CAGAYAN_GFA4_REISSUED];

  it.each(["Test", "Exercise"])("a %s cancellation doesn't remove the Actual product it names", async (status) => {
    const drill = (cap: string) => cap.replace("<status>Actual</status>", `<status>${status}</status>`);
    const { snapshot, judge } = await snapshotAt("2026-10-23T05:45:00+08:00", listing(links, { [CAGAYAN_GFA4_CANCEL]: drill }));
    expect(snapshot.complete).toBe(true);
    expect(snapshot.products.map((p) => p.link).sort()).toEqual([CAGAYAN_GFA4, CAGAYAN_GFA4_REISSUED].sort());
    expect(judge(TUGUEGARAO_ROUTE).state).toBe("active");
  });

  it("a cancellation not yet sent hasn't removed anything yet", async () => {
    const later = (cap: string) => cap.replace("<sent>2026-10-23T05:34:32+08:00</sent>", "<sent>2026-10-23T06:34:32+08:00</sent>");
    expect(later(ALL_SAVED[CAGAYAN_GFA4_CANCEL])).not.toBe(ALL_SAVED[CAGAYAN_GFA4_CANCEL]);
    const { snapshot } = await snapshotAt("2026-10-23T05:45:00+08:00", listing(links, { [CAGAYAN_GFA4_CANCEL]: later }));
    expect(snapshot.products.map((p) => p.link).sort()).toEqual([CAGAYAN_GFA4, CAGAYAN_GFA4_REISSUED].sort());
  });

  it("a feed entry dated a second ahead of the server's clock is still read, and its record counts", async () => {
    // The update's feed entry says 2026-10-30 21:11:07 PHT; the server's clock reads one second earlier.
    const { snapshot, judge, net } = await snapshotAt("2026-10-30T21:11:06+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]));
    expect(net.calls).toContain(DAVAO_GFA1_UPDATE);
    expect(snapshot).toMatchObject({ complete: true, entries: [{ link: DAVAO_GFA1_UPDATE }, { link: DAVAO_GFA1_ALERT }] });
    // The update counts at once; the alert it replaces stays until the update is due (S1G-5), so both cover the route.
    expect(judge(DAVAO_CITY_ROUTE).covering.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE, DAVAO_GFA1_ALERT]);
  });

  it("a listed record that can't be fetched makes the snapshot incomplete however far ahead its entry is dated", async () => {
    const served = listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]);
    delete served[DAVAO_GFA1_UPDATE];
    const { snapshot } = await snapshotAt("2026-10-30T21:00:00+08:00", served);
    expect(snapshot.complete).toBe(false);
  });
});

describe("a record not yet due never makes a reading say no advisory (diff round 2, S1G-5, S1G-6)", () => {
  const sentAt = (iso: string) => (cap: string) => cap.replace(/<sent>[^<]*<\/sent>/, `<sent>${iso}</sent>`);
  const CHECK = "2026-10-23T05:45:00+08:00";

  it.each([
    ["one minute ahead", "2026-10-23T05:46:00+08:00"],
    ["exactly the 2-minute clock allowance ahead", "2026-10-23T05:47:00+08:00"],
  ])("a cancellation one minute ahead doesn't turn an active route to none (S1G-5): %s", async (_label, sent) => {
    const { snapshot, judge } = await snapshotAt(CHECK, listing([CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL], { [CAGAYAN_GFA4_CANCEL]: sentAt(sent) }));
    expect(snapshot.products.map((p) => p.link)).toEqual([CAGAYAN_GFA4]);
    expect(judge(TUGUEGARAO_ROUTE).state).toBe("active");
    expect(snapshot.pendingAt).toBe(new Date(sent).toISOString());
    // Once the cancellation is due, the snapshot that couldn't apply it is incomplete: still counted as active.
    expect(judge(TUGUEGARAO_ROUTE, sent)).toMatchObject({ state: "unreadable", incomplete: expect.stringContaining("came due") });
  });

  it("a cancellation sent by the server's clock removes its product", async () => {
    const { snapshot, judge } = await snapshotAt(CHECK, listing([CAGAYAN_GFA4, CAGAYAN_GFA4_CANCEL], { [CAGAYAN_GFA4_CANCEL]: sentAt(CHECK) }));
    expect(snapshot).toMatchObject({ complete: true, products: [], pendingAt: null });
    expect(judge(TUGUEGARAO_ROUTE).state).toBe("none");
  });

  it("a product sent after the snapshot was built makes the reading incomplete once its time passes (S1G-6)", async () => {
    // Built at 05:20 PHT; GFA #4 (Cagayan) is sent at 05:33:27 and counts from 05:31:27, the clock allowance before it.
    const served = listing([CAGAYAN_GFA4]);
    const store = new MemoryAdvisoryStore();
    const { snapshot, judge } = await snapshotAt("2026-10-23T05:20:00+08:00", served, store);
    expect(snapshot).toMatchObject({ complete: true, products: [], pendingAt: "2026-10-22T21:31:27.000Z" });
    expect(judge(TUGUEGARAO_ROUTE, "2026-10-23T05:31:26+08:00")).toMatchObject({ state: "none", incomplete: null });
    expect(judge(TUGUEGARAO_ROUTE, "2026-10-23T05:34:00+08:00").state).toBe("unreadable");

    // A check after it's due refreshes inline, as on a cold start, and finds the product.
    const now = at("2026-10-23T05:34:00+08:00");
    const reading = await snapshotForCheck({ store, fetch: pagasa(served).fetch, now, deadline: Date.now() + 5_000 });
    expect(reading.snapshot!.generation).toBeGreaterThan(snapshot.generation);
    expect(judgeRoute(reading, TUGUEGARAO_ROUTE, now)).toMatchObject({ state: "active", incomplete: null });
  });
});

describe("a raw record the store couldn't keep (diff round 2, 🟡4)", () => {
  it("publishes the snapshot as incomplete when writing a fetched record fails", async () => {
    class NoRecordWrites extends MemoryAdvisoryStore {
      override async set(): Promise<void> {
        throw new Error("store write failed");
      }
    }
    const { snapshot, judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]), new NoRecordWrites());
    expect(snapshot.complete).toBe(false);
    expect(snapshot.why).toMatch(/^storing .*: store write failed$/);
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("unreadable");
  });
});

describe("a record's event decides whether it counts (diff duck round 1, S1G-3)", () => {
  it("an Alert or Update info with no event makes the snapshot incomplete, never a quiet non-counting product", async () => {
    const noEvent = (cap: string) => cap.replace(/<event>[^<]*<\/event>/, "");
    const { snapshot, judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE], { [DAVAO_GFA1_UPDATE]: noEvent }));
    expect(snapshot).toMatchObject({ complete: false, why: `${DAVAO_GFA1_UPDATE}: ${DAVAO_GFA1_UPDATE} has an info with no event` });
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("unreadable");
  });
});

describe("a snapshot that can't be relied on reads as incomplete", () => {
  it("a listed record that can't be fetched makes it incomplete, and every route's advisory unreadable", async () => {
    const served = listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]);
    delete served[DAVAO_GFA1_ALERT];
    const { snapshot, judge } = await snapshotAt("2026-10-30T21:30:00+08:00", served);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.why).toContain(DAVAO_GFA1_ALERT);
    const advisory = judge(CEBU_ROUTE);
    expect(advisory.state).toBe("unreadable");
    expect(advisory.incomplete).toContain("fetch failed");
  });

  it("a feed that can't be read is incomplete", async () => {
    const { snapshot, judge } = await snapshotAt("2026-10-30T21:30:00+08:00", {});
    expect(snapshot).toMatchObject({ complete: false, products: [] });
    expect(judge(DAVAO_CITY_ROUTE).state).toBe("unreadable");
  });

  it("a complete snapshot 31 minutes old is incomplete; at 29 minutes it isn't", async () => {
    const { judge } = await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]));
    expect(judge(DAVAO_CITY_ROUTE, "2026-10-30T21:59:00+08:00")).toMatchObject({ state: "active", incomplete: null });
    const stale = judge(DAVAO_CITY_ROUTE, "2026-10-30T22:01:00+08:00");
    expect(stale.state).toBe("unreadable");
    expect(stale.incomplete).toBe("the snapshot is older than 30 minutes");
    // What it held is still shown.
    expect(stale.covering.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);
  });

  it("no snapshot at all is incomplete", () => {
    expect(judgeRoute({ snapshot: null }, CEBU_ROUTE, at("2026-10-30T21:30:00+08:00"))).toMatchObject({
      state: "unreadable",
      incomplete: "no snapshot of PAGASA's feed",
    });
  });

  it("a record missing a field its state depends on makes the snapshot incomplete", async () => {
    const served = listing([CV_GFA5]);
    served[CV_GFA5] = (served[CV_GFA5] as string).replace(/<expires>[^<]*<\/expires>/, "");
    const { snapshot } = await snapshotAt("2026-10-25T20:00:00+08:00", served);
    expect(snapshot).toMatchObject({ complete: false, why: `${CV_GFA5}: ${CV_GFA5} has no expires` });
  });
});

describe("raw records are kept and reused (S1P-7)", () => {
  it("a second refresh asks PAGASA for the feed only; an entry whose updated changed is fetched again", async () => {
    const store = new MemoryAdvisoryStore();
    const links = [DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE];
    const first = await snapshotAt("2026-10-30T21:30:00+08:00", listing(links), store);
    expect(first.net.calls.sort()).toEqual([FEED_URL, ...links].sort());
    expect(JSON.parse((await store.get(capKey(DAVAO_GFA1_UPDATE)))!)).toEqual({
      fetchedAt: "2026-10-30T13:30:00.000Z",
      feedUpdated: "2026-10-30T21:11:07+08:00",
      link: DAVAO_GFA1_UPDATE,
      xml: ALL_SAVED[DAVAO_GFA1_UPDATE],
    });

    const second = await snapshotAt("2026-10-30T21:40:00+08:00", listing(links), store);
    expect(second.net.calls).toEqual([FEED_URL]);
    expect(second.snapshot.products.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);

    const movedFeed = feedOf(links, (e, l) => (l === DAVAO_GFA1_UPDATE ? e.replace("2026-10-30T21:11:07+08:00", "2026-10-30T21:12:00+08:00") : e));
    const third = await snapshotAt("2026-10-30T21:50:00+08:00", { ...listing(links), [FEED_URL]: movedFeed }, store);
    expect(third.net.calls).toEqual([FEED_URL, DAVAO_GFA1_UPDATE]);
    expect(JSON.parse((await store.get(capKey(DAVAO_GFA1_UPDATE)))!).feedUpdated).toBe("2026-10-30T21:12:00+08:00");
  });
});

/** A refresh whose fetch of one record waits until released, standing for a slow PAGASA. */
function paused(served: Served, link: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const body = served[link] as string;
  return { served: { ...served, [link]: async () => (await gate, new Response(body)) }, release };
}

async function olderFinishesAfterNewer(store: AdvisoryStore, lapseLease: () => Promise<void>) {
  const links = [CAGAYAN_GFA4, CAGAYAN_GFA4_REISSUED];
  // The older refresh sees the advisory before its cancellation was listed, and stalls on a record.
  const older = paused(listing(links), CAGAYAN_GFA4);
  const olderRun = refreshSnapshot({ store, fetch: pagasa(older.served).fetch, now: () => at("2026-10-23T05:34:00+08:00") });
  await vi.waitFor(async () => expect(await store.get(SNAPSHOT_LEASE_KEY)).not.toBeNull());
  // Its lease lapses (it outlives the deadline, so its owner is presumed dead), and a newer refresh runs to the end.
  await lapseLease();
  const newer = await refreshSnapshot({
    store,
    fetch: pagasa(listing([...links, CAGAYAN_GFA4_CANCEL])).fetch,
    now: () => at("2026-10-23T05:45:00+08:00"),
  });
  expect(newer.outcome).toBe("published");
  older.release();
  return { older: await olderRun, newer };
}

describe("concurrent refreshes (S1P-5)", () => {
  it("an older refresh that finishes after a newer snapshot that cancelled a product doesn't bring it back, after its lease expired", async () => {
    let clock = Date.now();
    const store = new MemoryAdvisoryStore(() => clock);
    const { older } = await olderFinishesAfterNewer(store, async () => void (clock += SNAPSHOT_LEASE_MS + 1));
    expect(older.outcome).toBe("superseded");
    const stored = await readStoredSnapshot(store);
    expect(stored!.generation).toBe(at("2026-10-23T05:45:00+08:00").getTime());
    expect(stored!.products.map((p) => p.link)).toEqual([CAGAYAN_GFA4_REISSUED]);
  });

  it("a refresh finding the lease held asks PAGASA nothing and leaves the lease alone", async () => {
    const store = new MemoryAdvisoryStore();
    await store.setIfAbsent(SNAPSHOT_LEASE_KEY, "someone-else", SNAPSHOT_LEASE_MS);
    const net = pagasa(listing([DAVAO_GFA1_UPDATE]));
    expect(await refreshSnapshot({ store, fetch: net.fetch, now: () => at("2026-10-30T21:30:00+08:00") })).toEqual({ outcome: "busy" });
    expect(net.calls).toEqual([]);
    expect(await store.get(SNAPSHOT_LEASE_KEY)).toBe("someone-else");
  });

  it("the lease is released when the refresh ends", async () => {
    const store = new MemoryAdvisoryStore();
    await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_UPDATE]), store);
    expect(await store.get(SNAPSHOT_LEASE_KEY)).toBeNull();
  });
});

describe("the snapshot a check reads", () => {
  const deadline = () => Date.now() + 2_000;

  it("a fresh snapshot is read from the store, PAGASA not asked", async () => {
    const store = new MemoryAdvisoryStore();
    await snapshotAt("2026-10-30T21:30:00+08:00", listing([DAVAO_GFA1_UPDATE]), store);
    const net = pagasa({});
    const reading = await snapshotForCheck({ store, fetch: net.fetch, now: at("2026-10-30T21:45:00+08:00"), deadline: deadline() });
    expect(net.calls).toEqual([]);
    expect(reading.snapshot?.fetchedAt).toBe("2026-10-30T13:30:00.000Z");
  });

  it("a stale snapshot is refreshed inline, fetching only the new record", async () => {
    const store = new MemoryAdvisoryStore();
    await snapshotAt("2026-10-30T21:07:00+08:00", listing([DAVAO_GFA1_ALERT]), store);
    const net = pagasa(listing([DAVAO_GFA1_ALERT, DAVAO_GFA1_UPDATE]));
    const reading = await snapshotForCheck({ store, fetch: net.fetch, now: at("2026-10-30T21:40:00+08:00"), deadline: deadline() });
    expect(net.calls).toEqual([FEED_URL, DAVAO_GFA1_UPDATE]);
    expect(reading.snapshot?.products.map((p) => p.link)).toEqual([DAVAO_GFA1_UPDATE]);
  });

  it("while another refresh holds the lease, the check waits until its deadline, then reads what is stored", async () => {
    const store = new MemoryAdvisoryStore();
    await store.setIfAbsent(SNAPSHOT_LEASE_KEY, "someone-else", SNAPSHOT_LEASE_MS);
    const reading = await snapshotForCheck({ store, fetch: pagasa({}).fetch, now: at("2026-10-30T21:35:00+08:00"), deadline: Date.now() + 600 });
    expect(reading.snapshot).toBeNull();
    expect(judgeRoute(reading, CEBU_ROUTE, at("2026-10-30T21:35:00+08:00")).state).toBe("unreadable");
  });

  it("a store that can't be read is said so, and reads as incomplete", async () => {
    const broken = new MemoryAdvisoryStore();
    broken.get = async () => {
      throw new Error("Upstash HTTP 500");
    };
    const reading = await snapshotForCheck({ store: broken, fetch: pagasa({}).fetch, now: at("2026-10-30T21:35:00+08:00"), deadline: deadline() });
    expect(reading).toEqual({ snapshot: null, why: "store: Upstash HTTP 500" });
  });
});

/** The real store runs against Redis behind serverless-redis-http (Upstash's REST API), when one is up. */
const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
describe.skipIf(!upstashUrl)("the Upstash store for the advisory snapshot", () => {
  const fresh = () => new UpstashAdvisoryStore(upstashUrl!, process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "", `lusong-test-${randomUUID()}`);

  it("publishes only over an older generation, in one step", async () => {
    const store = fresh();
    expect(await store.publishIfNewer(SNAPSHOT_KEY, 2_000, '{"a":1}', 60_000)).toBe(true);
    expect(await store.publishIfNewer(SNAPSHOT_KEY, 1_000, '{"b":1}', 60_000)).toBe(false);
    expect(await store.publishIfNewer(SNAPSHOT_KEY, 2_000, '{"c":1}', 60_000)).toBe(false);
    expect(await store.get(SNAPSHOT_KEY)).toBe('2000\n{"a":1}');
    expect(await store.publishIfNewer(SNAPSHOT_KEY, 1_762_000_000_000, '{"d":1}', 60_000)).toBe(true);
    expect(await store.get(SNAPSHOT_KEY)).toBe('1762000000000\n{"d":1}');
  });

  it("releases a lease only for its owner, and reads many keys at once", async () => {
    const store = fresh();
    expect(await store.setIfAbsent(SNAPSHOT_LEASE_KEY, "mine", 60_000)).toBe(true);
    expect(await store.setIfAbsent(SNAPSHOT_LEASE_KEY, "theirs", 60_000)).toBe(false);
    await store.deleteIfEquals(SNAPSHOT_LEASE_KEY, "theirs");
    expect(await store.get(SNAPSHOT_LEASE_KEY)).toBe("mine");
    await store.deleteIfEquals(SNAPSHOT_LEASE_KEY, "mine");
    expect(await store.get(SNAPSHOT_LEASE_KEY)).toBeNull();
    await store.set("a", "1", 60_000);
    expect(await store.getMany(["a", "b"])).toEqual(["1", null]);
  });

  it("an older refresh that finishes after a newer one that cancelled a product doesn't bring it back, after its lease expired", async () => {
    const store = fresh();
    // A real lease can't be aged in a test, so it is overwritten with one that lapses at once.
    const { older } = await olderFinishesAfterNewer(store, async () => {
      await store.set(SNAPSHOT_LEASE_KEY, "lapsing", 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(older.outcome).toBe("superseded");
    expect((await readStoredSnapshot(store))!.products.map((p) => p.link)).toEqual([CAGAYAN_GFA4_REISSUED]);
  });
});

describe("records the feed links by PAGASA's bare IP address", () => {
  it("maps 121.58.193.10 to the feed's host and leaves other links alone", () => {
    expect(recordUrl("https://121.58.193.10/output/gfa/052284af-b5f8-409a-9f3d-aef22b241285.cap")).toBe(
      "https://publicalert.pagasa.dost.gov.ph/output/gfa/052284af-b5f8-409a-9f3d-aef22b241285.cap",
    );
    expect(recordUrl(CAGAYAN_GFA4)).toBe(CAGAYAN_GFA4);
    expect(recordUrl("https://example.org/x.cap")).toBe("https://example.org/x.cap");
  });

  it("a feed entry linked by IP is fetched from the feed's host, so the snapshot stays complete", async () => {
    const byIp = CAGAYAN_GFA4.replace("publicalert.pagasa.dost.gov.ph", "121.58.193.10");
    const served: Served = { [FEED_URL]: feedOf([CAGAYAN_GFA4], (entry) => entry.replace(CAGAYAN_GFA4, byIp)), [CAGAYAN_GFA4]: ALL_SAVED[CAGAYAN_GFA4] };
    const { snapshot, net, judge } = await snapshotAt("2026-10-23T05:45:00+08:00", served);
    expect(net.calls).not.toContain(byIp);
    expect(snapshot.complete).toBe(true);
    expect(judge(TUGUEGARAO_ROUTE).state).toBe("active");
  });
});
