import { formats, recordsOfKind } from "@meta-sam/parser";
import type { BlobStore } from "./blob-store";
import { blurMasked } from "./blur";
import { placeRaster, type PlacedRaster } from "./sam";

/**
 * Whether SAM 3.1's plate masks can be relied on to find every plate. Until the plate probe
 * (test/probe-sam-plates.test.ts) shows they can, no report photo is shown to anyone: the report keeps its pin and
 * reading only.
 */
export const PLATE_DETECTION_TRUSTED = false;

/** One SAM call's result: its raw segmentation text, or a failure (error, timeout, budget). */
export type SamCall = { ok: true; text: string } | { ok: false };

export type HiddenReason =
  | "plate_detection_untrusted"
  | "no_store"
  | "person_segmentation_failed"
  | "plate_segmentation_failed"
  | "unreadable_masks"
  | "blur_failed"
  | "store_failed";

export type PhotoOutcome = { published: true; url: string } | { published: false; reason: HiddenReason };

export interface PhotoInput {
  /** The photo SAM read, in the same pixel grid as its masks. */
  jpeg: Uint8Array;
  /** The `person` prompt's reply: every mask in it, not the depth reader's selection. */
  persons: SamCall;
  /** The plate prompt's reply. */
  plates: SamCall;
  store: BlobStore | null;
  blur?: (jpeg: Uint8Array, masks: readonly PlacedRaster[]) => Promise<Uint8Array>;
  plateDetectionTrusted?: boolean;
  signal?: AbortSignal;
}

/**
 * Every mask in a SAM reply, or null when the reply can't be trusted to hold them all: a parse error (a cut-off
 * reply parses as fewer masks, with no other sign) or a box with no mask, an object found that can't be blurred.
 */
function allMasks(text: string): PlacedRaster[] | null {
  try {
    const parser = formats.segmentation.image().createParser();
    parser.push(text);
    const { result } = parser.finish({ status: "completed" });
    if (result.diagnostics.some((d) => d.severity === "error")) return null;
    const masks = recordsOfKind(result.records, "mask");
    const masked = new Set(masks.map((m) => m.objectId));
    if (recordsOfKind(result.records, "box").some((box) => !masked.has(box.objectId))) return null;
    return masks.map(placeRaster);
  } catch {
    return null;
  }
}

/**
 * Publishes a report photo only when both SAM calls succeeded and parsed in full, the blur succeeded and the store
 * accepted the blurred JPEG; anything else shows no photo, and the report keeps its pin and reading. Only the
 * blurred bytes ever reach the store. Never throws.
 */
export async function publishPhoto(input: PhotoInput): Promise<PhotoOutcome> {
  const hidden = (reason: HiddenReason): PhotoOutcome => ({ published: false, reason });
  if (!(input.plateDetectionTrusted ?? PLATE_DETECTION_TRUSTED)) return hidden("plate_detection_untrusted");
  if (!input.store) return hidden("no_store");
  if (!input.persons.ok) return hidden("person_segmentation_failed");
  if (!input.plates.ok) return hidden("plate_segmentation_failed");
  const persons = allMasks(input.persons.text);
  const plates = allMasks(input.plates.text);
  if (!persons || !plates) return hidden("unreadable_masks");

  let blurred: Uint8Array;
  try {
    blurred = await (input.blur ?? blurMasked)(input.jpeg, [...persons, ...plates]);
  } catch {
    return hidden("blur_failed");
  }
  try {
    return { published: true, url: await input.store.put(blurred, input.signal) };
  } catch {
    return hidden("store_failed");
  }
}
