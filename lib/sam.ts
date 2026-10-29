import {
  decodeMaskToRaster,
  formats,
  recordsOfKind,
  type SegmentationBoxRecord,
  type SegmentationMaskRecord,
} from "@meta-sam/parser";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SamObject {
  id: string;
  box: Box;
  mask: SegmentationMaskRecord;
}

/** A decoded mask placed in source-image pixels. */
export interface PlacedRaster {
  raster: Uint8Array;
  width: number;
  height: number;
  bounds: Box;
  /** Source pixels per raster pixel; 1 for small masks, larger when SAM downscaled the mask. */
  scaleX: number;
  scaleY: number;
}

interface ResponsesBody {
  status?: unknown;
  output?: { status?: unknown; content?: { type?: string; text?: string }[] | null }[];
}

/** One SAM reply as Meta sent it: the output text and the Responses API's own status for the response. */
export interface SamReply {
  text: string;
  /**
   * "completed" only when the response and every output item say so and the envelope holds nothing but output_text
   * strings; "malformed" when the envelope does not have that shape; null when the body carries no status.
   */
  status: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A completed envelope can still hide objects: a refusal, an output_text with no string text, or no output at all
 * would read as empty text, which is a real zero-match answer. Only explicit output_text strings count.
 */
function envelopeProblem(output: unknown): string | null {
  if (!Array.isArray(output) || output.length === 0) return "malformed";
  for (const item of output) {
    if (!isRecord(item)) return "malformed";
    if (item.status !== "completed") return typeof item.status === "string" ? item.status : "malformed";
    if (!Array.isArray(item.content) || item.content.length === 0) return "malformed";
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return "malformed";
    }
  }
  return null;
}

export function samReplyOf(body: unknown): SamReply {
  if (!isRecord(body)) return { text: "", status: "malformed" };
  const text = Array.isArray(body.output) ? outputTextOf(body as ResponsesBody) : "";
  const top = typeof body.status === "string" ? body.status : null;
  if (top !== "completed") return { text, status: top };
  return { text, status: envelopeProblem(body.output) ?? "completed" };
}

export function outputTextOf(body: ResponsesBody): string {
  let text = "";
  for (const item of body.output ?? []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

/** Parses one non-streamed SAM 3.1 image reply. Empty text is a valid zero-match result. */
export function parseSamText(text: string): SamObject[] {
  const parser = formats.segmentation.image().createParser();
  parser.push(text);
  const { result } = parser.finish({ status: "completed" });
  const boxes = new Map<string, SegmentationBoxRecord>();
  for (const box of recordsOfKind(result.records, "box")) boxes.set(box.objectId, box);
  return recordsOfKind(result.records, "mask").flatMap((mask) => {
    const box = boxes.get(mask.objectId);
    if (!box) return [];
    return [{ id: mask.objectId, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, mask }];
  });
}

export function placeRaster(mask: SegmentationMaskRecord): PlacedRaster {
  const { width, height } = mask.mask;
  const bounds = { ...mask.bounds };
  return {
    raster: decodeMaskToRaster(mask.mask),
    width,
    height,
    bounds,
    scaleX: (bounds.right - bounds.left) / width,
    scaleY: (bounds.bottom - bounds.top) / height,
  };
}

export type StrictReading =
  | { ok: true; objects: (SamObject & { placed: PlacedRaster })[] }
  | { ok: false; problem: "not_completed" | "unterminated" | "parse_error" | "stray_text" | "unpaired" | "empty_mask" };

/**
 * Reads a SAM reply only when nothing in it can hide an object: Meta says the response completed, the text ends on
 * a line break (every recorded non-empty reply does, and a reply cut between two objects parses with no error but
 * no final break), no parse error or stray text line, every box paired with exactly one mask, and every mask with at
 * least one pixel set (an empty mask blurs nothing, so its object would stay visible). Empty text from a completed
 * response is zero objects.
 */
export function readSamReplyStrict(reply: SamReply): StrictReading {
  const fail = (problem: Extract<StrictReading, { ok: false }>["problem"]): StrictReading => ({ ok: false, problem });
  if (reply.status !== "completed") return fail("not_completed");
  if (reply.text === "") return { ok: true, objects: [] };
  if (!reply.text.endsWith("\n")) return fail("unterminated");
  let result;
  try {
    const parser = formats.segmentation.image().createParser();
    parser.push(reply.text);
    result = parser.finish({ status: "completed" }).result;
  } catch {
    return fail("parse_error");
  }
  if (result.diagnostics.some((d) => d.severity === "error")) return fail("parse_error");
  if (recordsOfKind(result.records, "text").length > 0) return fail("stray_text");
  const boxes = recordsOfKind(result.records, "box");
  const masks = recordsOfKind(result.records, "mask");
  const boxOf = new Map(boxes.map((b) => [b.objectId, b]));
  if (boxes.length !== masks.length || boxOf.size !== boxes.length || masks.some((m) => !boxOf.has(m.objectId))) return fail("unpaired");
  const objects = [];
  for (const mask of masks) {
    let placed: PlacedRaster;
    try {
      placed = placeRaster(mask);
    } catch {
      return fail("parse_error");
    }
    if (!placed.raster.includes(1)) return fail("empty_mask");
    const box = boxOf.get(mask.objectId)!;
    objects.push({ id: mask.objectId, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, mask, placed });
  }
  return { ok: true, objects };
}
