import type { Point } from "../lib/answer";

export interface PageReport {
  id: string;
  sample: boolean;
  place: string;
  at: Point;
  age: string;
  depth: string | null;
  passability: string | null;
  /** Samples only: where the photo was really taken, its credit and its source. */
  origin: string | null;
  credit: string | null;
  sourceUrl: string | null;
  /** The blurred copy of a real report's photo, when one was published; never the original. */
  photoUrl: string | null;
  counts: boolean;
  onRoute: boolean;
  onDetour: boolean;
  role: "clear" | "block" | "neutral";
}

/** What a shown report photo says to a screen reader; the map's pins use it too. */
export const PHOTO_ALT = "The reporter's photo, with people and number plates blurred";

const ROLE_WORDS: Record<PageReport["role"], string> = {
  block: "Marks the spot not passable",
  neutral: "Neither clears nor blocks the spot",
  clear: "Shows the spot clear",
};

/** One report in a commute check's evidence list. */
export function ReportEvidence({ r }: { r: PageReport }) {
  const where = r.onRoute ? "" : r.onDetour ? "On the other way. " : null;
  const status = !r.counts ? "Older than 3 hours: shown, not counted." : where === null ? "Not on your route." : where + ROLE_WORDS[r.role] + ".";
  return (
    <li className="space-y-1 px-4 py-3">
      <p className="flex flex-wrap items-center gap-2">
        {r.sample && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-semibold uppercase dark:bg-zinc-700">Sample</span>}
        <span className="font-medium">{r.place}</span>
        <span className="text-zinc-500">{r.age}</span>
      </p>
      {r.photoUrl && (
        // A blob-store URL of unknown size: next/image would need the store's host configured before it exists.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.photoUrl} alt={PHOTO_ALT} loading="lazy" referrerPolicy="no-referrer" className="max-h-64 w-full rounded-lg object-cover" />
      )}
      {r.depth && <p>Water {r.depth}.</p>}
      {r.passability && <p>{r.passability}.</p>}
      <p className="text-zinc-600 dark:text-zinc-400">{status}</p>
      {r.sample && (
        <p className="text-sm text-zinc-500">
          Sample, not a report from this street. Where the photo was really taken: {r.origin}. {r.credit}.{" "}
          <a className="text-sky-700 underline dark:text-sky-400" href={r.sourceUrl ?? undefined}>
            See the photo
          </a>
        </p>
      )}
    </li>
  );
}
