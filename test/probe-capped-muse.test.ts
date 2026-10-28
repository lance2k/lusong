import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter } from "../lib/meta";
import { readWaterlines, type LabelledObject } from "../lib/readings";

/**
 * Records what a Muse Spark reply looks like when it stops at its output cap, for the crowded-photo tests.
 * The Shah Alam scene (11 objects) used 6,129 and 7,999 of 8,000 output tokens in acceptance run 2, so here
 * the cap is cut to 1,500 to make it run out on purpose. One paid call, about $0.011. Runs only with
 * LUSONG_LIVE=1 and LUSONG_PROBE=capped; the raw reply goes to test/fixtures/muse/.
 */
it.skipIf(process.env.LUSONG_LIVE !== "1" || process.env.LUSONG_PROBE !== "capped")(
  "probe: a Muse reply cut off at its output cap",
  async () => {
    const run = JSON.parse(readFileSync("test/acceptance-runs/2026-10-28T03-56-20-872Z/results.json", "utf8")) as {
      records: { file: string; draw: number; result: { objects: LabelledObject[] } }[];
    };
    const record = run.records.find((r) => r.file === "shah-alam-2021.jpg" && r.draw === 2)!;
    const objects = record.result.objects.map(({ label, kind, box }) => ({ label, kind, box }));
    const jpeg = sanitizeJpeg(new Uint8Array(readFileSync("test/fixtures/acceptance/shah-alam-2021.jpg")));

    const realFetch = globalThis.fetch;
    const replies: { status: number; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      body.max_completion_tokens = 1_500;
      const res = await realFetch(url, { ...init, body: JSON.stringify(body) });
      replies.push({ status: res.status, body: await res.clone().text() });
      return res;
    });
    const meter = new Meter();
    let outcome: string;
    try {
      const read = await readWaterlines(
        `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`,
        objects,
        { width: jpeg.width, height: jpeg.height },
        Date.now() + 100_000,
        meter,
      );
      outcome = `returned ${read.readings.length} readings`;
    } catch (err) {
      outcome = `threw ${String(err)}`;
    } finally {
      vi.unstubAllGlobals();
    }
    mkdirSync("test/fixtures/muse", { recursive: true });
    writeFileSync(
      "test/fixtures/muse/shah-alam-capped-1500.json",
      JSON.stringify({ recordedAt: new Date().toISOString(), cap: 1_500, outcome, usage: meter.usage(), replies }, null, 1),
    );
    expect(replies.length).toBeGreaterThan(0);
  },
  120_000,
);
