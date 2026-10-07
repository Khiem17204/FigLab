import { describe, expect, it } from "vitest";

import { fitScale, formatZoom, stageTransform, stepZoom } from "./zoom";

describe("stageTransform", () => {
  it("fits the artboard inside the padded viewport and centers it", () => {
    const fit = stageTransform(800, 900, 612, 792, "fit", 20);
    expect(fit.scale).toBeCloseTo(fitScale(800, 900, 612, 792, 20));
    expect(fit.heightPx).toBeCloseTo(860);
    expect(fit.stageWidthPx).toBe(800);
    expect(fit.leftPx).toBeCloseTo((800 - fit.widthPx) / 2);
    expect(fit.topPx).toBeCloseTo(20);
  });

  it("grows the stage when zoomed past the viewport and keeps exact point deltas", () => {
    const zoomed = stageTransform(400, 300, 612, 792, 2, 20);
    expect(zoomed.widthPx).toBe(1224);
    expect(zoomed.stageWidthPx).toBe(1264);
    expect(zoomed.stageHeightPx).toBe(1624);
    expect(zoomed.leftPx).toBe(20);
    expect(zoomed.screenDeltaToPoints({ x: 10, y: -4 })).toEqual({ x: 5, y: -2 });
  });
});

describe("stepZoom", () => {
  it("moves between presets from any scale", () => {
    expect(stepZoom(0.83, 1)).toBe(1);
    expect(stepZoom(0.83, -1)).toBe(0.75);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });

  it("formats as a percentage of actual size", () => {
    expect(formatZoom(0.834)).toBe("83%");
  });
});
