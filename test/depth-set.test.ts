import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ATTEMPTS_PER_CALL, costMicros, MUSE_INPUT_MICROS_PER_TOKEN, MUSE_INPUT_TOKEN_BOUND, MUSE_OUTPUT_MICROS_PER_TOKEN, SAM_IMAGE_MICROS } from "../lib/budget";
import { PIPELINE_BUDGET_MS, readSegmented, SAM_PHRASES, segmentPhoto, type CheckResult } from "../lib/check";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter } from "../lib/meta";
import { MUSE_MAX_COMPLETION_TOKENS, READERS, type Reader } from "../lib/readings";
import type { SamReply } from "../lib/sam";
import {
  depthManifestProblems,
  depthReport,
  groupTallies,
  SpendCap,
  transitions,
  type DepthDraw,
  type DepthPhoto,
  type DepthSplit,
  type Group,
} from "./depth-report";

const FIXTURES = "test/fixtures/depth-set";
const CONCURRENCY = 4;
const DRAWS = Number(process.env.LUSONG_DEPTH_DRAWS ?? 2);
/** Comma-separated readers; with more than one, every draw's readers share one set of SAM replies. */
const RUN_READERS = (process.env.LUSONG_DEPTH_READERS ?? "landmark").split(",") as Reader[];
const SIDE = process.env.LUSONG_DEPTH_SPLIT ?? "all";
/**
 * A folder of SAM replies, one live pass per photo, reused by every draw and reader: for tuning a prompt, where only
 * Muse Spark's variation matters. Unset, each draw segments live, as the routes do.
 */
const SAM_CACHE = process.env.LUSONG_DEPTH_SAM_CACHE;
const MAX_USD = Number(process.env.LUSONG_DEPTH_MAX_USD);
/** No new draw starts after this; one in flight can take up to the 100 s pipeline budget, inside the test timeout. */
const START_DRAWS_FOR_MS = 35 * 60_000;

const SAM_RESERVE_MICROS = SAM_PHRASES.length * ATTEMPTS_PER_CALL * SAM_IMAGE_MICROS;
/** The guided and hidden prompts are longer than the one MUSE_INPUT_TOKEN_BOUND was sized on; 1,000 tokens covers it. */
const MUSE_RESERVE_MICROS =
  ATTEMPTS_PER_CALL *
  Math.ceil((MUSE_INPUT_TOKEN_BOUND + 1_000) * MUSE_INPUT_MICROS_PER_TOKEN + MUSE_MAX_COMPLETION_TOKENS * MUSE_OUTPUT_MICROS_PER_TOKEN);

const GROUPS: Group[] = ["held-out flood", "held-out flood, unexposed", "tuning flood", "flood", "held-out", "tuning", "wading", "all"];

/** The person masks make a record large; the run keeps every SAM reply in its own folder instead. */
function forRecord(result: CheckResult): Omit<CheckResult, "personReply"> {
  const copy: Partial<CheckResult> = { ...result };
  delete copy.personReply;
  return copy as Omit<CheckResult, "personReply">;
}

/**
 * Measures the depth set; it is not a gate. Costs real money, so it runs only with LUSONG_LIVE=1, LUSONG_DEPTH=1,
 * MODEL_API_KEY and a spending cap in LUSONG_DEPTH_MAX_USD, which it enforces itself: a draw starts only when the
 * money spent plus every in-flight draw's worst case stays under it. LUSONG_DEPTH_SPLIT picks the photos (all,
 * tuning, heldout; test/fixtures/depth-set/split.json). Every result and its metered usage is appended to
 * test/depth-runs/<stamp>/records.jsonl as it finishes; results.json and report.md are written at the end.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_DEPTH !== "1")(
  "depth set: error report",
  async () => {
    const all = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8")) as DepthPhoto[];
    const split = JSON.parse(readFileSync(join(FIXTURES, "split.json"), "utf8")) as DepthSplit;
    expect(depthManifestProblems(all), "fix the manifest before spending on it").toEqual([]);
    expect(Number.isInteger(DRAWS) && DRAWS > 0, "LUSONG_DEPTH_DRAWS must be a whole number").toBe(true);
    expect(RUN_READERS.every((r) => (READERS as readonly string[]).includes(r)), `LUSONG_DEPTH_READERS: ${READERS.join(", ")}`).toBe(true);
    expect(["all", "tuning", "heldout"]).toContain(SIDE);
    expect(MAX_USD > 0, "set LUSONG_DEPTH_MAX_USD").toBe(true);
    const photos = all.filter((p) => SIDE === "all" || split.split[p.file] === SIDE);
    const prepared = new Map(photos.map((p) => [p.file, sanitizeJpeg(new Uint8Array(readFileSync(join(FIXTURES, p.file))))]));
    const commit = execSync("git describe --always --dirty", { encoding: "utf8" }).trim();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join("test/depth-runs", stamp);
    mkdirSync(join(outDir, "sam"), { recursive: true });
    if (SAM_CACHE) mkdirSync(SAM_CACHE, { recursive: true });

    const cap = new SpendCap(Math.floor(MAX_USD * 1_000_000));
    const jobs = photos.flatMap((photo) => Array.from({ length: DRAWS }, (_, i) => ({ photo, draw: i + 1 })));
    const draws: DepthDraw[] = [];
    const records: object[] = [];
    let refusedForCap = 0;
    const stopStartingAt = Date.now() + START_DRAWS_FOR_MS;
    let nextJob = 0;
    const record = (entry: object) => {
      records.push(entry);
      appendFileSync(join(outDir, "records.jsonl"), `${JSON.stringify(entry)}\n`);
    };
    const settle = (reserved: number, meter: Meter) => {
      const usage = meter.usage();
      cap.settle(reserved, usage.complete ? costMicros(usage) : reserved);
      return usage;
    };

    const cached = new Map<string, Promise<SamReply[]>>();
    /** One live SAM pass per photo when caching, shared by every draw; null when the cap refused it. */
    function samFor(file: string, dataUrl: string): Promise<SamReply[] | null> {
      const path = join(SAM_CACHE!, `${file}.json`);
      if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as SamReply[]);
      const known = cached.get(file);
      if (known) return known;
      if (!cap.tryReserve(SAM_RESERVE_MICROS)) return Promise.resolve(null);
      const meter = new Meter();
      const pass = segmentPhoto(dataUrl, Date.now() + PIPELINE_BUDGET_MS, meter).finally(() => {
        record({ file, sam: "cache", usage: settle(SAM_RESERVE_MICROS, meter) });
      });
      cached.set(file, pass);
      return pass.then((replies) => {
        writeFileSync(path, JSON.stringify(replies));
        return replies;
      });
    }

    async function worker() {
      while (nextJob < jobs.length && Date.now() < stopStartingAt) {
        const { photo, draw } = jobs[nextJob++];
        const jpeg = prepared.get(photo.file)!;
        const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
        const image = { width: jpeg.width, height: jpeg.height };

        let replies: SamReply[] | null;
        let segmentationMs = 0;
        try {
          if (SAM_CACHE) {
            replies = await samFor(photo.file, dataUrl);
          } else if (cap.tryReserve(SAM_RESERVE_MICROS)) {
            const meter = new Meter();
            const started = Date.now();
            try {
              replies = await segmentPhoto(dataUrl, started + PIPELINE_BUDGET_MS, meter);
              segmentationMs = Date.now() - started;
              writeFileSync(join(outDir, "sam", `${photo.file}.d${draw}.json`), JSON.stringify(replies));
            } finally {
              record({ file: photo.file, draw, sam: "live", usage: settle(SAM_RESERVE_MICROS, meter) });
            }
          } else {
            replies = null;
          }
        } catch (err) {
          for (const reader of RUN_READERS) draws.push({ file: photo.file, draw, reader, error: `SAM: ${String(err)}` });
          continue;
        }
        if (replies === null) {
          refusedForCap++;
          continue;
        }

        // Each reader gets its own meter, deadline and error record, so one cannot cost the other its draw.
        await Promise.all(
          RUN_READERS.map(async (reader) => {
            if (!cap.tryReserve(MUSE_RESERVE_MICROS)) {
              refusedForCap++;
              return;
            }
            const meter = new Meter();
            try {
              const result = await readSegmented(dataUrl, image, replies, meter, {
                deadline: Date.now() + PIPELINE_BUDGET_MS,
                reader,
                segmentationMs,
              });
              draws.push({ file: photo.file, draw, reader, verdict: result.verdict });
              record({ file: photo.file, draw, reader, usage: settle(MUSE_RESERVE_MICROS, meter), result: forRecord(result) });
            } catch (err) {
              draws.push({ file: photo.file, draw, reader, error: String(err) });
              record({ file: photo.file, draw, reader, usage: settle(MUSE_RESERVE_MICROS, meter), error: String(err) });
            }
          }),
        );
      }
    }
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      const spentUsd = cap.spentMicros / 1_000_000;
      writeFileSync(
        join(outDir, "results.json"),
        JSON.stringify({ stamp, commit, draws: DRAWS, readers: RUN_READERS, side: SIDE, samCache: Boolean(SAM_CACHE), spentUsd, refusedForCap, records }, null, 1),
      );
      writeFileSync(join(outDir, "report.md"), runReport({ stamp, commit, photos, split, draws, spentUsd, refusedForCap }));
      const totals = Object.fromEntries(
        RUN_READERS.map((reader) => [reader, Object.fromEntries(groupTallies(photos, draws.filter((d) => d.reader === reader), split))]),
      );
      writeFileSync(join(outDir, "totals.json"), JSON.stringify(totals, null, 1));
    }
    expect(refusedForCap, "draws the spending cap refused").toBe(0);
    expect(draws).toHaveLength(jobs.length * RUN_READERS.length);
  },
  45 * 60_000,
);

function runReport(run: {
  stamp: string;
  commit: string;
  photos: DepthPhoto[];
  split: DepthSplit;
  draws: DepthDraw[];
  spentUsd: number;
  refusedForCap: number;
}): string {
  const { photos, split, draws } = run;
  const lines = [
    `# Depth-set run ${run.stamp}`,
    "",
    `Commit ${run.commit}; ${photos.length} photos (${SIDE}) × ${DRAWS} draws; readers ${RUN_READERS.join(", ")}` +
      `${RUN_READERS.length > 1 ? ", sharing each draw's SAM replies" : ""}; SAM ${SAM_CACHE ? "from one cached pass per photo" : "live per draw"}. ` +
      `Metered spend $${run.spentUsd.toFixed(4)}; draws refused by the cap: ${run.refusedForCap}.`,
    "",
    "Outcome compares the reading that decided the verdict with the caption's depth word, both as intervals from Lusong's " +
      "landmark table; overlap is a match. Gap: cm between the two intervals (negative = too shallow, 0 on overlap), over " +
      "measured draws. Rank: person-landmark steps from the caption's to the deciding one.",
    "",
    "| Reader | Group | Draws | too shallow | matched | too deep | can't measure | no flood | error | mean gap cm | mean abs gap cm | mean rank |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const reader of RUN_READERS) {
    const tallies = groupTallies(photos, draws.filter((d) => d.reader === reader), split);
    for (const g of GROUPS) {
      const t = tallies.get(g);
      if (!t) continue;
      const o = t.outcomes;
      lines.push(
        `| ${reader} | ${g} | ${t.draws} | ${o.too_shallow} | ${o.matched} | ${o.too_deep} | ${o.cannot_measure} | ${o.no_flood} | ${o.error} | ${t.meanGapCm ?? "–"} | ${t.meanAbsGapCm ?? "–"} | ${t.meanRankError ?? "–"} |`,
      );
    }
  }
  const [base, ...others] = RUN_READERS;
  for (const other of others) {
    for (const [name, keep] of [
      ["held-out flood", (p: DepthPhoto) => p.scene === "flood" && split.split[p.file] === "heldout"],
      ["tuning flood", (p: DepthPhoto) => p.scene === "flood" && split.split[p.file] === "tuning"],
      ["all", () => true],
    ] as const) {
      const t = transitions(photos, draws.filter((d) => d.reader === base), draws.filter((d) => d.reader === other), keep);
      lines.push("", `Paired transitions ${base} → ${other}, ${name}:`, "", "| change | draws |", "|---|---|");
      for (const [k, n] of Object.entries(t).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${n} |`);
    }
  }
  for (const reader of RUN_READERS) {
    lines.push("", `## Per photo, ${reader}`, "", depthReport(photos, draws.filter((d) => d.reader === reader)).markdown);
  }
  return `${lines.join("\n")}\n`;
}
