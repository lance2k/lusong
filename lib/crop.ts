import type { Box } from "./sam";

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * The part of the photo to zoom into for one measured object: its box padded on every side, at least
 * `minSide` source pixels, no more stretched than `maxAspect` either way, moved (not cut) to stay
 * inside the photo.
 */
export function cropBox(
  box: Box,
  image: { width: number; height: number },
  { padShare = 0.4, minSide = 96, maxAspect = 4 / 3 } = {},
): ViewBox {
  const boxWidth = box.right - box.left;
  const boxHeight = box.bottom - box.top;
  const pad = padShare * Math.max(boxWidth, boxHeight);
  let width = Math.max(boxWidth + 2 * pad, minSide);
  let height = Math.max(boxHeight + 2 * pad, minSide);
  width = Math.min(Math.max(width, height / maxAspect), image.width);
  height = Math.min(Math.max(height, width / maxAspect), image.height);
  return {
    x: clamp((box.left + box.right) / 2 - width / 2, 0, image.width - width),
    y: clamp((box.top + box.bottom) / 2 - height / 2, 0, image.height - height),
    width,
    height,
  };
}
