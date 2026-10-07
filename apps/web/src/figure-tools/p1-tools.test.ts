import {
  createDefaultFigureDocument,
  type FigureDocument,
  IDENTITY_DISPLAY_V3,
} from "@figlab/figure-schema";
import type { RasterSourceResolver } from "@figlab/image-processing";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { FALLBACK_TEXT_METRICS } from "./fonts";
import { assetFacts, buildProvenanceBundle } from "./integrity-panel";
import { cropFits, lineCrop, planeOptions } from "./source-inspector";

vi.mock("./figure-tools.css", () => ({}));

describe("band (line) crops", () => {
  const size = { widthPx: 1000, heightPx: 500 };

  it("follows the dragged line's angle and centers a band of the chosen height", () => {
    const crop = lineCrop({ x: 0.1, y: 0.4 }, { x: 0.5, y: 0.48 }, 40, size);
    // 400 × 40 px line from (100, 200) to (500, 240): length √(400² + 40²), angle atan(40/400).
    expect(crop?.rotationDeg).toBeCloseTo(5.711, 3);
    expect(crop?.viewport.width).toBeCloseTo(Math.hypot(400, 40) / 1000, 6);
    expect(crop?.viewport.height).toBeCloseTo(0.08, 6);
    expect(crop && cropFits(crop, size)).toBe(true);
    expect(lineCrop({ x: 0.1, y: 0.1 }, { x: 0.1005, y: 0.1 }, 40, size)).toBeUndefined();
  });

  it("refuses bands that would leave the original", () => {
    const crop = lineCrop({ x: 0, y: 0.02 }, { x: 0.6, y: 0.02 }, 80, size);
    expect(crop && cropFits(crop, size)).toBe(false);
  });

  it("labels pages from metadata", () => {
    expect(planeOptions(3, ["C1 DAPI", "C2 GFP"])).toEqual([
      { plane: 0, label: "C1 DAPI" },
      { plane: 1, label: "C2 GFP" },
      { plane: 2, label: "Page 3" },
    ]);
  });
});

describe("provenance bundle", () => {
  it("packages the figure, report, CSV, and PDFs, and records the figures PDF", async () => {
    const document: FigureDocument = {
      ...createDefaultFigureDocument("board"),
      objects: [
        {
          id: "panel",
          type: "image-view",
          artboardId: "board",
          transform: { xPt: 0, yPt: 0, widthPt: 20, heightPt: 10, rotationDeg: 0 },
          zIndex: 0,
          locked: false,
          hidden: false,
          view: {
            sourceAssetId: "asset",
            plane: 0,
            channel: null,
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            display: { ...IDENTITY_DISPLAY_V3, gamma: 2 },
          },
        },
      ],
    };
    const resolver: RasterSourceResolver = {
      describe: async () => ({ widthPx: 2, heightPx: 1, bitDepth: 8, channels: 1 }),
      getRegion: async (_asset, rect) => ({
        data: new Uint8Array([0, 255]),
        sourceRect: rect,
        widthPx: 2,
        heightPx: 1,
        bitDepth: 8,
        channels: 1,
        pyramidLevel: 0,
      }),
    };
    const records: unknown[] = [];
    const composePdf = vi.fn(async (_document: FigureDocument, ids: ReadonlyArray<string>) =>
      new TextEncoder().encode(`%PDF-${ids.join(",")}`),
    );
    const { zip, report } = await buildProvenanceBundle({
      document,
      revision: 4,
      projectName: "Atlas",
      resolver,
      assets: assetFacts([
        {
          id: "asset",
          projectId: "p",
          filename: "blot.tif",
          mimeType: "image/tiff",
          checksumSha256: "e".repeat(64),
          widthPx: 2,
          heightPx: 1,
          bitDepth: 8,
          channelCount: 1,
          status: "ready",
          metadata: { planeLabels: ["Image"] },
          createdAt: "2026-10-06T00:00:00Z",
        },
      ]),
      fonts: { faces: {} as never, metrics: FALLBACK_TEXT_METRICS },
      dpi: 300,
      record: async (metadata) => {
        records.push(metadata);
      },
      composePdf,
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "crops.csv",
      "figure.json",
      "figures.pdf",
      "integrity-report.html",
      "integrity-report.json",
      "uncropped-originals.pdf",
    ]);
    expect(JSON.parse(strFromU8(files["figure.json"] as Uint8Array))).toEqual(document);
    expect(strFromU8(files["figures.pdf"] as Uint8Array)).toBe("%PDF-board");
    expect(strFromU8(files["uncropped-originals.pdf"] as Uint8Array)).toBe("%PDF-sheet-0");
    expect(report.panels[0]?.findings.map((finding) => finding.code)).toContain("gamma");
    expect(strFromU8(files["README.txt"] as Uint8Array)).toContain("non-linear gamma");
    expect(records).toEqual([
      expect.objectContaining({ format: "pdf", artboardId: "board", revision: 4, dpi: 300 }),
    ]);
  });
});
