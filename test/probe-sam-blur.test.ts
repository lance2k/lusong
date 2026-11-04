import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter, segmentReply } from "../lib/meta";
import { FACE_PROMPT, PERSON_PROMPT, PLATE_PROMPT, recordBlurProbe, scoreBlurProbe, type BlurLabels, type RecordedCall } from "./blur-recall";

const PROMPTS = [PLATE_PROMPT, PERSON_PROMPT, FACE_PROMPT];
const labels = JSON.parse(readFileSync("test/fixtures/sam/blur-labels.json", "utf8")) as BlurLabels;
const files = [...labels.positives, ...labels.negatives].map((p) => p.file);
/** Each photo as production sends it to SAM: metadata stripped, the same pixel grid as the masks. */
const sanitized = (file: string) => sanitizeJpeg(new Uint8Array(readFileSync(`test/fixtures/${file}`)));
const sizes = () => Object.fromEntries(files.map((f) => [f, (({ width, height }) => ({ width, height }))(sanitized(f))]));

/**
 * Would the blur cover every labelled plate and face? Each photo in test/fixtures/sam/blur-labels.json gets the
 * `license plate`, `person` and `face` prompts, one SAM image per call: 3 images a photo, $0.0025 each, more only if a
 * call is retried (the meter counts what was billed). Runs only with LUSONG_LIVE=1 and LUSONG_LIVE_OUT=<path>; the
 * raw replies and the score go to that path.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || !process.env.LUSONG_LIVE_OUT)(
  "probe: SAM masks, grown as the blur grows them, over labelled plates and faces",
  async () => {
    const meter = new Meter();
    const { samCalls, recorded } = await recordBlurProbe(labels, PROMPTS, (file, prompt) => {
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(sanitized(file).bytes).toString("base64")}`;
      return segmentReply(dataUrl, prompt, Date.now() + 60_000, meter);
    });
    const score = scoreBlurProbe(labels, sizes(), recorded);
    const out = { recordedAt: new Date().toISOString(), prompts: PROMPTS, coveredAt: "every pixel of the labelled box", usage: meter.usage(), samCalls, result: score.result, photos: score.photos, recorded };
    writeFileSync(process.env.LUSONG_LIVE_OUT!, JSON.stringify(out, null, 1));
    expect(samCalls).toBe(files.length * PROMPTS.length);
  },
  1_800_000,
);

/** Scores recorded draws again against the current labels, offline and free. LUSONG_BLUR_RESCORE_IN=<file,file…>, LUSONG_BLUR_RESCORE_OUT=<path>. */
it.skipIf(!process.env.LUSONG_BLUR_RESCORE_IN || !process.env.LUSONG_BLUR_RESCORE_OUT)("re-scores recorded blur probes", () => {
  const draws = process.env.LUSONG_BLUR_RESCORE_IN!.split(",").map((path) => {
    const { recordedAt, recorded } = JSON.parse(readFileSync(path, "utf8")) as { recordedAt: string; recorded: Record<string, RecordedCall[]> };
    const score = scoreBlurProbe(labels, sizes(), recorded);
    return { source: path, recordedAt, result: score.result, photos: score.photos };
  });
  writeFileSync(process.env.LUSONG_BLUR_RESCORE_OUT!, JSON.stringify({ rescoredAt: new Date().toISOString(), draws }, null, 1));
  expect(draws.length).toBeGreaterThan(0);
});
