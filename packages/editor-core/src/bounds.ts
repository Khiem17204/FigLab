import type { ArtboardV1, FigureObject } from "@figlab/figure-schema";

/** Axis-aligned rectangle in artboard points. */
export type Bounds = { left: number; top: number; right: number; bottom: number };

/** The axis-aligned bounds of an object, including the corners of a rotated box. */
export function objectBounds(object: FigureObject): Bounds {
  const { xPt, yPt, widthPt, heightPt, rotationDeg } = object.transform;
  if (rotationDeg === 0)
    return { left: xPt, top: yPt, right: xPt + widthPt, bottom: yPt + heightPt };
  const centerX = xPt + widthPt / 2;
  const centerY = yPt + heightPt / 2;
  const radians = (rotationDeg * Math.PI) / 180;
  const halfWidth =
    (Math.abs(Math.cos(radians)) * widthPt + Math.abs(Math.sin(radians)) * heightPt) / 2;
  const halfHeight =
    (Math.abs(Math.sin(radians)) * widthPt + Math.abs(Math.cos(radians)) * heightPt) / 2;
  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    right: centerX + halfWidth,
    bottom: centerY + halfHeight,
  };
}

export function unionBounds(bounds: ReadonlyArray<Bounds>): Bounds | undefined {
  if (bounds.length === 0) return undefined;
  return {
    left: Math.min(...bounds.map((value) => value.left)),
    top: Math.min(...bounds.map((value) => value.top)),
    right: Math.max(...bounds.map((value) => value.right)),
    bottom: Math.max(...bounds.map((value) => value.bottom)),
  };
}

export function artboardBounds(artboard: Pick<ArtboardV1, "widthPt" | "heightPt">): Bounds {
  return { left: 0, top: 0, right: artboard.widthPt, bottom: artboard.heightPt };
}

export function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return (
    left.left <= right.right &&
    right.left <= left.right &&
    left.top <= right.bottom &&
    right.top <= left.bottom
  );
}

/** A transient alignment guide, drawn while dragging; never persisted. */
export type SnapGuide = { axis: "x" | "y"; positionPt: number; fromPt: number; toPt: number };

const xAnchors = (bounds: Bounds) => [bounds.left, (bounds.left + bounds.right) / 2, bounds.right];
const yAnchors = (bounds: Bounds) => [bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom];

/**
 * Snaps a moving box's edges and center to the edges and centers of other boxes and the
 * artboard. Each axis snaps independently to its closest target within `thresholdPt`.
 */
export function snapMove(
  moving: Bounds,
  targets: ReadonlyArray<Bounds>,
  artboard: Bounds,
  thresholdPt: number,
): { dxPt: number; dyPt: number; guides: SnapGuide[] } {
  const candidates = [artboard, ...targets];
  const best = (axis: "x" | "y") => {
    const anchors = axis === "x" ? xAnchors : yAnchors;
    let result: { delta: number; positionPt: number } | undefined;
    for (const target of candidates)
      for (const to of anchors(target))
        for (const from of anchors(moving)) {
          const delta = to - from;
          if (
            Math.abs(delta) <= thresholdPt &&
            (result === undefined || Math.abs(delta) < Math.abs(result.delta))
          )
            result = { delta, positionPt: to };
        }
    return result;
  };
  const snapX = best("x");
  const snapY = best("y");
  const dxPt = snapX?.delta ?? 0;
  const dyPt = snapY?.delta ?? 0;
  const moved = {
    left: moving.left + dxPt,
    right: moving.right + dxPt,
    top: moving.top + dyPt,
    bottom: moving.bottom + dyPt,
  };
  const guides: SnapGuide[] = [];
  if (snapX) {
    const spans = candidates
      .filter((target) => xAnchors(target).some((value) => near(value, snapX.positionPt)))
      .concat(moved);
    guides.push({
      axis: "x",
      positionPt: snapX.positionPt,
      fromPt: Math.min(...spans.map((value) => value.top)),
      toPt: Math.max(...spans.map((value) => value.bottom)),
    });
  }
  if (snapY) {
    const spans = candidates
      .filter((target) => yAnchors(target).some((value) => near(value, snapY.positionPt)))
      .concat(moved);
    guides.push({
      axis: "y",
      positionPt: snapY.positionPt,
      fromPt: Math.min(...spans.map((value) => value.left)),
      toPt: Math.max(...spans.map((value) => value.right)),
    });
  }
  return { dxPt, dyPt, guides };
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-6;
}
