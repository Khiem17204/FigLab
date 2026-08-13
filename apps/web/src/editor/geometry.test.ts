import { describe, expect, it } from "vitest";

import {
  artboardScreenTransform,
  imageContainRect,
  normalizedPointInImage,
  resizeFromDraggedCorner,
} from "./geometry";

describe("editor screen geometry", () => {
  it("centers the artboard and converts screen pixels to points", () => {
    const transform = artboardScreenTransform(1000, 800, 500, 400);

    expect(transform).toMatchObject({
      scale: 2,
      leftPx: 0,
      topPx: 0,
      widthPx: 1000,
      heightPx: 800,
    });
    expect(transform.screenDeltaToPoints({ x: 40, y: -20 })).toEqual({ x: 20, y: -10 });
  });

  it("normalizes pointers inside wide and tall contain-letterboxed images", () => {
    const wide = imageContainRect({ width: 400, height: 400 }, { width: 400, height: 200 });
    expect(wide).toEqual({ left: 0, top: 100, width: 400, height: 200 });
    expect(normalizedPointInImage({ x: 200, y: 50 }, wide)).toEqual({ x: 0.5, y: 0 });

    const tall = imageContainRect({ width: 400, height: 400 }, { width: 200, height: 400 });
    expect(tall).toEqual({ left: 100, top: 0, width: 200, height: 400 });
    expect(normalizedPointInImage({ x: 50, y: 200 }, tall)).toEqual({ x: 0, y: 0.5 });
  });
});

describe("corner resize mapping", () => {
  const original = { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 as const };

  it.each([
    ["top-left", { x: -20, y: -10 }, { xPt: -10, yPt: 10, widthPt: 120, heightPt: 60 }],
    ["top-right", { x: 20, y: -10 }, { xPt: 10, yPt: 10, widthPt: 120, heightPt: 60 }],
    ["bottom-left", { x: -20, y: 10 }, { xPt: -10, yPt: 20, widthPt: 120, heightPt: 60 }],
    ["bottom-right", { x: 20, y: 10 }, { xPt: 10, yPt: 20, widthPt: 120, heightPt: 60 }],
  ] as const)("keeps the opposite corner fixed while dragging %s", (corner, delta, expected) => {
    expect(resizeFromDraggedCorner(original, corner, delta)).toEqual({
      ...expected,
      rotationDeg: 0,
    });
  });
});
