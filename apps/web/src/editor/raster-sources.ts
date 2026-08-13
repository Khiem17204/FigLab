import type { DisplayTransformV1 } from "@figlab/figure-schema";
import {
  applyDisplayTransform,
  decodeBrowserRaster,
  decodeTiff,
  type RasterDescription,
  type RasterRegion,
  type RasterSourceResolver,
  type SourcePixelRect,
} from "@figlab/image-processing";

export type SupportedRasterMime = "image/png" | "image/jpeg" | "image/tiff";
export type RasterDecode = (
  bytes: ArrayBuffer,
  mimeType: SupportedRasterMime,
) => Promise<RasterRegion>;

export class BrowserRasterRepository implements RasterSourceResolver {
  private readonly regions = new Map<string, RasterRegion>();
  private readonly previewUrls = new Map<string, string>();

  constructor(private readonly decode: RasterDecode = decodeRasterInBrowser) {}

  async add(assetId: string, bytes: ArrayBuffer, mimeType: SupportedRasterMime): Promise<void> {
    const region = await this.decode(bytes, mimeType);
    this.regions.set(assetId, region);
    this.previewUrls.set(assetId, await createPreviewUrl(bytes, mimeType, region));
  }

  has(assetId: string): boolean {
    return this.regions.has(assetId);
  }

  getPreviewUrl(assetId: string): string | undefined {
    return this.previewUrls.get(assetId);
  }

  async getDisplayPreviewUrl(
    assetId: string,
    sourceRect: SourcePixelRect,
    display: DisplayTransformV1,
  ): Promise<string> {
    const cacheKey = `display:${assetId}:${JSON.stringify(sourceRect)}:${JSON.stringify(display)}`;
    const cached = this.previewUrls.get(cacheKey);
    if (cached) return cached;
    const region = cropRegion(this.required(assetId), sourceRect);
    const canvas = document.createElement("canvas");
    canvas.width = region.widthPx;
    canvas.height = region.heightPx;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    const image = context.createImageData(region.widthPx, region.heightPx);
    image.data.set(renderDisplayRgba(region, display));
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Could not render display preview")),
        "image/png",
      ),
    );
    const url = URL.createObjectURL(blob);
    this.previewUrls.set(cacheKey, url);
    return url;
  }

  async describe(assetId: string): Promise<RasterDescription> {
    const region = this.required(assetId);
    return {
      widthPx: region.widthPx,
      heightPx: region.heightPx,
      bitDepth: region.bitDepth,
      channels: region.channels,
    };
  }

  async getRegion(assetId: string, sourceRect: SourcePixelRect): Promise<RasterRegion> {
    return cropRegion(this.required(assetId), sourceRect);
  }

  dispose(): void {
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url);
    this.previewUrls.clear();
    this.regions.clear();
  }

  private required(assetId: string): RasterRegion {
    const region = this.regions.get(assetId);
    if (!region) throw new Error(`Raster source ${assetId} is not loaded`);
    return region;
  }
}

export function renderDisplayRgba(
  region: RasterRegion,
  display: DisplayTransformV1,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(region.widthPx * region.heightPx * 4);
  for (let pixel = 0; pixel < region.widthPx * region.heightPx; pixel += 1) {
    const source = pixel * region.channels;
    const target = pixel * 4;
    const sample = (channel: number) =>
      Math.round(
        applyDisplayTransform(region.data[source + channel] ?? 0, region.bitDepth, display) * 255,
      );
    rgba[target] = sample(0);
    rgba[target + 1] = sample(region.channels === 1 ? 0 : 1);
    rgba[target + 2] = sample(region.channels === 1 ? 0 : 2);
    rgba[target + 3] = region.channels === 4 ? (region.data[source + 3] ?? 0) : 255;
  }
  return rgba;
}

async function decodeRasterInBrowser(
  bytes: ArrayBuffer,
  mimeType: SupportedRasterMime,
): Promise<RasterRegion> {
  if (mimeType === "image/tiff") return decodeTiff(bytes);
  return decodeBrowserRaster(new CanvasRasterDecoder(), bytes, mimeType);
}

class CanvasRasterDecoder {
  async decode(bytes: ArrayBuffer, mimeType: "image/png" | "image/jpeg"): Promise<RasterRegion> {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
      rgb[target] = rgba[source] ?? 0;
      rgb[target + 1] = rgba[source + 1] ?? 0;
      rgb[target + 2] = rgba[source + 2] ?? 0;
    }
    return {
      data: rgb,
      sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      widthPx: canvas.width,
      heightPx: canvas.height,
      bitDepth: 8,
      channels: 3,
      pyramidLevel: 0,
    };
  }
}

function cropRegion(source: RasterRegion, rect: SourcePixelRect): RasterRegion {
  const data =
    source.bitDepth === 8
      ? new Uint8Array(rect.width * rect.height * source.channels)
      : new Uint16Array(rect.width * rect.height * source.channels);
  for (let row = 0; row < rect.height; row += 1) {
    const sourceStart = ((rect.y + row) * source.widthPx + rect.x) * source.channels;
    const sourceEnd = sourceStart + rect.width * source.channels;
    data.set(source.data.subarray(sourceStart, sourceEnd), row * rect.width * source.channels);
  }
  return {
    data,
    sourceRect: rect,
    widthPx: rect.width,
    heightPx: rect.height,
    bitDepth: source.bitDepth,
    channels: source.channels,
    pyramidLevel: 0,
  };
}

async function createPreviewUrl(
  bytes: ArrayBuffer,
  mimeType: SupportedRasterMime,
  region: RasterRegion,
): Promise<string> {
  if (mimeType !== "image/tiff") return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const canvas = document.createElement("canvas");
  canvas.width = region.widthPx;
  canvas.height = region.heightPx;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const image = context.createImageData(region.widthPx, region.heightPx);
  const divisor = region.bitDepth === 8 ? 1 : 257;
  for (let pixel = 0; pixel < region.widthPx * region.heightPx; pixel += 1) {
    const source = pixel * region.channels;
    const target = pixel * 4;
    image.data[target] = Math.round((region.data[source] ?? 0) / divisor);
    image.data[target + 1] = Math.round(
      (region.data[source + (region.channels === 1 ? 0 : 1)] ?? 0) / divisor,
    );
    image.data[target + 2] = Math.round(
      (region.data[source + (region.channels === 1 ? 0 : 2)] ?? 0) / divisor,
    );
    image.data[target + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Could not render TIFF preview"))),
      "image/png",
    ),
  );
  return URL.createObjectURL(blob);
}
