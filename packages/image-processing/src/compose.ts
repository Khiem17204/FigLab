import type { DisplayTransformV1, NormalizedRect } from "@figlab/figure-schema";
import type { PanelSampler } from "./panel-render.js";
import {
  type BrowserRasterDecoder,
  MAX_EXPORT_EDGE_PX,
  MAX_EXPORT_PIXELS,
  MAX_RASTER_PIXELS,
  type RasterRegion,
  type SourcePixelRect,
} from "./raster.js";

export function applyDisplayTransform(
  sample: number,
  bitDepth: 8 | 16,
  display: DisplayTransformV1,
): number {
  const normalized = sample / (bitDepth === 8 ? 255 : 65_535);
  const contrasted = (normalized - 0.5) * display.contrast + 0.5;
  const brightened = contrasted + display.brightness;
  const clamped = Math.min(1, Math.max(0, brightened));
  const gammaCorrected = clamped ** (1 / display.gamma);
  return display.invert ? 1 - gammaCorrected : gammaCorrected;
}

export async function decodeBrowserRaster(
  decoder: BrowserRasterDecoder,
  bytes: ArrayBuffer,
  mimeType: "image/png" | "image/jpeg",
): Promise<RasterRegion> {
  const region = await decoder.decode(bytes, mimeType);
  if (
    region.bitDepth !== 8 ||
    (region.channels !== 1 && region.channels !== 3 && region.channels !== 4) ||
    region.widthPx * region.heightPx > MAX_RASTER_PIXELS
  ) {
    throw new Error("Unsupported browser raster");
  }
  return region;
}

export function validateExportDimensions(widthPx: number, heightPx: number): void {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1)
    throw new RangeError("Export dimensions must be positive integers");
  if (widthPx > MAX_EXPORT_EDGE_PX || heightPx > MAX_EXPORT_EDGE_PX)
    throw new RangeError("Export cannot exceed 16,384 px per edge");
  if (widthPx * heightPx > MAX_EXPORT_PIXELS)
    throw new RangeError("Export cannot exceed 100,000,000 pixels");
}

export function fillBackground(data: Uint8Array, hex: string): void {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
}

/**
 * Composites one panel into an artboard canvas. The sampler is asked for each covered canvas
 * pixel as a cell of the panel box, so preview and every export share one sampling rule.
 */
export function compositeImageView(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  artboardWidthPt: number,
  artboardHeightPt: number,
  transform: { xPt: number; yPt: number; widthPt: number; heightPt: number },
  sampler: PanelSampler,
): void {
  const left = Math.floor((transform.xPt / artboardWidthPt) * canvasWidth);
  const top = Math.floor((transform.yPt / artboardHeightPt) * canvasHeight);
  const right = Math.ceil(((transform.xPt + transform.widthPt) / artboardWidthPt) * canvasWidth);
  const bottom = Math.ceil(
    ((transform.yPt + transform.heightPt) / artboardHeightPt) * canvasHeight,
  );
  for (let y = Math.max(0, top); y < Math.min(canvasHeight, bottom); y += 1)
    for (let x = Math.max(0, left); x < Math.min(canvasWidth, right); x += 1) {
      const [red, green, blue, alpha] = sampler(x - left, right - left, y - top, bottom - top);
      compositeSourceOver(canvas, (y * canvasWidth + x) * 4, red, green, blue, alpha);
    }
}

export function compositeSourceOver(
  destination: Uint8Array,
  index: number,
  sourceRed: number,
  sourceGreen: number,
  sourceBlue: number,
  sourceAlpha: number,
): void {
  const sourceAlphaUnit = sourceAlpha / 255;
  const destinationAlphaUnit = sampleAtCanvas(destination, index + 3) / 255;
  const destinationContribution = destinationAlphaUnit * (1 - sourceAlphaUnit);
  const outputAlphaUnit = sourceAlphaUnit + destinationContribution;
  if (outputAlphaUnit === 0) {
    destination[index] = 0;
    destination[index + 1] = 0;
    destination[index + 2] = 0;
    destination[index + 3] = 0;
    return;
  }

  destination[index] = blendChannel(
    sourceRed,
    sampleAtCanvas(destination, index),
    sourceAlphaUnit,
    destinationContribution,
    outputAlphaUnit,
  );
  destination[index + 1] = blendChannel(
    sourceGreen,
    sampleAtCanvas(destination, index + 1),
    sourceAlphaUnit,
    destinationContribution,
    outputAlphaUnit,
  );
  destination[index + 2] = blendChannel(
    sourceBlue,
    sampleAtCanvas(destination, index + 2),
    sourceAlphaUnit,
    destinationContribution,
    outputAlphaUnit,
  );
  destination[index + 3] = Math.round(outputAlphaUnit * 255);
}

function blendChannel(
  source: number,
  destination: number,
  sourceAlphaUnit: number,
  destinationContribution: number,
  outputAlphaUnit: number,
): number {
  return Math.round(
    (source * sourceAlphaUnit + destination * destinationContribution) / outputAlphaUnit,
  );
}

function sampleAtCanvas(canvas: Uint8Array, index: number): number {
  const sample = canvas[index];
  if (sample === undefined) throw new Error("Canvas index is outside the export dimensions");
  return sample;
}

export function normalizedToPixelRect(
  viewport: NormalizedRect,
  widthPx: number,
  heightPx: number,
): SourcePixelRect {
  const x = Math.floor(viewport.x * widthPx);
  const y = Math.floor(viewport.y * heightPx);
  const right = Math.ceil((viewport.x + viewport.width) * widthPx);
  const bottom = Math.ceil((viewport.y + viewport.height) * heightPx);
  return { x, y, width: right - x, height: bottom - y };
}
