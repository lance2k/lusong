import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickObjects } from "../lib/check";
import { headEstimates } from "../lib/head";
import { parseSamText, placeRaster, type SamReply } from "../lib/sam";
import { tyreEstimates } from "../lib/tyre";
import { decideVerdict, type Reading } from "../lib/verdict";
import { judgeDepthDraw, type DepthPhoto } from "./depth-report";

const [runDir, reader = "landmark"] = process.argv.slice(2);
const labels = new Map((JSON.parse(readFileSync("test/fixtures/depth-set/labels.json", "utf8")) as DepthPhoto[]).map((p) => [p.file, p]));
const run = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
const tally: Record<string, Record<string, number>> = { before: {}, after: {} };
for (const r of run.records) {
  if (r.reader !== reader || !r.result) continue;
  const photo = labels.get(r.file)!;
  const replies = JSON.parse(readFileSync(`test/depth-runs/sam-cache/${r.file}.json`, "utf8")) as SamReply[];
  const head = JSON.parse(readFileSync(`test/depth-runs/sam-cache/${r.file}.head.json`, "utf8")) as SamReply;
  const water = parseSamText(replies[0].text).map((w) => placeRaster(w.mask));
  const objects = pickObjects(
    [
      ...parseSamText(replies[1].text).map((object) => ({ kind: "person" as const, object })),
      ...parseSamText(replies[2].text).map((object) => ({ kind: "car" as const, object })),
    ],
    r.result.image,
  );
  const readings: Reading[] = r.result.objects
    .filter((o: { usable: boolean }) => o.usable)
    .map((o: { label: string; kind: "person" | "car"; landmark: string }) => ({ label: o.label, kind: o.kind, inWater: true, landmark: o.landmark, isChild: false }));
  // The frozen candidate: only a person the model read at ankle or half_knee may be deepened by the head estimate.
  const usablePeople = new Set(
    readings.filter((x) => x.kind === "person" && (process.env.ANY_PICK === "1" || x.landmark === "ankle" || x.landmark === "half_knee")).map((x) => x.label),
  );
  const heads = headEstimates(
    objects.filter((o) => o.kind === "person" && usablePeople.has(o.label)).map((o) => ({ label: o.label, box: o.box, mask: placeRaster(o.object.mask) })),
    parseSamText(head.text),
    water,
  );
  const tyres = tyreEstimates(objects.filter((o) => o.kind === "car"), parseSamText(replies[3].text), water);
  const base = { readings, readingsComplete: r.result.verdict.readingsComplete ?? true, waterFound: water.length > 0, modelSaysFlooded: true };
  const before = decideVerdict({ ...base, tyreEstimates: tyres });
  const after = decideVerdict({ ...base, tyreEstimates: [...tyres, ...heads] });
  const b = judgeDepthDraw(photo, before);
  const a = judgeDepthDraw(photo, after);
  tally.before[b] = (tally.before[b] ?? 0) + 1;
  tally.after[a] = (tally.after[a] ?? 0) + 1;
  const show = (v: typeof before) => (v.kind === "measured" ? `${v.decidedBy.landmark} ${v.decidedBy.interval.low}-${v.decidedBy.interval.high}` : v.kind);
  console.log(
    `${photo.scene[0]} ${photo.captionDepth.padEnd(5)} ${r.file.slice(0, 26).padEnd(26)} d${r.draw} ${show(before).padEnd(22)} -> ${show(after).padEnd(26)} ${b}->${a}  heads: ${heads.map((h) => `${h.label}:${h.heads}`).join(" ")}`,
  );
}
console.log(JSON.stringify(tally));
