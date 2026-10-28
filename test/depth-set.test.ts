import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkPhoto } from "../lib/check";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter } from "../lib/meta";
import { depthReport, type DepthDraw, type DepthPhoto } from "./depth-report";

const FIXTURES = "test/fixtures/depth-set";
const CONCURRENCY = 4;
const DRAWS = Number(process.env.LUSONG_DEPTH_DRAWS ?? 2);

/**
 * Measures the depth set; it is not a gate and must not be tuned on. Costs real money (about $0.023 a draw,
 * $0.098 at worst), so it runs only with LUSONG_LIVE=1, LUSONG_DEPTH=1 and MODEL_API_KEY set. Every draw's
 * result and metered usage go to test/depth-runs/<stamp>/results.json, with the error report beside it.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_DEPTH !== "1")(
  "depth set: error report",
  async () => {
    const photos = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8")) as DepthPhoto[];
    const prepared = new Map(photos.map((p) => [p.file, sanitizeJpeg(new Uint8Array(readFileSync(join(FIXTURES, p.file))))]));
    const commit = execSync("git describe --always --dirty", { encoding: "utf8" }).trim();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join("test/depth-runs", stamp);
    mkdirSync(outDir, { recursive: true });

    const jobs = photos.flatMap((photo) => Array.from({ length: DRAWS }, (_, i) => ({ photo, draw: i + 1 })));
    const draws: DepthDraw[] = [];
    const records: object[] = [];
    let nextJob = 0;
    async function worker() {
      while (nextJob < jobs.length) {
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
          records.push({ file: photo.file, draw, usage: meter.usage(), result });
        } catch (err) {
          draws.push({ file: photo.file, draw, error: String(err) });
          records.push({ file: photo.file, draw, usage: meter.usage(), error: String(err) });
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      const report = depthReport(photos, draws);
      writeFileSync(join(outDir, "results.json"), JSON.stringify({ stamp, commit, draws: DRAWS, totals: report.totals, records }, null, 1));
      writeFileSync(
        join(outDir, "report.md"),
        `# Depth-set run ${stamp}\n\nCommit ${commit}; ${photos.length} photos × ${DRAWS} draws. Outcome compares the reading that ` +
          `decided the verdict with the caption's depth word, both as intervals from Lusong's landmark table; overlap is a match.\n\n` +
          `${report.markdown}\n`,
      );
    }
    expect(draws).toHaveLength(jobs.length);
  },
  30 * 60_000,
);
