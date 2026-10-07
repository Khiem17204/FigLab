import type { DisplayTransformV1, ImagePanelObject } from "@figlab/figure-schema";
import {
  applyDisplayTransform,
  cropSizePx,
  decodeBrowserRaster,
  panelCrop,
  type RasterDescription,
  type RasterRegion,
  type RasterSourceResolver,
  renderPanelRgba,
  type SourcePixelRect,
  type SourceSizes,
} from "@figlab/image-processing";
import { createTiffRasterWorkerClient, type TiffRasterClient } from "./tiff-worker-client";

export type SupportedRasterMime = "image/png" | "image/jpeg" | "image/tiff";
export type RasterDecode = (
  bytes: ArrayBuffer,
  mimeType: SupportedRasterMime,
) => Promise<RasterRegion>;

export class BrowserRasterRepository implements RasterSourceResolver {
  private readonly regions = new Map<string, RasterRegion>();
  private readonly tiffDescriptions = new Map<string, RasterDescription>();
  private readonly previewUrls = new Map<string, string>();
  /** Originals still downloading or decoding; reads of them wait instead of failing. */
  private readonly loading = new Map<string, Promise<void>>();
  private tiffClient: TiffRasterClient | undefined;

  constructor(
    private readonly decode: RasterDecode = decodeRasterInBrowser,
    private readonly createTiffClient: () => TiffRasterClient = createTiffRasterWorkerClient,
  ) {}

  async add(assetId: string, bytes: ArrayBuffer, mimeType: SupportedRasterMime): Promise<void> {
    if (mimeType === "image/tiff") {
      const client = this.requiredTiffClient();
      const description = await client.open(assetId, bytes);
      this.tiffDescriptions.set(assetId, description);
      const preview = await client.preview(assetId);
      this.previewUrls.set(assetId, await createTiffPreviewUrl(preview));
      return;
    }
    const region = await this.decode(bytes, mimeType);
    this.regions.set(assetId, region);
    this.previewUrls.set(assetId, createPreviewUrl(bytes, mimeType));
  }

  /**
   * Records that an original is on its way (download plus `add`). Until it settles, `describe`
   * and `getRegion` for that asset wait for it, so exports and checks started early still read
   * original pixels.
   */
  track(assetId: string, load: Promise<void>): Promise<void> {
    const settled = load.finally(() => {
      if (this.loading.get(assetId) === settled) this.loading.delete(assetId);
    });
    this.loading.set(assetId, settled);
    return settled;
  }

  private async ready(assetId: string): Promise<void> {
    if (this.has(assetId)) return;
    await this.loading.get(assetId)?.catch(() => undefined);
  }

  has(assetId: string): boolean {
    return this.regions.has(assetId) || this.tiffDescriptions.has(assetId);
  }

  getPreviewUrl(assetId: string): string | undefined {
    return this.previewUrls.get(assetId);
  }

  /** A whole-image preview of one page of a multi-page TIFF (page 0 is `getPreviewUrl`). */
  async getPlanePreviewUrl(assetId: string, plane: number): Promise<string | undefined> {
    if (plane === 0) return this.getPreviewUrl(assetId);
    const key = `plane:${assetId}:${plane}`;
    const cached = this.previewUrls.get(key);
    if (cached) return cached;
    if (!this.tiffDescriptions.has(assetId)) return undefined;
    const url = await createTiffPreviewUrl(
      await this.requiredTiffClient().preview(assetId, 1_024, plane),
    );
    this.previewUrls.set(key, url);
    return url;
  }

  /**
   * A preview of a panel rendered with the same sampler as export, from original samples, at a
   * bounded size. Everything that affects pixels (crop, rotation, flips, plane, channel, display)
   * is part of the cache key; placement on the artboard is not.
   */
  async getPanelPreviewUrl(
    object: ImagePanelObject,
    sizes: SourceSizes,
    maxEdge = 768,
  ): Promise<string> {
    const reading = object.type === "image-view" ? object.view : object.composite;
    const cacheKey = `panel:${JSON.stringify(reading)}:${maxEdge}`;
    const cached = this.previewUrls.get(cacheKey);
    if (cached) return cached;
    const firstAsset =
      object.type === "image-view"
        ? object.view.sourceAssetId
        : (object.composite.channels[0]?.sourceAssetId ?? "");
    const crop = cropSizePx(panelCrop(object), await sizes(firstAsset));
    const scale = Math.min(1, maxEdge / Math.max(crop.widthPx, crop.heightPx));
    const widthPx = Math.max(1, Math.round(crop.widthPx * scale));
    const heightPx = Math.max(1, Math.round(crop.heightPx * scale));
    const rgba = await renderPanelRgba(object, widthPx, heightPx, this, sizes);
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    const image = context.createImageData(widthPx, heightPx);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("Could not render a preview"))),
        "image/png",
      ),
    );
    const url = URL.createObjectURL(blob);
    this.previewUrls.set(cacheKey, url);
    return url;
  }

  async getDisplayPreviewUrl(
    assetId: string,
    sourceRect: SourcePixelRect,
    display: DisplayTransformV1,
  ): Promise<string> {
    const cacheKey = `display:${assetId}:${JSON.stringify(sourceRect)}:${JSON.stringify(display)}`;
    const cached = this.previewUrls.get(cacheKey);
    if (cached) return cached;
    const region = this.tiffDescriptions.has(assetId)
      ? await this.requiredTiffClient().read(assetId, sourceRect, 0)
      : cropRegion(this.required(assetId), sourceRect);
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
    await this.ready(assetId);
    const tiff = this.tiffDescriptions.get(assetId);
    if (tiff) return { ...tiff };
    const region = this.required(assetId);
    return {
      widthPx: region.widthPx,
      heightPx: region.heightPx,
      bitDepth: region.bitDepth,
      channels: region.channels,
    };
  }

  async getRegion(
    assetId: string,
    sourceRect: SourcePixelRect,
    pyramidLevel = 0,
    plane = 0,
  ): Promise<RasterRegion> {
    await this.ready(assetId);
    if (this.tiffDescriptions.has(assetId))
      return this.requiredTiffClient().read(assetId, sourceRect, pyramidLevel, plane);
    if (pyramidLevel !== 0) throw new Error("Raster pyramids are not supported");
    if (plane !== 0) throw new Error("Only TIFF originals have more than one page");
    return cropRegion(this.required(assetId), sourceRect);
  }

  dispose(): void {
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url);
    this.previewUrls.clear();
    this.regions.clear();
    this.tiffDescriptions.clear();
    this.tiffClient?.terminate();
    this.tiffClient = undefined;
  }

  private required(assetId: string): RasterRegion {
    const region = this.regions.get(assetId);
    if (!region) throw new Error(`Raster source ${assetId} is not loaded`);
    return region;
  }

  private requiredTiffClient(): TiffRasterClient {
    this.tiffClient ??= this.createTiffClient();
    return this.tiffClient;
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
  if (mimeType === "image/tiff") throw new Error("TIFF decoding requires its dedicated worker");
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
    if (mimeType === "image/png") {
      return {
        data: new Uint8Array(rgba),
        sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
        widthPx: canvas.width,
        heightPx: canvas.height,
        bitDepth: 8,
        channels: 4,
        pyramidLevel: 0,
      };
    }
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

function createPreviewUrl(bytes: ArrayBuffer, mimeType: SupportedRasterMime): string {
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

async function createTiffPreviewUrl(region: RasterRegion): Promise<string> {
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
