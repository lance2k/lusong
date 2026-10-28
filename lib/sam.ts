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
  output?: { content?: { type?: string; text?: string }[] | null }[];
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
