import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserRasterRepository, renderDisplayRgba } from "./raster-sources";

describe("browser raster sources", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the requested source crop from the decoded original", async () => {
    const repository = new BrowserRasterRepository(async () => ({
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      sourceRect: { x: 0, y: 0, width: 3, height: 2 },
      widthPx: 3,
      heightPx: 2,
      bitDepth: 8,
      channels: 3,
      pyramidLevel: 0,
    }));
    await repository.add("asset-a", new ArrayBuffer(1), "image/png");

    const region = await repository.getRegion("asset-a", { x: 1, y: 0, width: 2, height: 2 });

    expect(region.data).toEqual(new Uint8Array([4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18]));
    expect(region.sourceRect).toEqual({ x: 1, y: 0, width: 2, height: 2 });
  });

  it("keeps TIFF metadata in the repository and delegates exact windows to its worker", async () => {
    const read = vi.fn(async (_assetId, sourceRect) => ({
      data: new Uint16Array(sourceRect.width * sourceRect.height).fill(100),
      sourceRect,
      widthPx: sourceRect.width,
      heightPx: sourceRect.height,
      bitDepth: 16 as const,
      channels: 1 as const,
      pyramidLevel: 0,
    }));
    const tiffWorker = {
      open: vi.fn(async () => ({
        widthPx: 100,
        heightPx: 80,
        bitDepth: 16 as const,
        channels: 1 as const,
      })),
      read,
      preview: vi.fn(async () => ({
        data: new Uint16Array([0]),
        sourceRect: { x: 0, y: 0, width: 100, height: 80 },
        widthPx: 1,
        heightPx: 1,
        bitDepth: 16 as const,
        channels: 1 as const,
        pyramidLevel: 0,
      })),
      terminate: vi.fn(),
    };
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:tiff"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("document", previewDocument());
    const repository = new BrowserRasterRepository(undefined, () => tiffWorker);
    await repository.add("tiff-a", new ArrayBuffer(8), "image/tiff");

    const sourceRect = { x: 7, y: 11, width: 13, height: 17 };
    const region = await repository.getRegion("tiff-a", sourceRect);

    expect(await repository.describe("tiff-a")).toEqual({
      widthPx: 100,
      heightPx: 80,
      bitDepth: 16,
      channels: 1,
    });
    expect(read).toHaveBeenCalledWith("tiff-a", sourceRect, 0, 0);
    expect(region.data).toBeInstanceOf(Uint16Array);
    expect(region.data).toHaveLength(13 * 17);
    expect(region.data[0]).toBe(100);
  });

  it("renders preview samples in the same contrast brightness gamma invert order", () => {
    const rgba = renderDisplayRgba(
      {
        data: new Uint8Array([0, 127, 255]),
        sourceRect: { x: 0, y: 0, width: 1, height: 1 },
        widthPx: 1,
        heightPx: 1,
        bitDepth: 8,
        channels: 3,
        pyramidLevel: 0,
      },
      { brightness: 0, contrast: 1, gamma: 1, invert: true },
    );

    expect(rgba).toEqual(new Uint8ClampedArray([255, 128, 0, 255]));
  });

  it("preserves transparent PNG ImageData through the real canvas decoder", async () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 0, 0, 255, 0, 127]);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 2, height: 1, close: vi.fn() })),
    );
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: pixels }),
        }),
      }),
    });
    const transparentPng = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWP4zwAE/xnqAQt9An6kIOkhAAAAAElFTkSuQmCC",
      ),
      (character) => character.charCodeAt(0),
    );
    const repository = new BrowserRasterRepository();
    await repository.add("rgba", transparentPng.buffer as ArrayBuffer, "image/png");

    const region = await repository.getRegion("rgba", { x: 0, y: 0, width: 2, height: 1 });
    expect(region.channels).toBe(4);
    expect(region.data).toEqual(new Uint8Array([255, 0, 0, 0, 0, 255, 0, 127]));
    expect(
      renderDisplayRgba(region, { brightness: 0, contrast: 1, gamma: 1, invert: false }),
    ).toEqual(new Uint8ClampedArray([255, 0, 0, 0, 0, 255, 0, 127]));
  });
});

function previewDocument() {
  return {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: vi.fn(),
      }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob()),
    }),
  };
}
