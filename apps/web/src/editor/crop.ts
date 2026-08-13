import type { NormalizedRect } from "@figlab/figure-schema";

import type { Point } from "./session-store";

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const rounded = (value: number): number => Number(value.toFixed(6));

export function cropFromPointer(
  start: Point,
  end: Point,
  sourceSize: { width: number; height: number },
): NormalizedRect {
  const startX = clamp(start.x / sourceSize.width);
  const startY = clamp(start.y / sourceSize.height);
  const endX = clamp(end.x / sourceSize.width);
  const endY = clamp(end.y / sourceSize.height);
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  return {
    x: rounded(x),
    y: rounded(y),
    width: rounded(Math.abs(endX - startX)),
    height: rounded(Math.abs(endY - startY)),
  };
}
