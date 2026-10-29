import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter, segment } from "../lib/meta";
import { runPlateProbe, type ProbeLabels } from "./plate-recall";

const PROMPTS = ["license plate", "number plate"];
const labels = JSON.parse(readFileSync("test/fixtures/sam/plates-labels.json", "utf8")) as ProbeLabels;

/**
 * Does SAM 3.1 find licence plates? Each labelled photo (5 with plates, 2 vehicle negatives) gets both prompts, one
 * SAM image per call: 14 images, about $0.035, more only if a call is retried (the meter counts what was billed).
 * Runs only with LUSONG_LIVE=1 and LUSONG_LIVE_OUT=<path>; the summary, raw replies included, goes to that path.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || !process.env.LUSONG_LIVE_OUT)(
  "probe: SAM masks of licence plates on fixture photos",
  async () => {
    const meter = new Meter();
    const summary = await runPlateProbe(labels, PROMPTS, (file, prompt) => {
      const jpeg = sanitizeJpeg(new Uint8Array(readFileSync(`test/fixtures/${file}`)));
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
      return segment(dataUrl, prompt, Date.now() + 60_000, meter);
    });
    const recorded = { recordedAt: new Date().toISOString(), prompts: PROMPTS, foundAt: "50% of the labelled box covered", usage: meter.usage(), ...summary };
    writeFileSync(process.env.LUSONG_LIVE_OUT!, JSON.stringify(recorded, null, 1));
    expect(summary.samCalls).toBe((labels.positives.length + labels.negatives.length) * PROMPTS.length);
  },
  600_000,
);
