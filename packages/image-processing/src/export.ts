import type { FigureDocument, ImageViewObjectV1 } from "@figlab/figure-schema";
import { encodePngRgba, encodeTiffRgb } from "./encode.js";
import {
  compositeImageView,
  compositeSourceOver,
  fillBackground,
  normalizedToPixelRect,
  type RasterSourceResolver,
  validateExportDimensions,
} from "./index.js";
import {
  type ArtboardScene,
  buildArtboardScene,
  type TextMetrics,
  type VectorSceneItem,
} from "./scene.js";

export const POINTS_PER_INCH = 72;
export const DEFAULT_EXPORT_DPI = 300;

/** A device-pixel window of the export canvas. */
export type PixelRegion = { leftPx: number; topPx: number; widthPx: number; heightPx: number };

/**
 * Rasterizes vector items into a region of the export canvas and returns its RGBA pixels
 * (non-premultiplied). Browsers implement this with a 2D canvas and `drawVectorItems`.
 */
export type VectorRasterizer = (
  items: ReadonlyArray<VectorSceneItem>,
  region: PixelRegion,
  pxPerPt: { x: number; y: number },
) => Promise<Uint8Array>;

export type ComposeOptions = {
  /** Required when the artboard has text or shapes. */
  metrics?: TextMetrics;
  rasterizeVector?: VectorRasterizer;
};

export function exportPixelSize(
  size: { widthPt: number; heightPt: number },
  dpi: number,
): { widthPx: number; heightPx: number } {
  return {
    widthPx: Math.max(1, Math.round((size.widthPt / POINTS_PER_INCH) * dpi)),
    heightPx: Math.max(1, Math.round((size.heightPt / POINTS_PER_INCH) * dpi)),
  };
}

const NO_TEXT_METRICS = {
  measure: () => {
    throw new Error("Rendering text requires font metrics");
  },
  ascentEm: 0,
  descentEm: 0,
  underlinePositionEm: 0,
  underlineThicknessEm: 0,
};

export function sceneFor(
  document: FigureDocument,
  artboardId: string,
  metrics?: TextMetrics,
): ArtboardScene {
  return buildArtboardScene(document, artboardId, metrics ?? NO_TEXT_METRICS);
}

/**
 * Composes an artboard to RGBA at an exact pixel size. Image panels are sampled from original
 * source regions on the CPU; consecutive runs of vector items are rasterized only over their
 * bounds and composited in z-order.
 */
export async function composeArtboardRgba(
  document: FigureDocument,
  artboardId: string,
  widthPx: number,
  heightPx: number,
  resolver: RasterSourceResolver,
  options: ComposeOptions = {},
): Promise<Uint8Array> {
  validateExportDimensions(widthPx, heightPx);
  const scene = sceneFor(document, artboardId, options.metrics);
  const canvas = new Uint8Array(widthPx * heightPx * 4);
  fillBackground(canvas, scene.backgroundHex);
  const pxPerPt = { x: widthPx / scene.widthPt, y: heightPx / scene.heightPt };
  let run: VectorSceneItem[] = [];
  const flush = async () => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    if (!options.rasterizeVector)
      throw new Error("Rendering text and shapes requires a vector rasterizer");
    const region = vectorRegion(items, pxPerPt, widthPx, heightPx);
    if (!region) return;
    const pixels = await options.rasterizeVector(items, region, pxPerPt);
    compositeRegion(canvas, widthPx, pixels, region);
  };
  for (const item of scene.items) {
    if (item.kind === "vector") {
      run.push(item);
      continue;
    }
    await flush();
    const region = await sourceRegion(item.object, resolver);
    compositeImageView(
      canvas,
      widthPx,
      heightPx,
      scene.widthPt,
      scene.heightPt,
      item.object.transform,
      region,
      item.object.view.display,
    );
  }
  await flush();
  return canvas;
}

export async function composeArtboardPng(
  document: FigureDocument,
  artboardId: string,
  widthPx: number,
  heightPx: number,
  resolver: RasterSourceResolver,
  options: ComposeOptions & { dpi?: number } = {},
): Promise<Uint8Array> {
  const rgba = await composeArtboardRgba(
    document,
    artboardId,
    widthPx,
    heightPx,
    resolver,
    options,
  );
  return encodePngRgba(rgba, widthPx, heightPx, options.dpi);
}

export async function composeArtboardTiff(
  document: FigureDocument,
  artboardId: string,
  widthPx: number,
  heightPx: number,
  resolver: RasterSourceResolver,
  options: ComposeOptions & { dpi: number },
): Promise<Uint8Array> {
  const rgba = await composeArtboardRgba(
    document,
    artboardId,
    widthPx,
    heightPx,
    resolver,
    options,
  );
  return encodeTiffRgb(rgba, widthPx, heightPx, options.dpi);
}

/**
 * Renders one image panel on its own, from original samples, at its size on the page times
 * `dpi`. SVG and PDF exports embed these as lossless PNGs.
 */
export async function renderImageViewPng(
  object: ImageViewObjectV1,
  dpi: number,
  resolver: RasterSourceResolver,
): Promise<{ png: Uint8Array; widthPx: number; heightPx: number }> {
  const { widthPx, heightPx } = exportPixelSize(object.transform, dpi);
  validateExportDimensions(widthPx, heightPx);
  const canvas = new Uint8Array(widthPx * heightPx * 4);
  const region = await sourceRegion(object, resolver);
  compositeImageView(
    canvas,
    widthPx,
    heightPx,
    object.transform.widthPt,
    object.transform.heightPt,
    { ...object.transform, xPt: 0, yPt: 0 },
    region,
    object.view.display,
  );
  return { png: await encodePngRgba(canvas, widthPx, heightPx, dpi), widthPx, heightPx };
}

async function sourceRegion(object: ImageViewObjectV1, resolver: RasterSourceResolver) {
  const source = await resolver.describe(object.view.sourceAssetId);
  const rect = normalizedToPixelRect(object.view.viewport, source.widthPx, source.heightPx);
  return resolver.getRegion(object.view.sourceAssetId, rect, 0);
}

function vectorRegion(
  items: ReadonlyArray<VectorSceneItem>,
  pxPerPt: { x: number; y: number },
  widthPx: number,
  heightPx: number,
): PixelRegion | undefined {
  const leftPx = Math.max(
    0,
    Math.floor(Math.min(...items.map((item) => item.bounds.left)) * pxPerPt.x) - 1,
  );
  const topPx = Math.max(
    0,
    Math.floor(Math.min(...items.map((item) => item.bounds.top)) * pxPerPt.y) - 1,
  );
  const rightPx = Math.min(
    widthPx,
    Math.ceil(Math.max(...items.map((item) => item.bounds.right)) * pxPerPt.x) + 1,
  );
  const bottomPx = Math.min(
    heightPx,
    Math.ceil(Math.max(...items.map((item) => item.bounds.bottom)) * pxPerPt.y) + 1,
  );
  if (rightPx <= leftPx || bottomPx <= topPx) return undefined;
  return { leftPx, topPx, widthPx: rightPx - leftPx, heightPx: bottomPx - topPx };
}

function compositeRegion(
  canvas: Uint8Array,
  canvasWidthPx: number,
  pixels: Uint8Array,
  region: PixelRegion,
): void {
  if (pixels.length !== region.widthPx * region.heightPx * 4)
    throw new Error("Vector rasterizer returned the wrong number of pixels");
  for (let y = 0; y < region.heightPx; y += 1)
    for (let x = 0; x < region.widthPx; x += 1) {
      const source = (y * region.widthPx + x) * 4;
      const alpha = pixels[source + 3] ?? 0;
      if (alpha === 0) continue;
      compositeSourceOver(
        canvas,
        ((region.topPx + y) * canvasWidthPx + region.leftPx + x) * 4,
        pixels[source] ?? 0,
        pixels[source + 1] ?? 0,
        pixels[source + 2] ?? 0,
        alpha,
      );
    }
}
