import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter, segmentReply } from "../lib/meta";
import { recordBlurProbe, type BlurLabels, type RecordedCall } from "./blur-recall";
import { compareSets, ImageAllowance, VEHICLE_PROMPTS } from "./whole-blur";

const labels = JSON.parse(readFileSync("test/fixtures/sam/blur-labels.json", "utf8")) as BlurLabels;
const files = [...labels.positives, ...labels.negatives].map((p) => p.file);
/** Each photo as production sends it to SAM: metadata stripped, the same pixel grid as the masks. */
const sanitized = (file: string) => sanitizeJpeg(new Uint8Array(readFileSync(`test/fixtures/${file}`)));
const sizes = () => Object.fromEntries(files.map((f) => [f, (({ width, height }) => ({ width, height }))(sanitized(f))]));

const env = process.env;
const live = env.LUSONG_LIVE === "1" && !!env.LUSONG_LIVE_OUT && !!env.LUSONG_BLUR_PROMPTS && !!env.LUSONG_BLUR_ALLOWANCE && !!env.LUSONG_BLUR_MAX_IMAGES;

/**
 * Records SAM replies for the `;`-separated LUSONG_BLUR_PROMPTS on every photo in blur-labels.json, one image a call,
 * $0.0025 each. Spending is held by an allowance on disk (LUSONG_BLUR_ALLOWANCE, cap LUSONG_BLUR_MAX_IMAGES images)
 * shared by every draw: each call reserves both attempts first, and a call the allowance can't hold is recorded as a
 * failed call, never as "found nothing". Writes the replies, the sanitized photos' hashes and the allowance to
 * LUSONG_LIVE_OUT.
 */
it.skipIf(!live)(
  "probe: SAM vehicle and water masks on the blur set",
  async () => {
    const prompts = env.LUSONG_BLUR_PROMPTS!.split(";");
    const allowance = new ImageAllowance(env.LUSONG_BLUR_ALLOWANCE!, Number(env.LUSONG_BLUR_MAX_IMAGES));
    const meter = new Meter();
    const { samCalls, recorded } = await recordBlurProbe(labels, prompts, async (file, prompt) => {
      if (!allowance.admit()) throw new Error("refused: image allowance");
      const own = new Meter();
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(sanitized(file).bytes).toString("base64")}`;
      try {
        const reply = await segmentReply(dataUrl, prompt, Date.now() + 60_000, own);
        allowance.settle({ threw: false, metered: own.usage().samImages, complete: own.usage().complete });
        return reply;
      } catch (err) {
        allowance.settle({ threw: true, metered: own.usage().samImages, complete: false });
        throw err;
      } finally {
        meter.include(own);
      }
    });
    const photos = Object.fromEntries(
      files.map((f) => {
        const s = sanitized(f);
        return [f, { width: s.width, height: s.height, sha256: createHash("sha256").update(s.bytes).digest("hex") }];
      }),
    );
    const out = { recordedAt: new Date().toISOString(), prompts, usage: meter.usage(), allowance: allowance.state(), samCalls, photos, recorded };
    writeFileSync(env.LUSONG_LIVE_OUT!, JSON.stringify(out, null, 1));
    expect(samCalls).toBe(files.length * prompts.length);
  },
  1_800_000,
);

type Run = { recordedAt: string; recorded: Record<string, RecordedCall[]>; photos?: Record<string, { width: number; height: number; sha256: string }> };

/**
 * Compares every subset of the vehicle phrases, offline and free. LUSONG_VBLUR_OLD and LUSONG_VBLUR_NEW are
 * comma-separated runs of equal length: old[i] (PR #67's plate and person replies) is merged per photo with new[i]
 * (the vehicle and water replies) into draw i. LUSONG_VBLUR_OUT=<path>.
 */
it.skipIf(!env.LUSONG_VBLUR_OLD || !env.LUSONG_VBLUR_NEW || !env.LUSONG_VBLUR_OUT)("compares whole-object blur sets on recorded draws", () => {
  const load = (paths: string) => paths.split(",").map((path) => ({ path, run: JSON.parse(readFileSync(path, "utf8")) as Run }));
  const old = load(env.LUSONG_VBLUR_OLD!);
  const fresh = load(env.LUSONG_VBLUR_NEW!);
  expect(old.length).toBe(fresh.length);
  const now = sizes();
  for (const { path, run } of fresh) {
    for (const f of files) {
      const s = sanitized(f);
      expect(run.photos?.[f], `${path} ${f}`).toEqual({ ...now[f], sha256: createHash("sha256").update(s.bytes).digest("hex") });
    }
  }
  const draws = old.map(({ run }, i) =>
    Object.fromEntries(files.map((f) => [f, [...(run.recorded[f] ?? []), ...(fresh[i].run.recorded[f] ?? [])]])),
  );
  const sets = compareSets(labels, now, draws, VEHICLE_PROMPTS);
  const out = {
    comparedAt: new Date().toISOString(),
    draws: old.map((o, i) => ({ old: o.path, oldRecordedAt: o.run.recordedAt, new: fresh[i].path, newRecordedAt: fresh[i].run.recordedAt })),
    provenance: "new runs' sanitized photos match today's by size and sha256; PR #67's runs recorded no hashes, so their pairing is by file name and size",
    sets,
  };
  writeFileSync(env.LUSONG_VBLUR_OUT!, JSON.stringify(out, null, 1));
  expect(sets.length).toBe(2 ** VEHICLE_PROMPTS.length);
}, 600_000);
