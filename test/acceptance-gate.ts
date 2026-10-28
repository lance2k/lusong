import type { Verdict } from "../lib/verdict";

export type Depth = "ankle" | "half_knee" | "knee" | "thigh" | "waist" | "chest";

export interface AcceptancePhoto {
  file: string;
  source: string;
  licence: string;
  author: string;
  caption: string;
  /** The depth word the photo's own caption states, or null when it states none. */
  captionDepth: Depth | null;
  /** People and cars standing in the water, counted by a person looking at the photo. */
  refs: number;
  expect: "not_patv" | "cannot_measure" | "any";
  /** Why the labels are what they are, for the person checking them. */
  note?: string;
}

export interface AcceptanceDraw {
  file: string;
  draw: number;
  verdict: Verdict;
}

const DEEP: readonly Depth[] = ["knee", "thigh", "waist", "chest"];
const OPEN_LICENCE = /^(CC0( 1\.0)?|CC BY(-SA)? \d\.\d( [a-z]{2})?|Public domain)$/i;
export const DRAWS_PER_PHOTO = 2;
const MIN_DEEP = 6;
const MIN_DEEP_WITH_SEVERAL_REFS = 3;
const MIN_NO_REFERENCE = 2;

function manifestProblems(photos: readonly AcceptancePhoto[]): string[] {
  const problems: string[] = [];
  const deep = photos.filter((p) => p.captionDepth && DEEP.includes(p.captionDepth) && p.refs > 0);
  const severalRefs = deep.filter((p) => p.refs >= 2);
  const noReference = photos.filter((p) => p.refs === 0);
  if (deep.length < MIN_DEEP) problems.push(`${MIN_DEEP} photos captioned knee deep or deeper needed, ${deep.length} found`);
  if (severalRefs.length < MIN_DEEP_WITH_SEVERAL_REFS) {
    problems.push(`${MIN_DEEP_WITH_SEVERAL_REFS} deep photos with 2 or more people or cars needed, ${severalRefs.length} found`);
  }
  if (noReference.length < MIN_NO_REFERENCE) {
    problems.push(`${MIN_NO_REFERENCE} photos with no person or car needed, ${noReference.length} found`);
  }
  const files = photos.map((p) => p.file);
  for (const file of new Set(files.filter((f, i) => files.indexOf(f) !== i))) problems.push(`${file}: listed twice`);
  for (const p of photos) {
    if (!OPEN_LICENCE.test(p.licence)) problems.push(`${p.file}: licence ${p.licence}`);
    if (p.refs === 0 && p.expect !== "cannot_measure") problems.push(`${p.file}: no reference but expects ${p.expect}`);
    if (deep.includes(p) && p.expect !== "not_patv") problems.push(`${p.file}: captioned ${p.captionDepth} deep but expects ${p.expect}`);
  }
  return problems;
}

function drawFailure(photo: AcceptancePhoto, d: AcceptanceDraw): string | null {
  const v = d.verdict;
  if (photo.expect === "cannot_measure") {
    return v.kind === "cannot_measure" ? null : `${photo.file} draw ${d.draw}: ${v.kind}, expected cannot_measure`;
  }
  if (photo.expect === "not_patv") {
    if (v.kind === "no_flood") return `${photo.file} draw ${d.draw}: no_flood on a photo captioned ${photo.captionDepth} deep`;
    if (v.kind === "measured" && v.passability === "PATV") {
      return `${photo.file} draw ${d.draw}: PATV on a photo captioned ${photo.captionDepth} deep`;
    }
  }
  return null;
}

/**
 * Blocker 3's release gate: a screen for false PATV and for measurements made with nothing to measure
 * against. It is not an accuracy measure. The manifest is checked first, so a set missing a required
 * case cannot pass by having nothing to fail on.
 */
export function judgeAcceptance(
  photos: readonly AcceptancePhoto[],
  draws: readonly AcceptanceDraw[],
): { pass: boolean; problems: string[]; failures: string[] } {
  const problems = manifestProblems(photos);
  const failures: string[] = [];
  for (const photo of photos) {
    const mine = draws.filter((d) => d.file === photo.file);
    const distinctDraws = new Set(mine.map((d) => d.draw)).size;
    if (distinctDraws < DRAWS_PER_PHOTO) failures.push(`${photo.file}: ${distinctDraws} of ${DRAWS_PER_PHOTO} draws`);
    for (const d of mine) {
      const failure = drawFailure(photo, d);
      if (failure) failures.push(failure);
    }
  }
  return { pass: problems.length === 0 && failures.length === 0, problems, failures };
}
