import { describe, expect, it } from "vitest";
import type { ClosureMark } from "../lib/closure-marks";
import { closureRowLines, closuresReplyOf, liveMarks } from "./closures-layer";

const NOW = Date.parse("2026-11-04T14:00:00+08:00");

function mark(id: string, overrides: Partial<ClosureMark> = {}): ClosureMark {
  return {
    id,
    words: `The MMDA reports a road closure at Road ${id}, posted 4 Nov, 10:00 a.m. PHT. Unconfirmed by Lusong.`,
    sourceUrl: `https://news.example.ph/${id}`,
    posted: "2026-11-04T10:00:00+08:00",
    expiresAt: "2026-11-04T22:00:00+08:00",
    spot: { point: { lat: 10.31, lon: 123.89 }, radiusM: 500 },
    ...overrides,
  };
}

describe("the closures reply on the page", () => {
  it("reads anything misshapen as down, and drops a mark with a non-https source or a bad spot", () => {
    expect(closuresReplyOf("<html>").status).toBe("down");
    expect(closuresReplyOf({ status: "weird", marks: [] }).status).toBe("down");
    const r = closuresReplyOf({
      status: "ok",
      lifetimeHours: 12,
      marks: [mark("a"), mark("b", { sourceUrl: "javascript:alert(1)" }), { ...mark("c"), spot: { point: { lat: "x" } } }],
    });
    expect(r.marks.map((m) => m.id)).toEqual(["a"]);
  });

  it("drops a mark whose time is up without waiting for a refresh", () => {
    expect(liveMarks([mark("a"), mark("b", { expiresAt: "2026-11-04T13:59:00+08:00" })], NOW).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("the Road closures legend row", () => {
  const ok = (marks: ClosureMark[]) => ({ status: "ok" as const, marks, lifetimeHours: 12 });
  const LIFETIME = "A sweep report shows for 12 hours after its page was posted. Unconfirmed by Lusong.";

  it("says there are none right now, never that none were found in a time window", () => {
    const lines = closureRowLines(ok([]), false, NOW);
    expect(lines).toEqual(["No web-sweep reports right now", LIFETIME]);
    expect(lines.join(" ")).not.toMatch(/last \d+|48/);
  });

  it("counts the drawn and the province-wide ones and lists the province-wide words", () => {
    const wide = mark("w", { spot: null, words: "Rappler reports flooding at a place in Metro Manila, posted 4 Nov, 9:00 a.m. PHT. Unconfirmed by Lusong." });
    expect(closureRowLines(ok([mark("a"), wide]), false, NOW)).toEqual([
      "2 from the web sweep: 1 on the map, 1 for a whole province",
      wide.words,
      LIFETIME,
    ]);
    expect(closureRowLines(ok([mark("a")]), false, NOW)[0]).toBe("1 from the web sweep");
  });

  it("caps the list at three province-wide reports", () => {
    const wides = ["1", "2", "3", "4", "5"].map((i) => mark(i, { spot: null }));
    const lines = closureRowLines(ok(wides), false, NOW);
    expect(lines).toHaveLength(1 + 3 + 1 + 1);
    expect(lines[4]).toBe("and 2 more");
  });

  it("says loading, then can't load, on the way and on failure", () => {
    expect(closureRowLines(null, true, NOW)).toEqual(["Loading road closures…"]);
    expect(closureRowLines({ status: "down", marks: [], lifetimeHours: 12 }, false, NOW)).toEqual(["Can't load road closures right now"]);
  });
});
