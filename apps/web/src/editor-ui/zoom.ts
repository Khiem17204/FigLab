import type { ArtboardScreenTransform } from "../editor/geometry";

/** "fit" tracks the viewport; a number is CSS pixels per artboard point (1 = 72 dpi). */
export type ZoomLevel = "fit" | number;

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const STAGE_PADDING_PX = 28;

export type StageTransform = ArtboardScreenTransform & {
  stageWidthPx: number;
  stageHeightPx: number;
};

export function fitScale(
  viewportWidthPx: number,
  viewportHeightPx: number,
  artboardWidthPt: number,
  artboardHeightPt: number,
  paddingPx = STAGE_PADDING_PX,
): number {
  const width = Math.max(1, viewportWidthPx - paddingPx * 2);
  const height = Math.max(1, viewportHeightPx - paddingPx * 2);
  return Math.max(0.01, Math.min(width / artboardWidthPt, height / artboardHeightPt));
}

/**
 * Places the artboard on a stage at least as large as the viewport. When zoomed past the
 * viewport the stage grows, and the viewport scrolls over it; the transform has the same
 * shape as `artboardScreenTransform`, so pointer deltas still convert to points exactly.
 */
export function stageTransform(
  viewportWidthPx: number,
  viewportHeightPx: number,
  artboardWidthPt: number,
  artboardHeightPt: number,
  zoom: ZoomLevel,
  paddingPx = STAGE_PADDING_PX,
): StageTransform {
  const scale =
    zoom === "fit"
      ? fitScale(viewportWidthPx, viewportHeightPx, artboardWidthPt, artboardHeightPt, paddingPx)
      : zoom;
  const widthPx = artboardWidthPt * scale;
  const heightPx = artboardHeightPt * scale;
  const stageWidthPx = Math.max(viewportWidthPx, Math.ceil(widthPx + paddingPx * 2));
  const stageHeightPx = Math.max(viewportHeightPx, Math.ceil(heightPx + paddingPx * 2));
  return {
    scale,
    leftPx: (stageWidthPx - widthPx) / 2,
    topPx: (stageHeightPx - heightPx) / 2,
    widthPx,
    heightPx,
    stageWidthPx,
    stageHeightPx,
    screenDeltaToPoints: (delta) => ({ x: delta.x / scale, y: delta.y / scale }),
  };
}

/** The next preset zoom above (direction 1) or below (-1) the current scale. */
export function stepZoom(currentScale: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction > 0)
    return ZOOM_STEPS.find((step) => step > currentScale + epsilon) ?? ZOOM_STEPS.at(-1) ?? 4;
  return [...ZOOM_STEPS].reverse().find((step) => step < currentScale - epsilon) ?? ZOOM_STEPS[0];
}

export function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
