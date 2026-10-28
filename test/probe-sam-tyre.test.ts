import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter, segment } from "../lib/meta";

const PHOTOS = ["shah-alam-2021", "manila-2012-raincoats"];
const PHRASES = ["flood water", "car", "tire", "wheel"];

/**
 * Records SAM 3.1's replies for the tyre-geometry estimate: which phrase finds tyres, and what their masks look
 * like. Acceptance photos only, so the depth set is never used to choose the method. 8 SAM images, about $0.02.
 * Runs only with LUSONG_LIVE=1 and LUSONG_PROBE=tyre; raw replies go to test/fixtures/sam/<photo>__<phrase>.json.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_PROBE !== "tyre")(
  "probe: SAM masks of tyres on cars standing in water",
  async () => {
    const realFetch = globalThis.fetch;
    let current = "";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const res = await realFetch(url, init);
      writeFileSync(`test/fixtures/sam/${current}.json`, await res.clone().text());
      return res;
    });
    const meter = new Meter();
    const counts: Record<string, number> = {};
    try {
      for (const photo of PHOTOS) {
        const jpeg = sanitizeJpeg(new Uint8Array(readFileSync(`test/fixtures/acceptance/${photo}.jpg`)));
        const dataUrl = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
        for (const phrase of PHRASES) {
          current = `${photo}__${phrase.replace(/ /g, "_")}`;
          const text = await segment(dataUrl, phrase, Date.now() + 60_000, meter);
          counts[current] = (text.match(/<\|mask/g) ?? []).length;
        }
      }
    } finally {
      vi.unstubAllGlobals();
      writeFileSync("test/fixtures/sam/tyre-probe-summary.json", JSON.stringify({ recordedAt: new Date().toISOString(), counts, usage: meter.usage() }, null, 1));
    }
    expect(Object.keys(counts)).toHaveLength(PHOTOS.length * PHRASES.length);
  },
  180_000,
);
