import { OutputCapError, segmentReply, type Meter } from "./meta";
import { maskToPlacedPath, waterlineY, type PlacedPath } from "./overlay";
import { readWaterlines, type LabelledObject, type Reader, type ReadingDetail } from "./readings";
import { parseSamText, placeRaster, type Box, type SamObject, type SamReply } from "./sam";
import { tyreEstimates } from "./tyre";
import {
  decideVerdict,
  isUsable,
  LANDMARK_CM,
  type Interval,
  type Landmark,
  type ObjectKind,
  type Verdict,
} from "./verdict";

/** Boxes below this share of the photo are dropped; quiapo-1's waders are 0.09–0.48 %. */
const MIN_AREA_SHARE = 0.001;
const MAX_OBJECTS = 12;
/** Every Meta call and retry wait must finish inside this; the route's maxDuration is 120 s. */
export const PIPELINE_BUDGET_MS = 100_000;
/** The reader the routes use. */
export const DEFAULT_READER: Reader = "landmark";

export interface CheckedObject {
  label: string;
  kind: ObjectKind;
  box: Box;
  /** Where SAM's mask meets the water, in source px; null when it does not touch water. */
  waterlineY: number | null;
  landmark: Landmark | null;
  usable: boolean;
  interval: Interval | null;
  /** Cars only: the depth from the hidden part of its tyre, when one is seen side-on at the waterline. */
  tyreCm: Interval | null;
  note: string | null;
  /** The model's own waterline pick and hidden-part answer, before tested code combined them. Never sent to a page. */
  detail: ReadingDetail | null;
}

export interface CheckResult {
  image: { width: number; height: number };
  water: PlacedPath[];
  objects: CheckedObject[];
  verdict: Verdict;
  reader: Reader;
  /** How the model's reply broke the one-reading-per-object contract, if it did. */
  readingProblems: string[];
  caveats: string;
  timingsMs: { segmentation: number; readings: number; total: number };
  /** SAM's whole `person` reply, every mask in it and Meta's status, for the privacy blur. Never sent to a page. */
  personReply: SamReply;
}

/** What the page receives. Nothing the model wrote as free text, so it cannot put "passable" on the page. */
export type PageObject = Omit<CheckedObject, "note" | "detail">;
export type PageResult = Pick<CheckResult, "image" | "water" | "verdict" | "timingsMs"> & { objects: PageObject[] };

export function forPage(result: CheckResult): PageResult {
  return {
    image: result.image,
    water: result.water,
    objects: result.objects.map((o) => ({
      label: o.label,
      kind: o.kind,
      box: o.box,
      waterlineY: o.waterlineY,
      landmark: o.landmark,
      usable: o.usable,
      interval: o.interval,
      tyreCm: o.tyreCm,
    })),
    verdict: result.verdict,
    timingsMs: result.timingsMs,
  };
}

function pickObjects(
  found: { kind: ObjectKind; object: SamObject }[],
  image: { width: number; height: number },
): (LabelledObject & { object: SamObject })[] {
  const area = (b: Box) => (b.right - b.left) * (b.bottom - b.top);
  const kept = found
    .filter(({ object }) => area(object.box) / (image.width * image.height) >= MIN_AREA_SHARE)
    .sort((a, b) => area(b.object.box) - area(a.object.box))
    .slice(0, MAX_OBJECTS)
    .sort((a, b) => a.object.box.left - b.object.box.left);
  const counters = { person: 0, car: 0 };
  return kept.map(({ kind, object }) => ({
    label: `${kind === "person" ? "P" : "C"}${++counters[kind]}`,
    kind,
    box: object.box,
    object,
  }));
}

/** The four SAM 3.1 prompts a check sends, in the order `readSegmented` expects their replies. */
export const SAM_PHRASES = ["flood water", "person", "car", "tire"] as const;

/** Runs every SAM prompt on the photo. Settles every call before failing, so the meter holds what the others cost. */
export async function segmentPhoto(imageDataUrl: string, deadline: number, meter: Meter): Promise<SamReply[]> {
  const settled = await Promise.allSettled(SAM_PHRASES.map((phrase) => segmentReply(imageDataUrl, phrase, deadline, meter)));
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<SamReply>).value);
}

/**
 * Reads the waterlines from SAM replies already in hand and decides the verdict. The depth-set harness calls it with
 * each reader on one set of replies, so a comparison between readers shares its segmentation.
 */
export async function readSegmented(
  imageDataUrl: string,
  image: { width: number; height: number },
  replies: readonly SamReply[],
  meter: Meter,
  opts: { deadline: number; reader?: Reader; segmentationMs?: number },
): Promise<CheckResult> {
  const started = Date.now();
  const reader = opts.reader ?? DEFAULT_READER;
  const [waterText, personText, carText, tyreText] = replies.map((r) => r.text);
  // A failed or malformed reply has empty text that would parse as "found nothing", so it must not count as complete.
  const samComplete = replies.length === SAM_PHRASES.length && replies.every((r) => r.status === "completed");

  const water = parseSamText(waterText);
  const objects = pickObjects(
    [
      ...parseSamText(personText).map((object) => ({ kind: "person" as const, object })),
      ...parseSamText(carText).map((object) => ({ kind: "car" as const, object })),
    ],
    image,
  );
  let tooCrowded = false;
  const model =
    objects.length > 0
      ? await readWaterlines(imageDataUrl, objects, image, opts.deadline, meter, reader).catch((err: unknown) => {
          if (!(err instanceof OutputCapError)) throw err;
          tooCrowded = true;
          return null;
        })
      : null;
  const read = Date.now();

  const placedWater = water.map((w) => placeRaster(w.mask));
  const tyres = tyreEstimates(
    objects.filter((o) => o.kind === "car"),
    parseSamText(tyreText),
    placedWater,
  );
  const verdict: Verdict = tooCrowded
    ? { kind: "cannot_measure", reason: "too_crowded" }
    : decideVerdict({
        readings: model?.readings ?? [],
        readingsComplete: samComplete && (model?.problems.length ?? 0) === 0,
        waterFound: water.length > 0,
        modelSaysFlooded: model?.modelSaysFlooded ?? false,
        tyreEstimates: tyres,
      });

  const segmentationMs = opts.segmentationMs ?? 0;
  return {
    image,
    water: water.map((w) => maskToPlacedPath(w.mask)),
    objects: objects.map((o) => {
      const reading = model?.readings.find((r) => r.label === o.label);
      const usable = reading ? isUsable(reading) : false;
      return {
        label: o.label,
        kind: o.kind,
        box: o.box,
        waterlineY: waterlineY(placeRaster(o.object.mask), o.box, placedWater),
        landmark: reading?.landmark ?? null,
        usable,
        interval: usable && reading ? LANDMARK_CM[reading.landmark as keyof typeof LANDMARK_CM] : null,
        tyreCm: tyres.find((t) => t.label === o.label)?.interval ?? null,
        note: model?.notes[o.label] ?? null,
        detail: model?.details[o.label] ?? null,
      };
    }),
    verdict,
    reader,
    readingProblems: model?.problems ?? [],
    caveats: model?.caveats ?? "",
    timingsMs: { segmentation: segmentationMs, readings: read - started, total: segmentationMs + (read - started) },
    personReply: replies[1],
  };
}

export async function checkPhoto(
  imageDataUrl: string,
  image: { width: number; height: number },
  meter: Meter,
  opts: { deadline?: number; reader?: Reader } = {},
): Promise<CheckResult> {
  const started = Date.now();
  /** A caller with its own request deadline (epoch ms) can end the pipeline sooner. */
  const deadline = Math.min(started + PIPELINE_BUDGET_MS, opts.deadline ?? Infinity);
  const replies = await segmentPhoto(imageDataUrl, deadline, meter);
  return readSegmented(imageDataUrl, image, replies, meter, { deadline, reader: opts.reader, segmentationMs: Date.now() - started });
}
