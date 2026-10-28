import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkPhoto } from "../lib/check";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter } from "../lib/meta";
import { DRAWS_PER_PHOTO, judgeAcceptance, type AcceptanceDraw, type AcceptancePhoto } from "./acceptance-gate";

const FIXTURES = "test/fixtures/acceptance";
const CONCURRENCY = 4;

/**
 * Blocker 3's live gate. Costs real money (about $0.02 a draw, $0.072 at worst), so it runs only with
 * LUSONG_LIVE=1 and MODEL_API_KEY set. Every result is written under test/acceptance-runs/ to be committed.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1")(
  "acceptance set: no false PATV, no measurement without a reference",
  async () => {
    const photos = JSON.parse(readFileSync(join(FIXTURES, "labels.json"), "utf8")) as AcceptancePhoto[];
    const manifest = judgeAcceptance(photos, []);
    expect(manifest.problems, "fix the manifest before spending on it").toEqual([]);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join("test/acceptance-runs", stamp);
    mkdirSync(outDir, { recursive: true });

    const jobs = photos.flatMap((photo) => Array.from({ length: DRAWS_PER_PHOTO }, (_, i) => ({ photo, draw: i + 1 })));
    const draws: AcceptanceDraw[] = [];
    const records: object[] = [];
    let nextJob = 0;
    async function worker() {
      while (nextJob < jobs.length) {
        const { photo, draw } = jobs[nextJob++];
        const jpeg = sanitizeJpeg(new Uint8Array(readFileSync(join(FIXTURES, photo.file))));
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
          records.push({ file: photo.file, draw, usage: meter.usage(), error: String(err) });
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const judged = judgeAcceptance(photos, draws);
    writeFileSync(join(outDir, "results.json"), JSON.stringify({ stamp, judged, records }, null, 1));
    expect(judged.failures).toEqual([]);
    expect(judged.pass).toBe(true);
  },
  15 * 60_000,
);
