import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCaptureTime, readExifTimeText, withExifTime } from "./exif";
import { sanitizeJpeg } from "./jpeg";

const withExif = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1-exif.jpg"));
const withoutExif = new Uint8Array(readFileSync("test/fixtures/photos/quiapo-1.jpg"));

describe("the photo's capture time", () => {
  it("is read from a real phone photo's EXIF DateTimeOriginal, as Philippine time", () => {
    // Commons lists DateTimeOriginal 2024:07:24 17:25:53 for this realme GT 6 photo, taken in Manila.
    expect(readCaptureTime(withExif)?.toISOString()).toBe("2024-07-24T09:25:53.000Z");
  });

  it("is null for a photo with no EXIF", () => {
    expect(readCaptureTime(withoutExif)).toBeNull();
  });
});

describe("carrying the capture time past the page's canvas", () => {
  it("a re-encoded photo given the original's time reads back the same capture time and nothing else", () => {
    const text = readExifTimeText(withExif);
    expect(text).toBe("2024:07:24 17:25:53");
    const carried = withExifTime(withoutExif, text!);
    expect(readCaptureTime(carried)?.toISOString()).toBe("2024-07-24T09:25:53.000Z");
    expect(carried.length - withoutExif.length).toBeLessThan(80);
    expect(Buffer.from(carried).includes("realme")).toBe(false);
  });

  it("the stripped photo is the same bytes whatever time it carried, so a resend is recognised", () => {
    const a = sanitizeJpeg(withExifTime(withoutExif, "2026:10:30 07:00:00")).bytes;
    const b = sanitizeJpeg(withExifTime(withoutExif, "2026:10:30 09:59:00")).bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(sanitizeJpeg(withoutExif).bytes))).toBe(true);
  });

  it("a time that is not an EXIF date and time is refused", () => {
    expect(() => withExifTime(withoutExif, "2026-10-30T07:00:00Z")).toThrow();
  });
});

describe("capture times that are not real", () => {
  it.each(["2024:02:30 10:00:00", "2024:13:01 10:00:00", "2024:07:24 25:00:00", "    :  :     :  :  "])("%s is no capture time", (text) => {
    expect(readCaptureTime(withExifTime(withoutExif, text, { unchecked: true }))).toBeNull();
  });
});
