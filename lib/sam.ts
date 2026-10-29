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
  /** "completed" only when the response and every output item say so; null when the body carries no status. */
  status: string | null;
}

export function samReplyOf(body: ResponsesBody): SamReply {
  const top = typeof body.status === "string" ? body.status : null;
  const unfinishedItem = (body.output ?? []).map((item) => item.status).find((s) => s !== undefined && s !== "completed");
  const status = top === "completed" && unfinishedItem !== undefined ? (typeof unfinishedItem === "string" ? unfinishedItem : null) : top;
  return { text: outputTextOf(body), status };
}

export function outputTextOf(body: ResponsesBody): string {
  let text = "";
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text") text += part.text ?? "";
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
  | { ok: false; problem: "not_completed" | "unterminated" | "parse_error" | "stray_text" | "unpaired" };

/**
 * Reads a SAM reply only when nothing in it can hide an object: Meta says the response completed, the text ends on
 * a line break (every recorded non-empty reply does, and a reply cut between two objects parses with no error but
 * no final break), no parse error or stray text line, and every box paired with exactly one mask. Empty text from a
 * completed response is zero objects.
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
    const box = boxOf.get(mask.objectId)!;
    objects.push({ id: mask.objectId, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, mask, placed });
  }
  return { ok: true, objects };
}
