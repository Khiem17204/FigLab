import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it, vi } from "vitest";

import { renderDisplayRgba } from "../editor/raster-sources";
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

  it("keeps the RGBA preview texture consistent with source-over PNG export", async () => {
    const document = createDefaultFigureDocument("artboard-1");
    const artboard = document.artboards[0];
    if (!artboard) throw new Error("default document must contain an artboard");
    document.artboards[0] = {
      ...artboard,
      widthPt: 2,
      heightPt: 1,
      backgroundHex: "#FFFFFF",
    };
    document.objects.push({
      id: "transparent",
      type: "image-view",
      artboardId: "artboard-1",
      transform: { xPt: 0, yPt: 0, widthPt: 2, heightPt: 1, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "rgba",
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    });
    const region = {
      data: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 127]),
      sourceRect: { x: 0, y: 0, width: 2, height: 1 },
      widthPx: 2,
      heightPx: 1,
      bitDepth: 8 as const,
      channels: 4 as const,
      pyramidLevel: 0,
    };
    expect(
      renderDisplayRgba(region, { brightness: 0, contrast: 1, gamma: 1, invert: false }),
    ).toEqual(new Uint8ClampedArray([255, 0, 0, 0, 0, 255, 0, 127]));
    const sourceExporter = createArtboardPngExporter("artboard-1", {
      describe: async () => ({ widthPx: 2, heightPx: 1, bitDepth: 8, channels: 4 }),
      getRegion: async () => region,
    });

    const png = await sourceExporter(document, { widthPx: 2, heightPx: 1 });

    expect(await decodeSingleScanline(png)).toEqual(
      new Uint8Array([255, 255, 255, 255, 128, 255, 128, 255]),
    );
  });
});

async function decodeSingleScanline(png: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") chunks.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const compressed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }
  const inflated = new Uint8Array(
    await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  if (inflated[0] !== 0) throw new Error("fixture PNG must use the no-filter scanline");
  return inflated.slice(1);
}
