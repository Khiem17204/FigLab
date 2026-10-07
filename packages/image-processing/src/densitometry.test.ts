import { IDENTITY_DISPLAY_V3, type ImageViewObjectV3 } from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  normalizeToControl,
  quantificationCsv,
  quantifyLanes,
  type RasterSourceResolver,
  rawViewSamples,
} from "./index.js";

/**
 * A 40 × 10 px blot with 4 lanes on a white (255) background. Each lane has one dark band in
 * rows 4–5 whose darkness is given in 8-bit levels below white.
 */
function blot(darkness: number[], saturateLane?: number): RasterSourceResolver {
  return {
    describe: async () => ({ widthPx: 40, heightPx: 10, bitDepth: 8, channels: 1 }),
    async getRegion(_asset, rect) {
      const data = new Uint8Array(rect.width * rect.height).fill(255);
      for (let y = 0; y < rect.height; y += 1)
        for (let x = 0; x < rect.width; x += 1) {
          const sourceX = rect.x + x;
          const sourceY = rect.y + y;
          const lane = Math.floor(sourceX / 10);
          const inBand = sourceY >= 4 && sourceY <= 5 && sourceX % 10 >= 2 && sourceX % 10 <= 7;
          if (inBand)
            data[y * rect.width + x] = lane === saturateLane ? 0 : 255 - (darkness[lane] ?? 0);
        }
      return {
        data,
        sourceRect: rect,
        widthPx: rect.width,
        heightPx: rect.height,
        bitDepth: 8,
        channels: 1,
        pyramidLevel: 0,
      };
    },
  };
}

const view: ImageViewObjectV3 = {
  id: "blot",
  type: "image-view",
  artboardId: "board",
  transform: { xPt: 0, yPt: 0, widthPt: 200, heightPt: 50, rotationDeg: 0 },
  zIndex: 0,
  locked: false,
  hidden: false,
  view: {
    sourceAssetId: "blot",
    plane: 0,
    channel: null,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    // Display settings must not affect densitometry.
    display: { ...IDENTITY_DISPLAY_V3, gamma: 3, invert: true },
  },
};
const sizes = async () => ({ widthPx: 40, heightPx: 10 });
const options = { lanes: 4, laneCenters: null, laneWidthFraction: 0.6 };

describe("densitometry", () => {
  it("integrates band darkness per lane from raw samples, ignoring display settings", async () => {
    const samples = await rawViewSamples(view, blot([51, 102, 153, 204]), sizes);
    const lanes = quantifyLanes(samples, options, ["DMSO", "1 µM", "10 µM", "100 µM"]);
    // Each band covers 6 measured columns × 2 rows; signal = darkness / 255.
    expect(lanes.map((lane) => Number(lane.net.toFixed(3)))).toEqual([2.4, 4.8, 7.2, 9.6]);
    expect(lanes.map((lane) => lane.background)).toEqual([0, 0, 0, 0]);
    expect(lanes[1]?.label).toBe("1 µM");
  });

  it("normalizes to a loading control relative to a reference lane and flags problems", async () => {
    const target = quantifyLanes(
      await rawViewSamples(view, blot([51, 102, 153, 204], 3), sizes),
      options,
    );
    const control = quantifyLanes(
      await rawViewSamples(view, blot([102, 102, 102, 51]), sizes),
      options,
    );
    const result = normalizeToControl(target, control, 1);
    expect(result.lanes.map((lane) => Number((lane.relative ?? 0).toFixed(3)))).toEqual([
      1, 2, 3, 10,
    ]);
    expect(result.warnings.join(" ")).toMatch(/Lane 4 has .*saturated/);
    expect(result.warnings.join(" ")).toMatch(/loading control varies/);
    const csv = quantificationCsv(result, { target: "p-ERK", control: "Actin" });
    expect(csv.split("\n").at(-1)).toMatch(/^4,Lane 4,p-ERK,/);
    expect(normalizeToControl(target, undefined).warnings).toContain(
      "No loading control selected; values are not normalized.",
    );
  });

  it("subtracts a sloped background between the lane ends", () => {
    // One lane, 1 column, profile darkness rising 0 → 0.4 with a 0.3 bump in the middle row.
    const values = Float64Array.from([1, 0.9, 0.5, 0.7, 0.6]);
    const lanes = quantifyLanes(
      { values, columns: 1, rows: 5, atLimit: new Uint8Array(5) },
      { lanes: 1, laneCenters: null, laneWidthFraction: 1 },
    );
    // Signal 0, 0.1, 0.5, 0.3, 0.4 above a baseline 0, 0.1, 0.2, 0.3, 0.4 → net 0.3.
    expect(lanes[0]?.net).toBeCloseTo(0.3);
  });
});
