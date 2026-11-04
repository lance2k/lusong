import { blurCoverage } from "../lib/blur";
import { readSamReplyStrict, type Box, type PlacedRaster, type SamReply } from "../lib/sam";

export interface LabelledBox {
  box: Box;
  sure: boolean;
  where?: string;
}

export interface BlurLabels {
  positives: { file: string; plates: LabelledBox[]; faces: LabelledBox[]; identifiers?: LabelledBox[] }[];
  negatives: { file: string }[];
}

/** One SAM call as the probe recorded it: the reply's text and Meta's status, or the error the call threw. */
export type RecordedCall = { prompt: string; ok: true; status: string | null; text: string } | { prompt: string; ok: false; error: string };

type Reading = { ok: true; masks: PlacedRaster[] } | { ok: false; problem: string };

/** The strict reader publishing uses: a reply it refuses blurs nothing, so its photo is not published. */
const strict = (text: string, status: string | null): Reading => {
  const reading = readSamReplyStrict({ text, status } satisfies SamReply);
  return reading.ok ? { ok: true, masks: reading.objects.map((o) => o.placed) } : reading;
};

/** The share of a box's pixels (left/top inclusive, right/bottom exclusive) set in a row-major covered grid. */
export function boxCoverage(box: Box, covered: Uint8Array, width: number): number {
  let inside = 0;
  let total = 0;
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      total++;
      if (covered[y * width + x]) inside++;
    }
  }
  return total === 0 ? 0 : inside / total;
}

export const PLATE_PROMPT = "license plate";
export const PERSON_PROMPT = "person";
export const FACE_PROMPT = "face";

interface Scored {
  where?: string;
  sure: boolean;
  /** Plates: under the grown plate masks. Faces: under the grown person masks. What the bar is judged on. */
  byPrompt: number;
  /** Under every grown mask publishPhoto blurs (plate and person, never the experimental face prompt): reported beside the bar, never as it. */
  union: number;
}

/**
 * Scores recorded SAM calls against tight labelled boxes, as lib/photo-publish.ts and lib/blur.ts would blur them. A
 * box is covered only when every one of its pixels lies under the grown masks (blurCoverage, the blur's own regions).
 * The bar per photo: the plate and person calls both succeeded and read strictly (else publishPhoto shows no photo),
 * every labelled plate is covered by the plate masks and every labelled face by the person masks, unsure labels
 * included; `allSureCovered` is the same over sure labels only. The face prompt, when recorded, is scored as an
 * addition to the person masks (`withFace`), publishable only if it also succeeded. `read` is injectable for tests.
 */
export function scoreBlurProbe(
  labels: BlurLabels,
  sizes: Record<string, { width: number; height: number }>,
  recorded: Record<string, RecordedCall[]>,
  read: (text: string, status: string | null) => Reading = strict,
) {
  const photoList = [
    ...labels.positives.map((p) => ({ ...p, kind: "positive" as const })),
    ...labels.negatives.map((n) => ({ file: n.file, plates: [] as LabelledBox[], faces: [] as LabelledBox[], identifiers: [] as LabelledBox[], kind: "negative" as const })),
  ];
  const photos = photoList.map((photo) => {
    const { width, height } = sizes[photo.file];
    const calls = recorded[photo.file] ?? [];
    const readings = new Map<string, Reading>();
    for (const c of calls) readings.set(c.prompt, c.ok ? read(c.text, c.status) : { ok: false, problem: c.error });
    const masksOf = (prompt: string) => {
      const r = readings.get(prompt);
      return r?.ok ? r.masks : [];
    };
    const succeeded = (prompt: string) => readings.get(prompt)?.ok === true;
    for (const prompt of [PLATE_PROMPT, PERSON_PROMPT]) if (!readings.has(prompt)) readings.set(prompt, { ok: false, problem: "not recorded" });
    const failures = [...readings.entries()].flatMap(([prompt, r]) => (r.ok ? [] : [{ prompt, problem: r.problem }]));
    const failedCalls = failures.map((f) => f.prompt);
    const faceRun = readings.has(FACE_PROMPT);

    const plateCover = blurCoverage(width, height, masksOf(PLATE_PROMPT));
    const personCover = blurCoverage(width, height, masksOf(PERSON_PROMPT));
    const withFaceCover = blurCoverage(width, height, [...masksOf(PERSON_PROMPT), ...masksOf(FACE_PROMPT)]);
    const unionCover = blurCoverage(width, height, [...masksOf(PLATE_PROMPT), ...masksOf(PERSON_PROMPT)]);

    const score = (things: LabelledBox[], own: Uint8Array): Scored[] =>
      things.map(({ box, sure, where }) => ({ where, sure, byPrompt: boxCoverage(box, own, width), union: boxCoverage(box, unionCover, width) }));
    const plates = score(photo.plates, plateCover);
    const faces = score(photo.faces, personCover).map((f, i) => ({ ...f, withFace: boxCoverage(photo.faces[i].box, withFaceCover, width) }));
    const identifiers = (photo.identifiers ?? []).map(({ box, where }) => ({ where, union: boxCoverage(box, unionCover, width) }));

    const publishable = succeeded(PLATE_PROMPT) && succeeded(PERSON_PROMPT);
    const full = (x: { sure: boolean }, v: number, sureOnly: boolean) => (sureOnly && !x.sure) || v === 1;
    const bar = (sureOnly: boolean) => publishable && plates.every((p) => full(p, p.byPrompt, sureOnly)) && faces.every((f) => full(f, f.byPrompt, sureOnly));
    const allCoveredWithFace =
      faceRun && publishable && succeeded(FACE_PROMPT) && plates.every((p) => p.byPrompt === 1) && faces.every((f) => f.withFace === 1);
    return {
      file: photo.file,
      kind: photo.kind,
      publishable,
      failedCalls,
      failures,
      masks: Object.fromEntries([...readings.entries()].map(([prompt, r]) => [prompt, r.ok ? r.masks.length : null])),
      plates,
      faces,
      identifiers,
      allCovered: bar(false),
      allSureCovered: bar(true),
      allCoveredWithFace,
    };
  });

  const positives = photos.filter((p) => p.kind === "positive");
  const negatives = photos.filter((p) => p.kind === "negative");
  const plates = positives.flatMap((p) => p.plates);
  const faces = positives.flatMap((p) => p.faces);
  const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const recall = <T extends { sure: boolean }>(xs: T[], covered: (x: T) => boolean) => ({
    all: xs.length,
    covered: count(xs, covered),
    sure: count(xs, (x) => x.sure),
    sureCovered: count(xs, (x) => x.sure && covered(x)),
  });
  const misses = positives.flatMap((p) => [
    ...p.plates.filter((x) => x.byPrompt < 1).map((x) => ({ file: p.file, kind: "plate" as const, where: x.where, sure: x.sure, coverage: x.byPrompt, union: x.union, publishable: p.publishable })),
    ...p.faces.filter((x) => x.byPrompt < 1).map((x) => ({ file: p.file, kind: "face" as const, where: x.where, sure: x.sure, coverage: x.byPrompt, union: x.union, withFace: x.withFace, publishable: p.publishable })),
  ]);
  return {
    photos,
    result: {
      positives: positives.length,
      allCovered: count(positives, (p) => p.allCovered),
      allSureCovered: count(positives, (p) => p.allSureCovered),
      allCoveredWithFace: count(positives, (p) => p.allCoveredWithFace),
      unpublishable: positives.filter((p) => !p.publishable).map((p) => ({ file: p.file, failedCalls: p.failedCalls })),
      plates: { ...recall(plates, (x) => x.byPrompt === 1), coveredInUnion: count(plates, (x) => x.union === 1) },
      faces: {
        ...recall(faces, (x) => x.byPrompt === 1),
        coveredInUnion: count(faces, (x) => x.union === 1),
        coveredWithFace: count(faces, (x) => x.withFace === 1),
        sureCoveredWithFace: count(faces, (x) => x.sure && x.withFace === 1),
      },
      identifiers: { all: positives.flatMap((p) => p.identifiers).length, coveredInUnion: count(positives.flatMap((p) => p.identifiers), (x) => x.union === 1) },
      negatives: {
        photos: negatives.length,
        publishable: count(negatives, (p) => p.publishable),
        publishableWithFace: count(negatives, (p) => p.publishable && typeof p.masks[FACE_PROMPT] === "number"),
        withMasks: count(negatives, (p) => Object.values(p.masks).some((n) => (n ?? 0) > 0)),
        masks: negatives.map((p) => ({ file: p.file, masks: p.masks })),
      },
      misses,
    },
  };
}

/** One SAM call: the fixture path under test/fixtures and the prompt, the reply back with Meta's status. */
export type Segmenter = (file: string, prompt: string) => Promise<SamReply>;

/** Runs every prompt on every labelled photo, one call at a time, and records each reply or error for scoring. */
export async function recordBlurProbe(labels: BlurLabels, prompts: readonly string[], segment: Segmenter) {
  const recorded: Record<string, RecordedCall[]> = {};
  let samCalls = 0;
  for (const { file } of [...labels.positives, ...labels.negatives]) {
    recorded[file] = [];
    for (const prompt of prompts) {
      samCalls++;
      try {
        const reply = await segment(file, prompt);
        recorded[file].push({ prompt, ok: true, status: reply.status, text: reply.text });
      } catch (err) {
        recorded[file].push({ prompt, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { samCalls, recorded };
}
