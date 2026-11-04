import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ATTEMPTS_PER_CALL } from "../lib/budget";
import { blurCoverage } from "../lib/blur";
import { readSamReplyStrict, type PlacedRaster } from "../lib/sam";
import { boxCoverage, PERSON_PROMPT, PLATE_PROMPT, type BlurLabels, type LabelledBox, type RecordedCall } from "./blur-recall";

/** The vehicle phrases the whole-object probe tries. `car` is one lib/check.ts already sends for every photo. */
export const VEHICLE_PROMPTS = ["car", "motorcycle", "vehicle", "jeepney"] as const;
export const WATER_PROMPT = "flood water";
/** Phrases a photo report already has a reply for (lib/check.ts:102), so blurring with them adds no SAM image. */
const ALREADY_CALLED = new Set(["car"]);

type Reading = { ok: true; masks: PlacedRaster[] } | { ok: false; problem: string };
type Reader = (text: string, status: string | null) => Reading;

const strict: Reader = (text, status) => {
  const reading = readSamReplyStrict({ text, status });
  return reading.ok ? { ok: true, masks: reading.objects.map((o) => o.placed) } : reading;
};

/** Each mask's raw pixels (no margin) over a width × height photo, read at pixel centres as lib/blur.ts reads them. */
function maskPixels(width: number, height: number, masks: readonly PlacedRaster[]): Uint8Array {
  const all = new Uint8Array(width * height);
  for (const mask of masks) {
    const { bounds } = mask;
    for (let y = Math.max(0, Math.floor(bounds.top)); y < Math.min(height, Math.ceil(bounds.bottom)); y++) {
      const row = Math.floor((y + 0.5 - bounds.top) / mask.scaleY);
      if (row < 0 || row >= mask.height) continue;
      for (let x = Math.max(0, Math.floor(bounds.left)); x < Math.min(width, Math.ceil(bounds.right)); x++) {
        const col = Math.floor((x + 0.5 - bounds.left) / mask.scaleX);
        if (col >= 0 && col < mask.width && mask.raster[row * mask.width + col]) all[y * width + x] = 1;
      }
    }
  }
  return all;
}

/** Square dilation by r pixels over a whole photo grid. */
function dilate(grid: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, len: number, lines: number, at: (line: number, i: number) => number) => {
    const out = new Uint8Array(src.length);
    for (let line = 0; line < lines; line++) {
      let count = 0;
      for (let i = 0; i < Math.min(r, len); i++) count += src[at(line, i)];
      for (let i = 0; i < len; i++) {
        if (i + r < len) count += src[at(line, i + r)];
        if (i - r - 1 >= 0) count -= src[at(line, i - r - 1)];
        if (count > 0) out[at(line, i)] = 1;
      }
    }
    return out;
  };
  return pass(pass(grid, width, height, (y, x) => y * width + x), height, width, (x, y) => y * width + x);
}

const countSet = (g: Uint8Array) => g.reduce((n, v) => n + v, 0);

export interface WaterFigures {
  /** Pixels of the raw `flood water` masks, and their share of the photo. */
  pixels: number;
  share: number;
  /** Share of those water pixels the set's blur leaves as they were; null with no water. */
  unblurredShare: number | null;
  /**
   * Detected water near detected people and vehicles: water pixels within max(6, 2% of the longer side) px of any
   * raw mask of the band prompts, fixed across sets so sets compare. Not the waterline itself: SAM can miss the
   * object or the contact region. Null when a band prompt's reply is unusable.
   */
  band: number | null;
  bandUnblurredShare: number | null;
}

type Photo = { file: string; plates: LabelledBox[]; faces: LabelledBox[]; kind: "positive" | "negative" };

const photosOf = (labels: BlurLabels): Photo[] => [
  ...labels.positives.map((p) => ({ file: p.file, plates: p.plates, faces: p.faces, kind: "positive" as const })),
  ...labels.negatives.map((n) => ({ file: n.file, plates: [] as LabelledBox[], faces: [] as LabelledBox[], kind: "negative" as const })),
];

/** One photo's readings and grids, computed once and shared by every set scored on the same recorded calls. */
function photoCache(photo: Photo, size: { width: number; height: number }, calls: RecordedCall[], read: Reader, bandPrompts: readonly string[]) {
  const { width, height } = size;
  const readings = new Map<string, Reading>();
  for (const c of calls) {
    if (readings.has(c.prompt)) throw new Error(`${photo.file}: two recorded calls for "${c.prompt}"`);
    readings.set(c.prompt, c.ok ? read(c.text, c.status) : { ok: false, problem: c.error });
  }
  const reading = (prompt: string): Reading => readings.get(prompt) ?? { ok: false, problem: "not recorded" };
  const masksOf = (prompt: string) => {
    const r = reading(prompt);
    return r.ok ? r.masks : [];
  };
  const grownGrids = new Map<string, Uint8Array>();
  /** The pixels blurMasked pixelates for these prompts' masks: blurCoverage is a per-mask union, so it composes by OR. */
  const grown = (prompts: readonly string[]) => {
    const out = new Uint8Array(width * height);
    for (const p of prompts) {
      if (!grownGrids.has(p)) grownGrids.set(p, blurCoverage(width, height, masksOf(p)));
      const g = grownGrids.get(p)!;
      for (let i = 0; i < out.length; i++) out[i] |= g[i];
    }
    return out;
  };
  let wet: { grid: Uint8Array; count: number; band: Uint8Array | null } | null | undefined;
  const water = () => {
    if (wet !== undefined) return wet;
    const r = reading(WATER_PROMPT);
    if (!r.ok) return (wet = null);
    const grid = maskPixels(width, height, r.masks);
    let band: Uint8Array | null = null;
    if (bandPrompts.every((p) => reading(p).ok)) {
      const radius = Math.max(6, Math.round(0.02 * Math.max(width, height)));
      const near = dilate(maskPixels(width, height, bandPrompts.flatMap(masksOf)), width, height, radius);
      band = grid.map((v, i) => v & near[i]);
    }
    return (wet = { grid, count: countSet(grid), band });
  };
  return { photo, width, height, reading, grown, water };
}

function scorePhoto(cache: ReturnType<typeof photoCache>, set: readonly string[]) {
  const { photo, width, height, reading, grown } = cache;
  const required = [PLATE_PROMPT, PERSON_PROMPT, ...set];
  const failures = required.flatMap((prompt) => {
    const r = reading(prompt);
    return r.ok ? [] : [{ prompt, problem: r.problem }];
  });
  const publishable = failures.length === 0;
  const plateCover = grown([PLATE_PROMPT, ...set]);
  const faceCover = grown([PERSON_PROMPT, ...set]);
  const blurred = grown(required);
  const score = (things: LabelledBox[], own: Uint8Array) =>
    things.map(({ box, sure, where }) => ({ where, sure, assigned: boxCoverage(box, own, width), union: boxCoverage(box, blurred, width) }));
  const plates = score(photo.plates, plateCover);
  const faces = score(photo.faces, faceCover);
  const bar = (sureOnly: boolean) => publishable && [...plates, ...faces].every((x) => (sureOnly && !x.sure) || x.assigned === 1);

  const pixels = width * height;
  let water: WaterFigures | null = null;
  let waterProblem: string | null = null;
  const waterReading = reading(WATER_PROMPT);
  if (!publishable) waterProblem = "photo hidden";
  else if (!waterReading.ok) waterProblem = waterReading.problem;
  else {
    const wet = cache.water()!;
    const kept = (region: Uint8Array) => {
      let inside = 0;
      let left = 0;
      for (let i = 0; i < pixels; i++) {
        if (!region[i]) continue;
        inside++;
        if (!blurred[i]) left++;
      }
      return { inside, share: inside === 0 ? null : left / inside };
    };
    const band = wet.band ? kept(wet.band) : null;
    water = { pixels: wet.count, share: wet.count / pixels, unblurredShare: kept(wet.grid).share, band: band ? band.inside : null, bandUnblurredShare: band ? band.share : null };
  }
  return {
    file: photo.file,
    kind: photo.kind,
    publishable,
    failedCalls: failures.map((f) => f.prompt),
    failures,
    plates,
    faces,
    allCovered: bar(false),
    allSureCovered: bar(true),
    unblurredShare: publishable ? 1 - countSet(blurred) / pixels : null,
    water,
    waterProblem,
  };
}

type ScoredPhoto = ReturnType<typeof scorePhoto>;

/**
 * Scores recorded SAM calls for a blur of plates, people and the vehicle phrases in `set`. A photo is publishable only
 * when the plate, person and every set phrase's call succeeded and read strictly. The bar (labelled-identifier
 * coverage, not whole-object coverage): every pixel of each labelled plate under the grown masks of the plate prompt
 * or a set phrase, and of each labelled face under the grown masks of the person prompt or a set phrase; a person
 * mask never covers a plate nor a plate mask a face. With an empty set it is PR #67's per-prompt bar. The union of
 * everything blurred is reported beside it. Evidence figures are given only for a publishable photo.
 */
export function scoreWholeBlur(
  labels: BlurLabels,
  sizes: Record<string, { width: number; height: number }>,
  recorded: Record<string, RecordedCall[]>,
  set: readonly string[],
  read: Reader = strict,
  opts: { bandPrompts?: readonly string[] } = {},
) {
  const bandPrompts = opts.bandPrompts ?? [PERSON_PROMPT, ...VEHICLE_PROMPTS];
  return { photos: photosOf(labels).map((photo) => scorePhoto(photoCache(photo, sizes[photo.file], recorded[photo.file] ?? [], read, bandPrompts), set)) };
}

/** Every subset of `xs`, in binary counting order, so the empty set is first. */
export function subsetsOf<T>(xs: readonly T[]): T[][] {
  return Array.from({ length: 2 ** xs.length }, (_, n) => xs.filter((_, i) => n & (1 << i)));
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Scores every subset of `vehicles` over each draw (draws[i] is one set of recorded calls per photo). A photo meets
 * the bar for a set only when it does in every draw. `closesEveryDraw` names the labels today's blur (the empty set)
 * missed in some draw that the set covers in every draw. Evidence figures come from the first draw, over the photos
 * every set could publish there (a common cohort, so a failed call cannot pass for evidence kept).
 */
export function compareSets(
  labels: BlurLabels,
  sizes: Record<string, { width: number; height: number }>,
  draws: Record<string, RecordedCall[]>[],
  vehicles: readonly string[],
  read: Reader = strict,
  opts: { bandPrompts?: readonly string[] } = {},
) {
  const sets = subsetsOf(vehicles);
  const bandPrompts = opts.bandPrompts ?? [PERSON_PROMPT, ...VEHICLE_PROMPTS];
  // scored[set][draw][photo], built photo by photo so each photo's grids are computed once and then dropped.
  const scored: ScoredPhoto[][][] = sets.map(() => draws.map(() => []));
  draws.forEach((d, di) => {
    for (const photo of photosOf(labels)) {
      const cache = photoCache(photo, sizes[photo.file], d[photo.file] ?? [], read, bandPrompts);
      sets.forEach((set, si) => scored[si][di].push(scorePhoto(cache, set)));
    }
  });
  const idOf = (file: string, kind: "plate" | "face", i: number, where?: string) => `${file} ${kind} ${i}${where ? ` (${where})` : ""}`;
  const labelsOf = (photos: ScoredPhoto[]) =>
    photos.flatMap((p) => [
      ...p.plates.map((x, i) => ({ id: idOf(p.file, "plate", i, x.where), covered: p.publishable && x.assigned === 1, sure: x.sure })),
      ...p.faces.map((x, i) => ({ id: idOf(p.file, "face", i, x.where), covered: p.publishable && x.assigned === 1, sure: x.sure })),
    ]);
  const todayMissed = new Set(scored[0].flatMap((photos) => labelsOf(photos).filter((l) => !l.covered).map((l) => l.id)));
  const cohort = new Set(
    scored[0][0].map((p) => p.file).filter((file) => scored.every((drawsOfSet) => drawsOfSet[0].find((p) => p.file === file)!.publishable)),
  );

  return sets.map((set, s) => {
    const perDraw = scored[s];
    const positives = perDraw.map((photos) => photos.filter((p) => p.kind === "positive"));
    const everyDraw = (f: (p: (typeof positives)[0][0]) => boolean) =>
      positives[0].filter((p) => positives.every((photos) => f(photos.find((q) => q.file === p.file)!))).length;
    const labelRows = perDraw.map((photos) => labelsOf(photos.filter((p) => p.kind === "positive")));
    const coveredEveryDraw = new Set(labelRows[0].filter((l) => labelRows.every((rows) => rows.find((r) => r.id === l.id)!.covered)).map((l) => l.id));
    const tally = (rows: (typeof labelRows)[0], kind: "plate" | "face") => {
      const own = rows.filter((r) => r.id.includes(` ${kind} `));
      return { all: own.length, covered: own.filter((r) => r.covered).length, sure: own.filter((r) => r.sure).length, sureCovered: own.filter((r) => r.sure && r.covered).length };
    };
    const first = perDraw[0].filter((p) => cohort.has(p.file));
    const wet = first.filter((p) => p.water && p.water.share >= 0.01);
    return {
      set,
      extraImagesPerReport: set.filter((p) => !ALREADY_CALLED.has(p)).length,
      photosMeetingBar: positives.map((photos) => photos.filter((p) => p.allCovered).length),
      photosMeetingBarEveryDraw: everyDraw((p) => p.allCovered),
      photosMeetingSureBar: positives.map((photos) => photos.filter((p) => p.allSureCovered).length),
      photosMeetingSureBarEveryDraw: everyDraw((p) => p.allSureCovered),
      unpublishable: perDraw.map((photos) => photos.filter((p) => !p.publishable).map((p) => ({ file: p.file, failures: p.failures }))),
      plates: labelRows.map((rows) => tally(rows, "plate")),
      faces: labelRows.map((rows) => tally(rows, "face")),
      closesEveryDraw: [...todayMissed].filter((id) => coveredEveryDraw.has(id)),
      stillMissedSomeDraw: labelRows[0].filter((l) => !coveredEveryDraw.has(l.id)).map((l) => ({ id: l.id, sure: l.sure })),
      evidence: {
        cohort: first.length,
        medianUnblurredShare: median(first.map((p) => p.unblurredShare!)),
        minUnblurredShare: first.length ? Math.min(...first.map((p) => p.unblurredShare!)) : null,
        wetPhotos: wet.length,
        medianWaterUnblurred: median(wet.map((p) => p.water!.unblurredShare!)),
        bandPhotos: wet.filter((p) => p.water!.band).length,
        medianBandUnblurred: median(wet.filter((p) => p.water!.band).map((p) => p.water!.bandUnblurredShare!)),
      },
    };
  });
}

export interface AllowanceState {
  cap: number;
  /** Images that may have been billed: settled calls at their upper bound, open calls at a full reservation. */
  upperBoundImages: number;
  calls: number;
  open: number;
  refused: number;
}

/** What one SAM call may have billed: its metered image when clean, else every attempt lib/meta.ts can make. */
export function billedUpperBound(outcome: { threw: boolean; metered: number; complete: boolean }): number {
  return outcome.threw || !outcome.complete ? ATTEMPTS_PER_CALL : Math.min(ATTEMPTS_PER_CALL, Math.max(1, outcome.metered));
}

/**
 * A spending allowance kept on disk so it holds across draws and restarts: each call reserves every attempt before it
 * runs and settles to billedUpperBound after; a crash leaves the full reservation counted.
 */
export class ImageAllowance {
  constructor(
    private readonly path: string,
    private readonly cap: number,
  ) {
    if (existsSync(path)) {
      const saved = this.state();
      if (saved.cap !== cap) throw new Error(`allowance file has cap ${saved.cap}, not ${cap}`);
    } else this.write({ cap, upperBoundImages: 0, calls: 0, open: 0, refused: 0 });
  }

  state(): AllowanceState {
    return JSON.parse(readFileSync(this.path, "utf8")) as AllowanceState;
  }

  private write(s: AllowanceState) {
    writeFileSync(this.path, JSON.stringify(s));
  }

  admit(): boolean {
    const s = this.state();
    if (s.upperBoundImages + ATTEMPTS_PER_CALL > this.cap) {
      this.write({ ...s, refused: s.refused + 1 });
      return false;
    }
    this.write({ ...s, upperBoundImages: s.upperBoundImages + ATTEMPTS_PER_CALL, calls: s.calls + 1, open: s.open + 1 });
    return true;
  }

  settle(outcome: { threw: boolean; metered: number; complete: boolean }) {
    const s = this.state();
    this.write({ ...s, upperBoundImages: s.upperBoundImages - ATTEMPTS_PER_CALL + billedUpperBound(outcome), open: s.open - 1 });
  }
}
