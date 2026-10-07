import { readFile } from "node:fs/promises";
import {
  createDefaultFigureDocument,
  type FigureDocument,
  type FigureObject,
  type TextStyleV2,
} from "@figlab/figure-schema";
import { fromArrayBuffer } from "geotiff";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  buildArtboardScene,
  type Canvas2DLike,
  composeArtboardPng,
  composeArtboardRgba,
  composeArtboardSvg,
  composeArtboardTiff,
  drawVectorItems,
  encodePngRgba,
  exportPixelSize,
  FIGURE_FONT_FILES,
  type FontFaceBytes,
  type RasterSourceResolver,
  type VectorRasterizer,
} from "./index.js";
import { composeDocumentPdf, createFontMetrics } from "./vector.js";

async function loadFonts(): Promise<FontFaceBytes> {
  const entries = await Promise.all(
    Object.entries(FIGURE_FONT_FILES).map(async ([key, file]) => [
      key,
      new Uint8Array(await readFile(new URL(`../fonts/${file}`, import.meta.url))),
    ]),
  );
  return Object.fromEntries(entries) as FontFaceBytes;
}
const fonts = await loadFonts();
const metrics = createFontMetrics(fonts);

const style = (overrides: Partial<TextStyleV2> = {}): TextStyleV2 => ({
  fontSizePt: 10,
  bold: false,
  italic: false,
  underline: false,
  colorHex: "#000000",
  align: "start",
  backgroundHex: null,
  ...overrides,
});

const base = { artboardId: "board", locked: false, hidden: false };

const imageView = (overrides: Partial<Extract<FigureObject, { type: "image-view" }>> = {}) =>
  ({
    ...base,
    id: "view",
    type: "image-view",
    transform: { xPt: 0, yPt: 0, widthPt: 2, heightPt: 2, rotationDeg: 0 },
    zIndex: 0,
    view: {
      sourceAssetId: "asset",
      plane: 0,
      channel: null,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      display: {
        levels: { black: 0, white: 1 },
        brightness: 0,
        contrast: 1,
        gamma: 1,
        invert: false,
        lut: "none",
      },
    },
    ...overrides,
  }) as FigureObject;

const text = (content: string, overrides: Record<string, unknown> = {}) =>
  ({
    ...base,
    id: "text",
    type: "text",
    transform: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 12, rotationDeg: 0 },
    zIndex: 1,
    text: { content, style: style() },
    ...overrides,
  }) as FigureObject;

function documentWith(size: { widthPt: number; heightPt: number }, ...objects: FigureObject[]) {
  const document = createDefaultFigureDocument("board");
  document.artboards[0] = {
    ...(document.artboards[0] as FigureDocument["artboards"][number]),
    ...size,
  };
  document.objects = objects;
  return document;
}

/** A 2×2 RGB source: red, green / blue, white. */
const resolver: RasterSourceResolver = {
  async describe() {
    return { widthPx: 2, heightPx: 2, bitDepth: 8, channels: 3 };
  },
  async getRegion(_assetId, sourceRect) {
    return {
      data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
      sourceRect,
      widthPx: 2,
      heightPx: 2,
      bitDepth: 8,
      channels: 3,
      pyramidLevel: 0,
    };
  },
};

describe("bundled font metrics", () => {
  it("reads Arimo's vertical metrics and measures per face", () => {
    expect(metrics.ascentEm).toBeCloseTo(0.905, 3);
    expect(metrics.descentEm).toBeCloseTo(0.212, 3);
    const regular = metrics.measure("Western blot", style());
    expect(regular).toBeGreaterThan(40);
    expect(metrics.measure("Western blot", style({ bold: true }))).toBeGreaterThan(regular);
    expect(metrics.measure("Western blot", style({ fontSizePt: 20 }))).toBeCloseTo(regular * 2, 6);
  });
});

describe("scene builder", () => {
  it("orders visible items by z-index and lays out aligned, underlined text lines", () => {
    const document = documentWith(
      { widthPt: 200, heightPt: 100 },
      text("AB\nA", {
        zIndex: 5,
        text: { content: "AB\nA", style: style({ align: "middle", underline: true }) },
      }),
      imageView({ zIndex: 2 }),
      imageView({ id: "hidden", hidden: true }),
    );
    const scene = buildArtboardScene(document, "board", metrics);
    expect(scene.items.map((item) => item.kind)).toEqual(["raster", "vector"]);
    const vector = scene.items[1];
    if (vector?.kind !== "vector") throw new Error("expected text");
    const lines = vector.primitives.filter((primitive) => primitive.type === "text");
    const width = (value: string) => metrics.measure(value, style());
    expect(lines.map((line) => line.type === "text" && line.x)).toEqual([
      10 + (100 - width("AB")) / 2,
      10 + (100 - width("A")) / 2,
    ]);
    const [first, second] = lines;
    if (first?.type !== "text" || second?.type !== "text") throw new Error("expected lines");
    expect(second.baselineY - first.baselineY).toBeCloseTo(12);
    expect(first.baselineY).toBeGreaterThan(20);
    expect(vector.primitives.filter((primitive) => primitive.type === "path")).toHaveLength(2);
  });

  it("draws arrowheads, brackets, ellipses, and rotation bounds", () => {
    const document = documentWith(
      { widthPt: 200, heightPt: 100 },
      {
        ...base,
        id: "arrow",
        type: "line",
        transform: { xPt: 0, yPt: 50, widthPt: 100, heightPt: 0, rotationDeg: 0 },
        zIndex: 0,
        line: {
          direction: "down",
          heads: "both",
          stroke: { colorHex: "#FF0000", widthPt: 1, dashed: true },
        },
      },
      {
        ...base,
        id: "bracket",
        type: "shape",
        transform: { xPt: 10, yPt: 10, widthPt: 50, heightPt: 5, rotationDeg: 90 },
        zIndex: 1,
        shape: {
          kind: "bracket",
          opening: "down",
          stroke: { colorHex: "#000000", widthPt: 1, dashed: false },
        },
      },
      {
        ...base,
        id: "ellipse",
        type: "shape",
        transform: { xPt: 0, yPt: 0, widthPt: 20, heightPt: 10, rotationDeg: 0 },
        zIndex: 2,
        shape: { kind: "ellipse", stroke: null, fillHex: "#00FF00" },
      },
    );
    const [arrow, bracket, ellipse] = buildArtboardScene(document, "board", metrics).items;
    if (arrow?.kind !== "vector" || bracket?.kind !== "vector" || ellipse?.kind !== "vector")
      throw new Error("expected vectors");
    expect(
      arrow.primitives.map((primitive) =>
        primitive.type === "path" ? (primitive.fillHex ?? null) : "other",
      ),
    ).toEqual([null, "#FF0000", "#FF0000"]);
    const shaft = arrow.primitives[0];
    expect(shaft?.type === "path" && shaft.stroke?.dash).toEqual([3, 2]);
    expect(bracket.rotation).toEqual({ deg: 90, cx: 35, cy: 12.5 });
    expect(bracket.bounds.top).toBeLessThan(-10);
    expect(ellipse.primitives).toEqual([
      { type: "ellipse", cx: 10, cy: 5, rx: 10, ry: 5, fillHex: "#00FF00" },
    ]);
  });
});

describe("canvas renderer", () => {
  it("draws rotated text with the bundled font and no kerning", () => {
    const calls: string[] = [];
    const context = new Proxy({ fontKerning: "auto" } as Record<string, unknown>, {
      get(target, property) {
        if (property in target) return target[property as string];
        return (...args: unknown[]) => calls.push(`${String(property)}(${args.join(",")})`);
      },
      set(target, property, value) {
        target[property as string] = value;
        calls.push(`${String(property)}=${value}`);
        return true;
      },
    }) as unknown as Canvas2DLike;
    const scene = buildArtboardScene(
      documentWith(
        { widthPt: 100, heightPt: 100 },
        text("Hi", { transform: { xPt: 0, yPt: 0, widthPt: 10, heightPt: 12, rotationDeg: 45 } }),
      ),
      "board",
      metrics,
    );
    drawVectorItems(
      context,
      scene.items.filter((item) => item.kind === "vector"),
    );
    expect(calls).toContain(`rotate(${Math.PI / 4})`);
    expect(calls).toContain('font=400 10px "Arimo"');
    expect(calls).toContain("fontKerning=none");
    expect(calls.some((call) => call.startsWith("fillText(Hi,0,"))).toBe(true);
  });
});

describe("raster export", () => {
  const solid =
    (color: [number, number, number]): VectorRasterizer =>
    async (_items, region) => {
      const pixels = new Uint8Array(region.widthPx * region.heightPx * 4);
      for (let index = 0; index < pixels.length; index += 4) pixels.set([...color, 255], index);
      return pixels;
    };

  it("composites vector runs in z-order between image panels", async () => {
    const below = documentWith(
      { widthPt: 4, heightPt: 4 },
      text("x", {
        zIndex: 0,
        transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      }),
      imageView({ zIndex: 1 }),
    );
    const pixel = (rgba: Uint8Array, x: number, y: number) => [
      ...rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];
    const underImage = await composeArtboardRgba(below, "board", 4, 4, resolver, {
      metrics,
      rasterizeVector: solid([9, 9, 9]),
    });
    expect(pixel(underImage, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(underImage, 3, 3)).toEqual([9, 9, 9, 255]);

    const above = documentWith(
      { widthPt: 4, heightPt: 4 },
      imageView({ zIndex: 0 }),
      text("x", {
        zIndex: 1,
        transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      }),
    );
    const overImage = await composeArtboardRgba(above, "board", 4, 4, resolver, {
      metrics,
      rasterizeVector: solid([9, 9, 9]),
    });
    expect(pixel(overImage, 0, 0)).toEqual([9, 9, 9, 255]);
  });

  it("requires a rasterizer and metrics for text", async () => {
    const document = documentWith({ widthPt: 4, heightPt: 4 }, text("x"));
    await expect(composeArtboardRgba(document, "board", 4, 4, resolver)).rejects.toThrow(/metrics/);
    await expect(
      composeArtboardRgba(document, "board", 4, 4, resolver, { metrics }),
    ).rejects.toThrow(/rasterizer/);
  });

  it("sizes exports from DPI and writes PNG pHYs", async () => {
    expect(exportPixelSize({ widthPt: 252.28, heightPt: 72 }, 300)).toEqual({
      widthPx: 1051,
      heightPx: 300,
    });
    const png = await encodePngRgba(new Uint8Array(4).fill(255), 1, 1, 300);
    const physical = Buffer.from(png).indexOf("pHYs");
    expect(physical).toBeGreaterThan(0);
    expect(Buffer.from(png).readUInt32BE(physical + 4)).toBe(11811);
    expect(PNG.sync.read(Buffer.from(png)).width).toBe(1);

    const document = documentWith({ widthPt: 2, heightPt: 2 }, imageView());
    const composed = await composeArtboardPng(document, "board", 2, 2, resolver, { dpi: 72 });
    expect([...PNG.sync.read(Buffer.from(composed)).data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it("writes a baseline Deflate RGB TIFF with its resolution", async () => {
    const document = documentWith({ widthPt: 2, heightPt: 2 }, imageView());
    const tiff = await composeArtboardTiff(document, "board", 2, 2, resolver, { dpi: 600 });
    const image = await (await fromArrayBuffer(tiff.buffer as ArrayBuffer)).getImage();
    expect([image.getWidth(), image.getHeight(), image.getSamplesPerPixel()]).toEqual([2, 2, 3]);
    const directory = image.getFileDirectory();
    const [numerator, denominator] = directory.getValue("XResolution") as number[];
    expect((numerator ?? 0) / (denominator ?? 1)).toBe(600);
    expect(directory.getValue("ResolutionUnit")).toBe(2);
    expect(image.getFileDirectory().getValue("Compression")).toBe(8);
    const rasters = (await image.readRasters({ interleave: true })) as Uint8Array;
    expect([...rasters]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("splits large TIFFs into several strips that decode back exactly", async () => {
    const width = 300;
    const height = 400;
    const rgba = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1)
      rgba.set([index % 251, (index * 7) % 253, (index * 13) % 255, 255], index * 4);
    const { encodeTiffRgb } = await import("./encode.js");
    const tiff = await encodeTiffRgb(rgba, width, height, 300);
    const image = await (await fromArrayBuffer(tiff.buffer as ArrayBuffer)).getImage();
    expect(image.getFileDirectory().getValue("StripOffsets").length).toBeGreaterThan(1);
    const rasters = (await image.readRasters({ interleave: true })) as Uint8Array;
    expect(rasters[(width * height - 1) * 3]).toBe((width * height - 1) % 251);
    expect(rasters[1000 * 3 + 2]).toBe((1000 * 13) % 255);
  });
});

describe("vector exports", () => {
  const document = (() => {
    const value = documentWith(
      { widthPt: 120, heightPt: 60 },
      imageView({ transform: { xPt: 5, yPt: 5, widthPt: 20, heightPt: 20, rotationDeg: 0 } }),
      text("α & <β>", {
        transform: { xPt: 30, yPt: 5, widthPt: 60, heightPt: 12, rotationDeg: -30 },
      }),
    );
    value.artboards.push({
      id: "board-2",
      name: "Figure 2",
      widthPt: 300,
      heightPt: 200,
      backgroundHex: "#FFFFFF",
    });
    return value;
  })();

  it("writes a self-contained SVG with embedded panels and only the faces it uses", async () => {
    const svg = await composeArtboardSvg(document, "board", { dpi: 300, resolver, metrics, fonts });
    expect(svg).toContain('width="120pt" height="60pt" viewBox="0 0 120 60"');
    expect(svg).toContain('<image data-object-id="view" x="5" y="5" width="20" height="20"');
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain("&#38; &#60;β&#62;");
    expect(svg).toContain('transform="rotate(-30 60 11)"');
    expect(svg.match(/@font-face/g)).toHaveLength(1);
    expect(svg).not.toContain("font-weight:700");
  });

  it("writes one PDF page per figure at its size with the font embedded", async () => {
    const bytes = await composeDocumentPdf(document, ["board", "board-2"], {
      dpi: 150,
      resolver,
      metrics,
      fonts,
      title: "Figure set",
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPages().map((page) => page.getSize())).toEqual([
      { width: 120, height: 60 },
      { width: 300, height: 200 },
    ]);
    expect(pdf.getTitle()).toBe("Figure set");
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain("/FontFile2");
    expect(raw).toContain("/Subtype /Image");
  });
});
