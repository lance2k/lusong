import { parseSamText, placeRaster, type Box, type PlacedRaster } from "../lib/sam";

export interface LabelledPlate {
  box: Box;
  sure: boolean;
}

export interface FoundMask {
  box: Box;
  placed: PlacedRaster;
}

export interface PlateScore {
  plates: { found: boolean; coverage: number; sure: boolean }[];
  /** Masks whose box touches no labelled plate. */
  falseMasks: number;
}

function covers(p: PlacedRaster, x: number, y: number): boolean {
  if (x < p.bounds.left || x >= p.bounds.right || y < p.bounds.top || y >= p.bounds.bottom) return false;
  const col = Math.min(p.width - 1, Math.floor((x - p.bounds.left) / p.scaleX));
  const row = Math.min(p.height - 1, Math.floor((y - p.bounds.top) / p.scaleY));
  return p.raster[row * p.width + col] !== 0;
}

const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * A plate counts as found when the masks together cover at least `threshold` of its hand-drawn box, read pixel by
 * pixel at pixel centres. The labelled boxes are slightly loose, so full coverage is not expected.
 */
export function scorePlates(plates: readonly LabelledPlate[], masks: readonly FoundMask[], threshold = 0.5): PlateScore {
  const scored = plates.map(({ box, sure }) => {
    let inside = 0;
    let total = 0;
    for (let y = box.top; y < box.bottom; y++) {
      for (let x = box.left; x < box.right; x++) {
        total++;
        if (masks.some((m) => covers(m.placed, x + 0.5, y + 0.5))) inside++;
      }
    }
    const coverage = total === 0 ? 0 : inside / total;
    return { found: coverage >= threshold, coverage, sure };
  });
  const falseMasks = masks.filter((m) => !plates.some((p) => intersects(m.box, p.box))).length;
  return { plates: scored, falseMasks };
}

export interface ProbeLabels {
  positives: { file: string; plates: LabelledPlate[] }[];
  negatives: { file: string }[];
}

/** One SAM call: the fixture path under test/fixtures, the prompt, and the raw segmentation text back. */
export type Segmenter = (file: string, prompt: string) => Promise<string>;

interface CallRecord {
  prompt: string;
  ok: boolean;
  error?: string;
  masks: { box: Box; confidence?: number }[];
  plates: PlateScore["plates"];
  falseMasks: number;
  rawText?: string;
}

interface PhotoRecord {
  file: string;
  kind: "positive" | "negative";
  calls: CallRecord[];
  /** Both prompts' masks together. */
  both: PlateScore;
}

interface Tally {
  surePlatesFound: number;
  photosWithEverySurePlateFound: number;
  photosWithAnyPlateFound: number;
}

function tally(scores: PlateScore[]): Tally {
  const sureFound = scores.map((s) => s.plates.filter((p) => p.sure && p.found).length);
  return {
    surePlatesFound: sureFound.reduce((a, b) => a + b, 0),
    photosWithEverySurePlateFound: scores.filter((s) => s.plates.every((p) => !p.sure || p.found)).length,
    photosWithAnyPlateFound: scores.filter((s) => s.plates.some((p) => p.found)).length,
  };
}

/**
 * Runs every prompt on every labelled photo, one call at a time, and scores each prompt alone and both together
 * (the union of their masks, which is what a blur would cover). A failed call finds nothing and is recorded.
 */
export async function runPlateProbe(labels: ProbeLabels, prompts: readonly string[], segment: Segmenter) {
  let samCalls = 0;
  const photos: PhotoRecord[] = [];
  const photoList = [
    ...labels.positives.map((p) => ({ file: p.file, kind: "positive" as const, plates: p.plates })),
    ...labels.negatives.map((n) => ({ file: n.file, kind: "negative" as const, plates: [] as LabelledPlate[] })),
  ];
  for (const photo of photoList) {
    const calls: CallRecord[] = [];
    const all: FoundMask[] = [];
    for (const prompt of prompts) {
      samCalls++;
      let text: string;
      try {
        text = await segment(photo.file, prompt);
      } catch (err) {
        calls.push({ prompt, ok: false, error: err instanceof Error ? err.message : String(err), masks: [], ...scorePlates(photo.plates, []) });
        continue;
      }
      const found = parseSamText(text).map((o) => ({ box: o.box, placed: placeRaster(o.mask), confidence: o.mask.confidence }));
      all.push(...found);
      calls.push({ prompt, ok: true, masks: found.map(({ box, confidence }) => ({ box, confidence })), ...scorePlates(photo.plates, found), rawText: text });
    }
    photos.push({ file: photo.file, kind: photo.kind, calls, both: scorePlates(photo.plates, all) });
  }

  const positives = photos.filter((p) => p.kind === "positive");
  const negatives = photos.filter((p) => p.kind === "negative");
  const perPrompt = (pick: (p: PhotoRecord, prompt: string) => number) =>
    Object.fromEntries(prompts.map((prompt) => [prompt, photos.reduce((n, p) => n + pick(p, prompt), 0)]));
  const callOf = (p: PhotoRecord, prompt: string) => p.calls.find((c) => c.prompt === prompt)!;
  const surePlates = positives.flatMap((p) => p.both.plates).filter((p) => p.sure);
  const unsurePlates = positives.flatMap((p) => p.both.plates).filter((p) => !p.sure);
  return {
    samCalls,
    photos,
    result: {
      platePhotos: positives.length,
      surePlates: surePlates.length,
      unsurePlates: unsurePlates.length,
      unsurePlatesFound: unsurePlates.filter((p) => p.found).length,
      byPrompt: Object.fromEntries(prompts.map((prompt) => [prompt, tally(positives.map((p) => callOf(p, prompt)))])),
      both: tally(positives.map((p) => p.both)),
      negativePhotos: negatives.length,
      negativeFalseMasks: perPrompt((p, prompt) => (p.kind === "negative" ? callOf(p, prompt).falseMasks : 0)),
      positiveFalseMasks: perPrompt((p, prompt) => (p.kind === "positive" ? callOf(p, prompt).falseMasks : 0)),
    },
  };
}
