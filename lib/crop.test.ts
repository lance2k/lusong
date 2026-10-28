import { describe, expect, it } from "vitest";
import { cropBox } from "./crop";

const PHOTO = { width: 1280, height: 960 };
const inside = (c: { x: number; y: number; width: number; height: number }, image = PHOTO) =>
  c.x >= 0 && c.y >= 0 && c.x + c.width <= image.width && c.y + c.height <= image.height;
const contains = (c: { x: number; y: number; width: number; height: number }, b: { left: number; top: number; right: number; bottom: number }) =>
  c.x <= b.left && c.y <= b.top && c.x + c.width >= b.right && c.y + c.height >= b.bottom;

describe("cropBox", () => {
  it("pads a wader's box and keeps the crop no taller than 4:3", () => {
    const wader = { left: 600, top: 400, right: 640, bottom: 520 };
    const crop = cropBox(wader, PHOTO);
    expect(contains(crop, wader)).toBe(true);
    expect(inside(crop)).toBe(true);
    expect(crop.height).toBeGreaterThanOrEqual(120 + 2 * 0.4 * 120);
    expect(crop.width / crop.height).toBeGreaterThanOrEqual(0.75);
  });

  it("grows a tiny box to the minimum side", () => {
    const crop = cropBox({ left: 100, top: 100, right: 110, bottom: 112 }, PHOTO);
    expect(Math.min(crop.width, crop.height)).toBeGreaterThanOrEqual(96);
  });

  it("shifts a crop at the photo's corner back inside it", () => {
    const corner = { left: 1250, top: 900, right: 1280, bottom: 960 };
    const crop = cropBox(corner, PHOTO);
    expect(inside(crop)).toBe(true);
    expect(contains(crop, corner)).toBe(true);
  });

  it("keeps a wide car crop no wider than 4:3", () => {
    const car = { left: 0, top: 500, right: 400, bottom: 640 };
    const crop = cropBox(car, PHOTO);
    expect(crop.height / crop.width).toBeGreaterThanOrEqual(0.75);
    expect(inside(crop)).toBe(true);
  });

  it("never asks for more than the photo", () => {
    const small = { width: 80, height: 60 };
    expect(cropBox({ left: 10, top: 10, right: 70, bottom: 50 }, small)).toEqual({ x: 0, y: 0, width: 80, height: 60 });
  });
});
