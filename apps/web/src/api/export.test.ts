import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";

import { createArtboardPngExporter, exportPng } from "./export";

describe("PNG export", () => {
  it("records metadata for the CPU-rendered original-source PNG", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const sourceExporter = vi
      .fn()
      .mockResolvedValue(new Blob(["png-bytes"], { type: "image/png" }));
    const download = vi.fn();

    await exportPng({
      document: createDefaultFigureDocument("artboard-1"),
      revision: 4,
      widthPx: 1200,
      heightPx: 800,
      sourceExporter,
      record,
      download,
    });

    expect(sourceExporter).toHaveBeenCalledWith(expect.anything(), {
      widthPx: 1200,
      heightPx: 800,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ format: "png", revision: 4, widthPx: 1200, heightPx: 800 }),
    );
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "figlab-1200x800.png");
  });

  it("composes a PNG from the original-source resolver", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const sourceExporter = createArtboardPngExporter("artboard-1", {
      describe: async () => ({ widthPx: 1, heightPx: 1, bitDepth: 8, channels: 3 }),
      getRegion: async () => ({
        data: new Uint8Array([255, 0, 0]),
        sourceRect: { x: 0, y: 0, width: 1, height: 1 },
        widthPx: 1,
        heightPx: 1,
        bitDepth: 8,
        channels: 3,
        pyramidLevel: 0,
      }),
    });

    const blob = await sourceExporter(document, { widthPx: 12, heightPx: 8 });

    expect(blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
  });
});
