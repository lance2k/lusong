// Offline census of SAM's `tire` masks per depth-set photo (cached SAM replies; no network, no spend).
import { readFileSync } from "node:fs";
import { waterlineY } from "../lib/overlay";
import { parseSamText, placeRaster, type SamReply } from "../lib/sam";
import { tyreDepthCm } from "../lib/tyre";

const split = process.argv[2] ?? "tuning";
const labels = JSON.parse(readFileSync("test/fixtures/depth-set/labels.json", "utf8")) as { file: string; scene: string; captionDepth: string }[];
const splitOf = JSON.parse(readFileSync("test/fixtures/depth-set/split.json", "utf8")).split as Record<string, string>;
for (const p of labels.filter((x) => splitOf[x.file] === split)) {
  const replies = JSON.parse(readFileSync(`test/depth-runs/sam-cache/${p.file}.json`, "utf8")) as SamReply[];
  const water = parseSamText(replies[0].text).map((w) => placeRaster(w.mask));
  const cars = parseSamText(replies[2].text);
  const tyres = parseSamText(replies[3].text);
  const rows = tyres.map((t) => {
    const w = Math.round(t.box.right - t.box.left), h = Math.round(t.box.bottom - t.box.top);
    const wet = waterlineY(placeRaster(t.mask), t.box, water) !== null;
    const est = tyreDepthCm({ width: w, height: h });
    return `${w}x${h}${wet ? "W" : ""}${est ? `=${est.low}-${est.high}` : ""}`;
  });
  console.log(`${p.scene[0]} ${p.captionDepth.padEnd(6)} ${p.file.slice(0, 34).padEnd(34)} water:${water.length} cars:${cars.length} tyres:${tyres.length} ${rows.join(" ")}`);
}
