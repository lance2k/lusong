import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryAlertStore, UpstashAlertStore, type Alert, type AlertStore } from "./alerts";
import { closureMarks, closuresReply, MAX_MARKS } from "./closure-marks";

const NOW = Date.parse("2026-11-04T14:00:00+08:00");

function sweep(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    version: 1,
    kind: "closure",
    scope: { point: { lat: 10.31, lon: 123.89 }, radiusM: 500 },
    sourceUrl: `https://news.example.ph/${id}`,
    sourceOrg: "the MMDA",
    eventAt: "2026-11-04T10:00:00+08:00",
    expiresAt: "2026-11-04T22:00:00+08:00",
    severity: "warn",
    origin: "sweep",
    fields: { place: "Osmeña Boulevard, Cebu City", posted: "2026-11-04T10:00:00+08:00", words: "closure" },
    ...overrides,
  };
}

const pagasa: Alert = {
  ...sweep("pagasa:gfa"),
  kind: "advisory",
  origin: "pagasa",
  scope: { nationwide: true },
  sourceOrg: "PAGASA",
  fields: { event: "General Flood Advisory", sent: "2026-11-04T05:00:00+08:00", expires: "2026-11-04T17:00:00+08:00" },
};

describe("closure marks", () => {
  it("keeps only the sweep's unexpired reports, with the Telegram alert's own words", () => {
    const marks = closureMarks([sweep("sweep:a"), pagasa, sweep("sweep:old", { expiresAt: "2026-11-04T13:59:00+08:00" })], NOW);
    expect(marks.map((m) => m.id)).toEqual(["sweep:a"]);
    expect(marks[0].words).toBe("The MMDA reports a road closure at Osmeña Boulevard, Cebu City, posted 4 Nov, 10:00 a.m. PHT. Unconfirmed by Lusong.");
    expect(marks[0].spot).toEqual({ point: { lat: 10.31, lon: 123.89 }, radiusM: 500 });
  });

  it("lists a province-wide report with no spot, named as the sweep named it", () => {
    const wide = sweep("sweep:w", { scope: { codes: ["1300000000"] }, fields: { place: "a place in Metro Manila", posted: "2026-11-04T09:00:00+08:00", words: "flood" } });
    const [m] = closureMarks([wide], NOW);
    expect(m.spot).toBeNull();
    expect(m.words).toContain("flooding at a place in Metro Manila");
  });

  it("drops a report whose source isn't https", () => {
    expect(closureMarks([sweep("sweep:h", { sourceUrl: "http://news.example.ph/x" }), sweep("sweep:j", { sourceUrl: "javascript:alert(1)" })], NOW)).toEqual([]);
  });

  it("shows the newest first, at most 50", () => {
    const many = Array.from({ length: MAX_MARKS + 5 }, (_, i) =>
      sweep(`sweep:${i}`, { fields: { place: "x", posted: new Date(NOW - (i + 1) * 60_000).toISOString(), words: "closure" } }),
    );
    const marks = closureMarks(many.reverse(), NOW);
    expect(marks).toHaveLength(MAX_MARKS);
    expect(marks[0].id).toBe("sweep:0");
  });
});

describe("the closures reply", () => {
  it("is paused without a store, down when the read fails, and says how long a report stays up", async () => {
    expect(await closuresReply(null, NOW)).toEqual({ status: "paused", marks: [], lifetimeHours: 12 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { list: async () => Promise.reject(new Error("Upstash HTTP 503")) } as unknown as AlertStore;
    expect(await closuresReply(broken, NOW)).toEqual({ status: "down", marks: [], lifetimeHours: 12 });
    err.mockRestore();
  });

  it("never calls all(), which deletes", async () => {
    const store = new MemoryAlertStore(() => NOW);
    const all = vi.spyOn(store, "all");
    await store.addIfAbsent([sweep("sweep:a")]);
    expect((await closuresReply(store, NOW)).marks).toHaveLength(1);
    expect(all).not.toHaveBeenCalled();
  });
});

const upstashUrl = process.env.LUSONG_TEST_UPSTASH_URL;
const upstashToken = process.env.LUSONG_TEST_UPSTASH_TOKEN ?? "";
const stores: [string, () => AlertStore][] = [
  ["memory alert store", () => new MemoryAlertStore(() => NOW)],
  ...(upstashUrl ? [["Upstash alert store", () => new UpstashAlertStore(upstashUrl, upstashToken, `lusong-test-${randomUUID()}`)] as [string, () => AlertStore]] : []),
];

describe.each(stores)("the %s's list (S3cP-1)", (_name, make) => {
  it("leaves an expired alert in place for the writers to prune, so a public read can't delete what a rebuild just replaced", async () => {
    const store = make();
    await store.addIfAbsent([sweep("sweep:live"), sweep("sweep:gone", { expiresAt: "2026-11-04T13:00:00+08:00" })]);
    expect((await store.list(NOW)).map((a) => a.id)).toEqual(["sweep:live"]);
    // The expired one is still stored: all() (a writer's read) is what finds and prunes it.
    const pruned = await store.all(Date.parse("2026-11-04T12:00:00+08:00"));
    expect(pruned.map((a) => a.id).sort()).toEqual(["sweep:gone", "sweep:live"]);
  });
});
