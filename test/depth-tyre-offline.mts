// Both tyre geometries over a recorded depth run, from the SAM replies that run read and the Muse readings it recorded.
// No network, no spend. Usage: tsx test/depth-tyre-offline.mts <runDir> <tuning|heldout> [reader]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pickObjects } from "../lib/check";
import { parseSamText, placeRaster, type SamReply } from "../lib/sam";
import { tyreEstimates } from "../lib/tyre";
import { decideVerdict, type Reading, type Verdict } from "../lib/verdict";
import type { DepthPhoto } from "./depth-report";
import { replayTyreArms, type RunRecord } from "./depth-tyre-arms";

const [runDir, split, reader = "landmark"] = process.argv.slice(2);
const splitOf = JSON.parse(readFileSync("test/fixtures/depth-set/split.json", "utf8")).split as Record<string, string>;
const photos = (JSON.parse(readFileSync("test/fixtures/depth-set/labels.json", "utf8")) as DepthPhoto[]).map((p) => ({ ...p, split: splitOf[p.file] }));
const run = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));

function samOf(r: RunRecord): SamReply[] {
  const own = join(runDir, "sam", `${r.file}.d${r.draw}.json`);
  if (existsSync(own)) return JSON.parse(readFileSync(own, "utf8"));
  if (!run.samCache) throw new Error(`${r.file} d${r.draw}: the run saved no SAM replies for it and used no cache`);
  return JSON.parse(readFileSync(`test/depth-runs/sam-cache/${r.file}.json`, "utf8"));
}

const show = (v: Verdict) => (v.kind === "measured" ? `${v.decidedBy.landmark} ${v.decidedBy.interval.low}-${v.decidedBy.interval.high}` : v.kind);
const out = replayTyreArms({
  photos,
  split,
  draws: run.draws,
  reader,
  records: run.records,
  requireComplete: split === "heldout",
  replay: (r, photo) => {
    const result = r.result as unknown as {
      image: { width: number; height: number };
      objects: { label: string; kind: "person" | "car"; landmark: string; usable: boolean }[];
      verdict: Verdict & { readingsComplete?: boolean };
    };
    const replies = samOf(r);
    const water = parseSamText(replies[0].text).map((w) => placeRaster(w.mask));
    const objects = pickObjects(
      [
        ...parseSamText(replies[1].text).map((object) => ({ kind: "person" as const, object })),
        ...parseSamText(replies[2].text).map((object) => ({ kind: "car" as const, object })),
      ],
      result.image,
    );
    const readings: Reading[] = result.objects
      .filter((o) => o.usable)
      .map((o) => ({ label: o.label, kind: o.kind, inWater: true, landmark: o.landmark as Reading["landmark"], isChild: false }));
    const cars = objects.filter((o) => o.kind === "car");
    const tyres = parseSamText(replies[3].text);
    const v1Tyres = tyreEstimates(cars, tyres, water, { geometry: "v1" });
    const v2Tyres = tyreEstimates(cars, tyres, water, { geometry: "v2" });
    const recorded = result.verdict;
    const base = { readings, readingsComplete: recorded.kind === "measured" ? recorded.readingsComplete : true, waterFound: water.length > 0, modelSaysFlooded: true };
    const v1 = decideVerdict({ ...base, tyreEstimates: v1Tyres });
    const v2 = decideVerdict({ ...base, tyreEstimates: v2Tyres });
    if (v1Tyres.length + v2Tyres.length > 0 || show(v1) !== show(v2)) {
      console.log(
        `${photo.scene[0]} ${photo.captionDepth.padEnd(6)} ${r.file.slice(0, 30).padEnd(30)} d${r.draw} ${show(v1).padEnd(22)} -> ${show(v2).padEnd(22)} v1 tyres ${JSON.stringify(v1Tyres)} v2 tyres ${JSON.stringify(v2Tyres)}`,
      );
    }
    return { v1, v2, v2Tyres: v2Tyres.length };
  },
});
console.log(`split ${split} (${out.use}); reader ${reader}; draws ${run.draws}; missing ${out.missing.length}`);
for (const [scene, t] of Object.entries(out.tally)) console.log(scene, "v1", JSON.stringify(t.v1), "\n", scene, "v2", JSON.stringify(t.v2));
console.log("photos with a v2 tyre estimate:", JSON.stringify(out.photosWithTyre));
