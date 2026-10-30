import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideAnswer, routeLengthM, type Point, type Report } from "../lib/answer";
import { decodePolyline6 } from "../lib/router";
import type { Verdict } from "../lib/verdict";

/**
 * 🔴P1's commute-level gate: no verdict Lusong has ever recorded on the depth set may produce Go under rain, even when
 * reports carrying it cover the whole route. If any of them were read as clearing a spot, this cover would give Go.
 */

const NOW = new Date("2026-10-30T07:00:00+08:00");
const ROUTE = decodePolyline6(JSON.parse(readFileSync("test/fixtures/valhalla/banilad-itpark-plain.json", "utf8")).trip.legs[0].shape);
const RUNS = readdirSync("test/depth-runs").map((stamp) => `test/depth-runs/${stamp}/results.json`);
const VERDICTS: { file: string; draw: number; run: string; verdict: Verdict }[] = RUNS.flatMap((run) =>
  (JSON.parse(readFileSync(run, "utf8")).records as { file: string; draw: number; result: { verdict: Verdict } }[]).map((r) => ({
    file: r.file,
    draw: r.draw,
    run,
    verdict: r.result.verdict,
  })),
);

function pointAlong(line: Point[], d: number): Point {
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = routeLengthM([line[i], line[i + 1]]);
    if (walked + seg >= d) {
      const t = seg === 0 ? 0 : (d - walked) / seg;
      return { lat: line[i].lat + t * (line[i + 1].lat - line[i].lat), lon: line[i].lon + t * (line[i + 1].lon - line[i].lon) };
    }
    walked += seg;
  }
  return line[line.length - 1];
}

/** Reports of one verdict every 400 m from start to end: closer than the 500 m cover rule needs. */
function coverOf(verdict: Verdict, tag: string): Report[] {
  const length = routeLengthM(ROUTE);
  const marks = [...Array.from({ length: Math.floor(length / 400) + 1 }, (_, i) => i * 400), length];
  return marks.map((d, i) => ({
    id: `${tag}-${i}`,
    at: pointAlong(ROUTE, d),
    wayId: 1,
    receivedAt: new Date(NOW.getTime() - 10 * 60_000),
    place: `${Math.round(d)} m along`,
    reading: { source: "photo", verdict, capturedAt: new Date(NOW.getTime() - 15 * 60_000) },
  }));
}

const check = (reports: Report[], advisory: "active" | "none") =>
  decideAnswer({ plain: { id: "plain", line: ROUTE }, detours: [], reports, advisory, rainingHere: false, now: NOW }).answer;

describe("every recorded depth-set verdict, as reports on the Banilad → IT Park route", () => {
  it("covers both 90-draw runs", () => {
    expect(RUNS).toHaveLength(2);
    expect(VERDICTS).toHaveLength(180);
    expect(VERDICTS.filter((v) => v.verdict.kind === "no_flood")).toHaveLength(0);
  });

  it.each(VERDICTS.map((v) => [`${v.file} draw ${v.draw} (${v.run.split("/")[2]})`, v.verdict] as const))(
    "under an active advisory, %s covering the whole route is never Go",
    (_name, verdict) => {
      expect(check(coverOf(verdict, "v"), "active")).not.toBe("go");
    },
  );

  it("all 180 together under an active advisory is never Go", () => {
    expect(check(VERDICTS.flatMap((v, i) => coverOf(v.verdict, `v${i}`)), "active")).not.toBe("go");
  });

  it("the same cover of a no_flood photo would be Go, so the gate can tell", () => {
    expect(check(coverOf({ kind: "no_flood" }, "dry"), "active")).toBe("go");
  });
});
