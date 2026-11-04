import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeJpeg } from "../lib/jpeg";
import { Meter, segmentReply } from "../lib/meta";

const phrase = process.argv[2] ?? "head";
const split = JSON.parse(readFileSync("test/fixtures/depth-set/split.json", "utf8")).split as Record<string, string>;
const side = process.argv[3] ?? "tuning";
const files = Object.keys(split).filter((f) => side === "all" || split[f] === side);
const meter = new Meter();
let ok = 0;
await Promise.all(
  files.map(async (file) => {
    const out = join("test/depth-runs/sam-cache", `${file}.${phrase}.json`);
    if (existsSync(out)) return ok++;
    const jpeg = sanitizeJpeg(new Uint8Array(readFileSync(join("test/fixtures/depth-set", file))));
    const url = `data:image/jpeg;base64,${Buffer.from(jpeg.bytes).toString("base64")}`;
    const reply = await segmentReply(url, phrase, Date.now() + 60_000, meter);
    writeFileSync(out, JSON.stringify(reply));
    ok++;
  }),
);
console.log(`${ok} of ${files.length} cached; usage ${JSON.stringify(meter.usage())}`);
