import type { ImageViewObjectV1, NormalizedRect } from "@figlab/figure-schema";

import type { ArtboardScreenTransform, ScreenRect } from "../editor/geometry";
import type { Point } from "../editor/session-store";

export function rectFromPoints(start: Point, end: Point): NormalizedRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    width: Number(Math.abs(end.x - start.x).toFixed(6)),
    height: Number(Math.abs(end.y - start.y).toFixed(6)),
  };
}
export function viewportStyle(viewport: NormalizedRect, imageRect?: ScreenRect) {
  if (!imageRect) return { display: "none" };
  return {
    left: imageRect.left + viewport.x * imageRect.width,
    top: imageRect.top + viewport.y * imageRect.height,
    width: viewport.width * imageRect.width,
    height: viewport.height * imageRect.height,
  };
}
export function transformStyle(
  transform: ImageViewObjectV1["transform"],
  screen?: ArtboardScreenTransform,
) {
  if (!screen) return { display: "none" };
  return {
    left: screen.leftPx + transform.xPt * screen.scale,
    top: screen.topPx + transform.yPt * screen.scale,
    width: transform.widthPt * screen.scale,
    height: transform.heightPt * screen.scale,
  };
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
