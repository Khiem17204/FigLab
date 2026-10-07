import {
  type BoxTransform,
  proportionallyResizeTransform,
  type ResizeAnchor,
} from "@figlab/editor-core";

import type { Point } from "./session-store";

export type ScreenRect = { left: number; top: number; width: number; height: number };

export type ArtboardScreenTransform = {
  scale: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  screenDeltaToPoints: (delta: Point) => Point;
};

export function artboardScreenTransform(
  containerWidthPx: number,
  containerHeightPx: number,
  artboardWidthPt: number,
  artboardHeightPt: number,
): ArtboardScreenTransform {
  const scale = Math.min(containerWidthPx / artboardWidthPt, containerHeightPx / artboardHeightPt);
  const widthPx = artboardWidthPt * scale;
  const heightPx = artboardHeightPt * scale;
  return {
    scale,
    leftPx: (containerWidthPx - widthPx) / 2,
    topPx: (containerHeightPx - heightPx) / 2,
    widthPx,
    heightPx,
    screenDeltaToPoints: (delta) => ({ x: delta.x / scale, y: delta.y / scale }),
  };
}

export function imageContainRect(
  container: { width: number; height: number },
  image: { width: number; height: number },
): ScreenRect {
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

export function normalizedPointInImage(point: Point, imageRect: ScreenRect): Point {
  return {
    x: clampUnit((point.x - imageRect.left) / imageRect.width),
    y: clampUnit((point.y - imageRect.top) / imageRect.height),
  };
}

export function resizeFromDraggedCorner<T extends BoxTransform>(
  transform: T,
  draggedCorner: ResizeAnchor,
  deltaPt: Point,
): T {
  const growsRight = draggedCorner.endsWith("right");
  const widthPt = Math.max(1, transform.widthPt + deltaPt.x * (growsRight ? 1 : -1));
  return proportionallyResizeTransform(transform, widthPt, oppositeCorner(draggedCorner));
}

function oppositeCorner(corner: ResizeAnchor): ResizeAnchor {
  const vertical = corner.startsWith("top") ? "bottom" : "top";
  const horizontal = corner.endsWith("left") ? "right" : "left";
  return `${vertical}-${horizontal}` as ResizeAnchor;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));
