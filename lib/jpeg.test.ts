import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JpegError, jpegSize, stripJpegMetadata } from "./jpeg";

const photo = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));

function segment(marker: number, payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const length = body.length + 2;
  return new Uint8Array([0xff, marker, length >> 8, length & 0xff, ...body]);
}

function withSegmentsAfterSoi(bytes: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  const parts = [bytes.subarray(0, 2), ...segments, bytes.subarray(2)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

describe("jpegSize", () => {
  it("reads the frame size of a real photo", () => {
    expect(jpegSize(photo)).toEqual({ width: 1280, height: 960 });
  });

  it("rejects bytes that are not a JPEG", () => {
    expect(() => jpegSize(new TextEncoder().encode("GIF89a........"))).toThrow(JpegError);
    expect(() => jpegSize(photo.subarray(0, 20))).toThrow(JpegError);
  });
});

describe("stripJpegMetadata", () => {
  it("removes an EXIF/GPS segment and a comment, keeping the image intact", () => {
    const tagged = withSegmentsAfterSoi(
      photo,
      segment(0xe1, "Exif\0\0GPSLatitude=14.5995"),
      segment(0xfe, "taken at home"),
    );
    expect(contains(tagged, "GPSLatitude")).toBe(true);

    const clean = stripJpegMetadata(tagged);
    expect(contains(clean, "GPSLatitude")).toBe(false);
    expect(contains(clean, "taken at home")).toBe(false);
    expect(contains(clean, "Exif")).toBe(false);
    expect(jpegSize(clean)).toEqual({ width: 1280, height: 960 });
    expect(Buffer.from(clean.subarray(-2)).toString("hex")).toBe("ffd9");
  });

  it("keeps the JFIF header and the compressed image data byte for byte", () => {
    const clean = stripJpegMetadata(photo);
    const sos = Buffer.from(photo).indexOf(Buffer.from([0xff, 0xda]));
    const cleanSos = Buffer.from(clean).indexOf(Buffer.from([0xff, 0xda]));
    expect(Buffer.from(clean.subarray(cleanSos)).equals(Buffer.from(photo.subarray(sos)))).toBe(true);
  });
});
