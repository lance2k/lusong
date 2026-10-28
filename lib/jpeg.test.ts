import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JpegError, sanitizeJpeg } from "./jpeg";

const baseline = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));
const progressive = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1-progressive.jpg"));

function segment(marker: number, payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const length = body.length + 2;
  return new Uint8Array([0xff, marker, length >> 8, length & 0xff, ...body]);
}

function splice(bytes: Uint8Array, at: number, insert: Uint8Array): Uint8Array {
  return new Uint8Array([...bytes.subarray(0, at), ...insert, ...bytes.subarray(at)]);
}

function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

function markerPositions(bytes: Uint8Array, marker: number): number[] {
  const found: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === marker) found.push(i);
  return found;
}

const hasPil = spawnSync("python3", ["-I", "-c", "import PIL"]).status === 0;

/** Decodes with Pillow, the strongest independent check available here that the bytes are still an image. */
function decodedSize(bytes: Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "lusong-jpeg-")), "image.jpg");
  writeFileSync(path, bytes);
  const run = spawnSync("python3", ["-I", "-c", "import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.load(); print(*im.size)", path], {
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

describe("sanitizeJpeg", () => {
  it("reads the frame size of a real photo", () => {
    expect(sanitizeJpeg(baseline)).toMatchObject({ width: 1280, height: 960 });
  });

  it("removes EXIF/GPS and a comment before the first scan", () => {
    const tagged = splice(baseline, 2, new Uint8Array([...segment(0xe1, "Exif\0\0GPSLatitude=14.5995"), ...segment(0xfe, "taken at home")]));
    const clean = sanitizeJpeg(tagged).bytes;
    expect(contains(clean, "GPSLatitude")).toBe(false);
    expect(contains(clean, "taken at home")).toBe(false);
    expect(Buffer.from(clean.subarray(-2)).toString("hex")).toBe("ffd9");
  });

  it.skipIf(!hasPil)("removes metadata between scans, before EOI and after EOI in a progressive JPEG", () => {
    const secondScan = markerPositions(progressive, 0xda)[1];
    let tagged = splice(progressive, secondScan, segment(0xe1, "Exif\0\0GPSLatitude=14.5995"));
    const eoi = tagged.length - 2;
    tagged = splice(tagged, eoi, segment(0xfe, "taken at home"));
    tagged = new Uint8Array([...tagged, ...new TextEncoder().encode("Exif GPSLongitude=120.9842")]);
    expect(markerPositions(tagged, 0xda).length).toBe(10);

    const clean = sanitizeJpeg(tagged);
    expect(contains(clean.bytes, "GPSLatitude")).toBe(false);
    expect(contains(clean.bytes, "taken at home")).toBe(false);
    expect(contains(clean.bytes, "GPSLongitude")).toBe(false);
    expect(Buffer.from(clean.bytes).equals(Buffer.from(progressive))).toBe(true);
    expect(decodedSize(clean.bytes)).toBe("1280 960");
  });

  it.skipIf(!hasPil)("leaves a clean baseline photo decodable", () => {
    expect(decodedSize(sanitizeJpeg(baseline).bytes)).toBe("1280 960");
  });

  it("rejects bytes that are not a JPEG", () => {
    expect(() => sanitizeJpeg(new TextEncoder().encode("GIF89a........"))).toThrow(JpegError);
  });

  it("rejects a file cut off just after its frame header", () => {
    const sof = markerPositions(baseline, 0xc0)[0];
    expect(() => sanitizeJpeg(baseline.subarray(0, sof + 12))).toThrow(JpegError);
  });

  it("rejects a frame header too short to hold a size", () => {
    const tiny = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00, 0xff, 0xd9]);
    expect(() => sanitizeJpeg(tiny)).toThrow(JpegError);
  });

  it("rejects a zero-sized frame", () => {
    const zero = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff, 0xd9]);
    expect(() => sanitizeJpeg(zero)).toThrow(JpegError);
  });

  it("rejects a file with no end-of-image marker", () => {
    expect(() => sanitizeJpeg(baseline.subarray(0, baseline.length - 2))).toThrow(JpegError);
  });
});
