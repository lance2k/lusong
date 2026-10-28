import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkPhoto } from "../lib/check";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter } from "../lib/meta";
import { depthManifestProblems, depthReport, type DepthDraw, type DepthPhoto } from "./depth-report";

const FIXTURES = "test/fixtures/depth-set";
const CONCURRENCY = 4;
const DRAWS = Number(process.env.LUSONG_DEPTH_DRAWS ?? 2);
/** No new draw starts after this; one in flight can take up to the 100 s pipeline budget, inside the test timeout. */
const START_DRAWS_FOR_MS = 35 * 60_000;

/**
 * Measures the depth set; it is not a gate and must not be tuned on. Costs real money (about $0.023 a draw,
 * $0.098 at worst), so it runs only with LUSONG_LIVE=1, LUSONG_DEPTH=1 and MODEL_API_KEY set. Every draw's
 * result and metered usage is appended to test/depth-runs/<stamp>/records.jsonl as it finishes; results.json and
 * the error report are written at the end.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_DEPTH !== "1")(
  "depth set: error report",
  async () => {
    const photos = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8")) as DepthPhoto[];
    expect(depthManifestProblems(photos), "fix the manifest before spending on it").toEqual([]);
    expect(Number.isInteger(DRAWS) && DRAWS > 0, "LUSONG_DEPTH_DRAWS must be a whole number").toBe(true);
    const prepared = new Map(photos.map((p) => [p.file, sanitizeJpeg(new Uint8Array(readFileSync(join(FIXTURES, p.file))))]));
    const commit = execSync("git describe --always --dirty", { encoding: "utf8" }).trim();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join("test/depth-runs", stamp);
    mkdirSync(outDir, { recursive: true });

    const jobs = photos.flatMap((photo) => Array.from({ length: DRAWS }, (_, i) => ({ photo, draw: i + 1 })));
    const draws: DepthDraw[] = [];
    const records: object[] = [];
    const stopStartingAt = Date.now() + START_DRAWS_FOR_MS;
    let nextJob = 0;
    const record = (entry: object) => {
      records.push(entry);
      appendFileSync(join(outDir, "records.jsonl"), `${JSON.stringify(entry)}\n`);
    };
    async function worker() {
      while (nextJob < jobs.length && Date.now() < stopStartingAt) {
        const { photo, draw } = jobs[nextJob++];
        const jpeg = prepared.get(photo.file)!;
        const meter = new Meter();
        try {
          const result = await checkPhoto(
            `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`,
            { width: jpeg.width, height: jpeg.height },
            meter,
          );
          draws.push({ file: photo.file, draw, verdict: result.verdict });
          record({ file: photo.file, draw, usage: meter.usage(), result });
        } catch (err) {
          draws.push({ file: photo.file, draw, error: String(err) });
          record({ file: photo.file, draw, usage: meter.usage(), error: String(err) });
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      writeFileSync(join(outDir, "results.json"), JSON.stringify({ stamp, commit, draws: DRAWS, records }, null, 1));
      const report = depthReport(photos, draws);
      writeFileSync(join(outDir, "totals.json"), JSON.stringify(report.totals, null, 1));
      writeFileSync(
        join(outDir, "report.md"),
        `# Depth-set run ${stamp}\n\nCommit ${commit}; ${photos.length} photos × ${DRAWS} draws. Outcome compares the reading that ` +
          `decided the verdict with the caption's depth word, both as intervals from Lusong's landmark table; overlap is a match.\n\n` +
          `${report.markdown}\n`,
      );
    }
    expect(draws).toHaveLength(jobs.length);
  },
  45 * 60_000,
);
