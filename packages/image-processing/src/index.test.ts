import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { writeArrayBuffer } from "geotiff";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  applyDisplayTransform,
  composeArtboardPng,
  decodeBrowserRaster,
  decodeTiff,
  type RasterSourceResolver,
  validateTiffMetadata,
} from "./index.js";

describe("display transforms", () => {
  it("applies normalize, contrast, brightness, clamp, gamma, then invert for 8-bit samples", () => {
    expect(
      applyDisplayTransform(64, 8, { brightness: 0.1, contrast: 2, gamma: 2, invert: true }),
    ).toBeCloseTo(1 - Math.sqrt(0.10196078431372546), 12);
  });

  it("preserves 16-bit precision until its shared display conversion", () => {
    expect(
      applyDisplayTransform(32768, 16, { brightness: 0, contrast: 1, gamma: 1, invert: false }),
    ).toBeCloseTo(0.5000076295109483, 12);
  });
});

describe("browser raster decoding", () => {
  it("accepts an RGBA region with its source alpha samples intact", async () => {
    const region = {
      data: new Uint8Array([10, 20, 30, 0, 40, 50, 60, 128]),
      sourceRect: { x: 0, y: 0, width: 2, height: 1 },
      widthPx: 2,
      heightPx: 1,
      bitDepth: 8 as const,
      channels: 4 as const,
      pyramidLevel: 0,
    };

    await expect(
      decodeBrowserRaster({ decode: async () => region }, new ArrayBuffer(0), "image/png"),
    ).resolves.toEqual(region);
  });
});

describe("TIFF validation", () => {
  it("decodes an unsigned 16-bit grayscale TIFF without reducing its samples", async () => {
    const bytes = writeArrayBuffer(new Uint16Array([0, 32_768]), {
      width: 2,
      height: 1,
      BitsPerSample: [16],
      SamplesPerPixel: 1,
      PhotometricInterpretation: 1,
      Compression: 1,
      SampleFormat: [1],
    });

    const region = await decodeTiff(bytes);

    expect(region).toMatchObject({ widthPx: 2, heightPx: 1, bitDepth: 16, channels: 1 });
    expect([...region.data]).toEqual([0, 32_768]);
  });

  it("accepts a supported single strip 16-bit RGB image metadata", () => {
    expect(
      validateTiffMetadata({
        imageCount: 1,
        width: 20,
        height: 10,
        isTiled: false,
        bigTiff: false,
        hasOmeMetadata: false,
        sampleFormats: [1, 1, 1],
        photometricInterpretation: 2,
        bitsPerSample: [16, 16, 16],
        samplesPerPixel: 3,
        compression: 5,
      }),
    ).toEqual({ widthPx: 20, heightPx: 10, bitDepth: 16, channels: 3 });
  });

  it("rejects RGB TIFF metadata when any channel uses signed samples", () => {
    const metadata = {
      ...supportedMetadata(),
      samplesPerPixel: 3,
      photometricInterpretation: 2,
      bitsPerSample: [8, 8, 8],
      sampleFormats: [1, 2, 1],
    };

    expect(() => validateTiffMetadata(metadata)).toThrow(/unsigned samples/);
  });

  it("rejects an RGB TIFF whose second channel uses signed samples", async () => {
    const bytes = writeArrayBuffer(new Uint8Array([1, 2, 3]), {
      width: 1,
      height: 1,
      BitsPerSample: [8, 8, 8],
      SamplesPerPixel: 3,
      PhotometricInterpretation: 2,
      Compression: 1,
      SampleFormat: [1, 2, 1],
    });

    await expect(decodeTiff(bytes)).rejects.toThrow(/unsigned samples/);
  });

  it.each([
    ["tiled", { isTiled: true }],
    ["multi-page", { imageCount: 2 }],
    ["signed", { sampleFormats: [2] }],
    ["palette", { photometricInterpretation: 3 }],
    [
      "RGBA",
      {
        samplesPerPixel: 4,
        sampleFormats: [1, 1, 1, 1],
        bitsPerSample: [8, 8, 8, 8],
        photometricInterpretation: 2,
      },
    ],
    ["unsupported compression", { compression: 7 }],
    ["too many pixels", { width: 10001, height: 10000 }],
  ])("rejects %s TIFF metadata", (_name, override) => {
    expect(() => validateTiffMetadata({ ...supportedMetadata(), ...override })).toThrow(
      /Unsupported TIFF/,
    );
  });
});

describe("CPU PNG export", () => {
  it("composes exact source pixels from original raster regions instead of a preview", async () => {
    const document = createDefaultFigureDocument("board");
    const artboard = document.artboards[0];
    if (artboard === undefined) throw new Error("default document must contain an artboard");
    document.artboards[0] = {
      ...artboard,
      widthPt: 2,
      heightPt: 1,
      backgroundHex: "#000000",
    };
    document.objects.push({
      id: "view",
      type: "image-view",
      artboardId: "board",
      transform: { xPt: 0, yPt: 0, widthPt: 2, heightPt: 1, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "asset",
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    });
    const resolver: RasterSourceResolver = {
      async describe() {
        return { widthPx: 2, heightPx: 1, bitDepth: 8, channels: 3 };
      },
      async getRegion() {
        return {
          data: new Uint8Array([255, 0, 0, 0, 255, 0]),
          sourceRect: { x: 0, y: 0, width: 2, height: 1 },
          widthPx: 2,
          heightPx: 1,
          bitDepth: 8,
          channels: 3,
          pyramidLevel: 0,
        };
      },
    };

    const bytes = await composeArtboardPng(document, "board", 2, 1, resolver);
    const decoded = PNG.sync.read(Buffer.from(bytes));
    expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("transforms RGB while preserving source alpha from a transparent RGBA region", async () => {
    const document = createDefaultFigureDocument("board");
    const artboard = document.artboards[0];
    if (artboard === undefined) throw new Error("default document must contain an artboard");
    document.artboards[0] = { ...artboard, widthPt: 2, heightPt: 2 };
    document.objects.push({
      id: "rgba-view",
      type: "image-view",
      artboardId: "board",
      transform: { xPt: 0, yPt: 0, widthPt: 2, heightPt: 2, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "rgba-asset",
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: true },
      },
    });
    const resolver: RasterSourceResolver = {
      async describe() {
        return { widthPx: 2, heightPx: 2, bitDepth: 8, channels: 4 };
      },
      async getRegion() {
        return {
          data: new Uint8Array([10, 20, 30, 0, 64, 128, 255, 64, 255, 0, 128, 128, 1, 2, 3, 255]),
          sourceRect: { x: 0, y: 0, width: 2, height: 2 },
          widthPx: 2,
          heightPx: 2,
          bitDepth: 8,
          channels: 4,
          pyramidLevel: 0,
        };
      },
    };

    const bytes = await composeArtboardPng(document, "board", 2, 2, resolver);
    const decoded = PNG.sync.read(Buffer.from(bytes));

    expect([...decoded.data]).toEqual([
      245, 235, 225, 0, 191, 127, 0, 64, 0, 255, 127, 128, 254, 253, 252, 255,
    ]);
  });

  it("rejects export dimensions over the fixed edge and pixel limits", async () => {
    const resolver = {} as RasterSourceResolver;
    await expect(
      composeArtboardPng(createDefaultFigureDocument("board"), "board", 16_385, 1, resolver),
    ).rejects.toThrow(/16,384/);
    await expect(
      composeArtboardPng(createDefaultFigureDocument("board"), "board", 10_000, 10_001, resolver),
    ).rejects.toThrow(/100,000,000/);
  });
});

function supportedMetadata() {
  return {
    imageCount: 1,
    width: 20,
    height: 10,
    isTiled: false,
    bigTiff: false,
    hasOmeMetadata: false,
    sampleFormats: [1],
    photometricInterpretation: 1,
    bitsPerSample: [8],
    samplesPerPixel: 1,
    compression: 1,
  };
}
