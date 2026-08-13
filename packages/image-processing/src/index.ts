import type { DisplayTransformV1, FigureDocumentV1, NormalizedRect } from "@figlab/figure-schema";
import { fromArrayBuffer } from "geotiff";

export const MAX_RASTER_PIXELS = 100_000_000;
export const MAX_EXPORT_EDGE_PX = 16_384;
export const MAX_EXPORT_PIXELS = 100_000_000;

export type RasterDescription = {
  widthPx: number;
  heightPx: number;
  bitDepth: 8 | 16;
  channels: 1 | 3;
};
export type SourcePixelRect = { x: number; y: number; width: number; height: number };
export type RasterRegion = {
  data: Uint8Array | Uint16Array;
  sourceRect: SourcePixelRect;
  widthPx: number;
  heightPx: number;
  bitDepth: 8 | 16;
  channels: 1 | 3;
  pyramidLevel: number;
};

export interface RasterSourceResolver {
  describe(assetId: string): Promise<RasterDescription>;
  getRegion(
    assetId: string,
    sourceRect: SourcePixelRect,
    pyramidLevel?: number,
  ): Promise<RasterRegion>;
}

export type BrowserRasterDecoder = {
  decode(bytes: ArrayBuffer, mimeType: "image/png" | "image/jpeg"): Promise<RasterRegion>;
};

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

export type TiffMetadata = {
  imageCount: number;
  width: number;
  height: number;
  isTiled: boolean;
  bigTiff: boolean;
  hasOmeMetadata: boolean;
  sampleFormats: number[];
  photometricInterpretation: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  compression: number;
};

export function validateTiffMetadata(metadata: TiffMetadata): RasterDescription {
  const fail = (reason: string): never => {
    throw new Error(`Unsupported TIFF: ${reason}`);
  };
  if (metadata.imageCount !== 1) fail("exactly one image is required");
  if (metadata.isTiled) fail("tiled images are not supported");
  if (metadata.bigTiff) fail("BigTIFF is not supported");
  if (metadata.hasOmeMetadata) fail("OME metadata is not supported");
  if (
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1
  ) {
    fail("invalid dimensions");
  }
  if (metadata.width * metadata.height > MAX_RASTER_PIXELS)
    fail("image exceeds 100,000,000 pixels");
  if (
    metadata.sampleFormats.length !== metadata.samplesPerPixel ||
    !metadata.sampleFormats.every((sampleFormat) => sampleFormat === 1)
  ) {
    fail("only unsigned samples are supported");
  }
  if (metadata.samplesPerPixel !== 1 && metadata.samplesPerPixel !== 3)
    fail("only grayscale or RGB is supported");
  if (metadata.photometricInterpretation !== 1 && metadata.photometricInterpretation !== 2)
    fail("only grayscale or RGB is supported");
  if (
    (metadata.samplesPerPixel === 1 && metadata.photometricInterpretation !== 1) ||
    (metadata.samplesPerPixel === 3 && metadata.photometricInterpretation !== 2)
  ) {
    fail("channel layout does not match photometric interpretation");
  }
  const bitDepth = metadata.bitsPerSample[0];
  if (
    (bitDepth !== 8 && bitDepth !== 16) ||
    metadata.bitsPerSample.length !== metadata.samplesPerPixel ||
    !metadata.bitsPerSample.every((bits) => bits === bitDepth)
  ) {
    fail("only uniform 8-bit or 16-bit samples are supported");
  }
  if (![1, 5, 8].includes(metadata.compression)) fail("compression must be none, LZW, or Deflate");
  return {
    widthPx: metadata.width,
    heightPx: metadata.height,
    bitDepth: bitDepth as 8 | 16,
    channels: metadata.samplesPerPixel as 1 | 3,
  };
}

export async function decodeTiff(bytes: ArrayBuffer): Promise<RasterRegion> {
  const tiff = await fromArrayBuffer(bytes);
  const imageCount = await tiff.getImageCount();
  const image = await tiff.getImage();
  const directory = image.getFileDirectory();
  const imageDescription = await directory.loadValue("ImageDescription");
  const description = validateTiffMetadata({
    imageCount,
    width: image.getWidth(),
    height: image.getHeight(),
    isTiled: image.isTiled,
    bigTiff: isBigTiff(bytes),
    hasOmeMetadata: hasOmeMetadata(imageDescription),
    sampleFormats: Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
      image.getSampleFormat(index),
    ),
    photometricInterpretation: numberTag(directory.getValue("PhotometricInterpretation")),
    bitsPerSample: Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
      image.getBitsPerSample(index),
    ),
    samplesPerPixel: image.getSamplesPerPixel(),
    compression: numberTag(directory.getValue("Compression")),
  });
  const data = await image.readRasters({ interleave: true });
  if (description.bitDepth === 8 && !(data instanceof Uint8Array))
    throw new Error("Unsupported TIFF: decoder returned non-8-bit samples");
  if (description.bitDepth === 16 && !(data instanceof Uint16Array))
    throw new Error("Unsupported TIFF: decoder returned non-16-bit samples");
  const rasterData = data as Uint8Array | Uint16Array;
  return {
    data: rasterData,
    sourceRect: { x: 0, y: 0, width: description.widthPx, height: description.heightPx },
    widthPx: description.widthPx,
    heightPx: description.heightPx,
    bitDepth: description.bitDepth,
    channels: description.channels,
    pyramidLevel: 0,
  };
}

function isBigTiff(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes);
  const littleEndian = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
  const bigEndian = view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d;
  return (littleEndian || bigEndian) && view.getUint16(2, littleEndian) === 43;
}

function numberTag(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value) && typeof value[0] === "number") return value[0];
  return 0;
}

function hasOmeMetadata(value: unknown): boolean {
  return typeof value === "string" && /<OME\b/i.test(value);
}

export async function decodeBrowserRaster(
  decoder: BrowserRasterDecoder,
  bytes: ArrayBuffer,
  mimeType: "image/png" | "image/jpeg",
): Promise<RasterRegion> {
  const region = await decoder.decode(bytes, mimeType);
  if (
    region.bitDepth !== 8 ||
    (region.channels !== 1 && region.channels !== 3) ||
    region.widthPx * region.heightPx > MAX_RASTER_PIXELS
  ) {
    throw new Error("Unsupported browser raster");
  }
  return region;
}

export async function composeArtboardPng(
  document: FigureDocumentV1,
  artboardId: string,
  widthPx: number,
  heightPx: number,
  resolver: RasterSourceResolver,
): Promise<Uint8Array> {
  validateExportDimensions(widthPx, heightPx);
  const artboard = document.artboards.find((candidate) => candidate.id === artboardId);
  if (artboard === undefined) throw new Error(`Artboard ${artboardId} was not found`);
  const canvas = new Uint8Array(widthPx * heightPx * 4);
  fillBackground(canvas, artboard.backgroundHex);
  const views = document.objects
    .filter((object) => object.artboardId === artboardId && !object.hidden)
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex);
  for (const object of views) {
    const source = await resolver.describe(object.view.sourceAssetId);
    const sourceRect = normalizedToPixelRect(object.view.viewport, source.widthPx, source.heightPx);
    const region = await resolver.getRegion(object.view.sourceAssetId, sourceRect, 0);
    compositeImageView(
      canvas,
      widthPx,
      heightPx,
      artboard.widthPt,
      artboard.heightPt,
      object.transform,
      region,
      object.view.display,
    );
  }
  return encodePngRgba(canvas, widthPx, heightPx);
}

async function encodePngRgba(
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
): Promise<Uint8Array> {
  const rowByteLength = widthPx * 4;
  const scanlines = new Uint8Array((rowByteLength + 1) * heightPx);
  for (let y = 0; y < heightPx; y += 1) {
    const sourceOffset = y * rowByteLength;
    const targetOffset = y * (rowByteLength + 1);
    scanlines[targetOffset] = 0;
    scanlines.set(data.subarray(sourceOffset, sourceOffset + rowByteLength), targetOffset + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, widthPx, false);
  headerView.setUint32(4, heightPx, false);
  header[8] = 8;
  header[9] = 6;
  const compressed = await deflate(scanlines);
  return concatenateBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("PNG export requires CompressionStream support");
  }
  const compression = new CompressionStream("deflate");
  const compressed = readStream(compression.readable);
  const writer = compression.writable.getWriter();
  const input = new Uint8Array(new ArrayBuffer(data.byteLength));
  input.set(data);
  await writer.write(input);
  await writer.close();
  return compressed;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return concatenateBytes(chunks);
    chunks.push(value);
  }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let index = 0; index < 4; index += 1) chunk[index + 4] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)), false);
  return chunk;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function concatenateBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function validateExportDimensions(widthPx: number, heightPx: number): void {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1)
    throw new RangeError("Export dimensions must be positive integers");
  if (widthPx > MAX_EXPORT_EDGE_PX || heightPx > MAX_EXPORT_EDGE_PX)
    throw new RangeError("PNG export cannot exceed 16,384 px per edge");
  if (widthPx * heightPx > MAX_EXPORT_PIXELS)
    throw new RangeError("PNG export cannot exceed 100,000,000 pixels");
}

function fillBackground(data: Uint8Array, hex: string): void {
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

function compositeImageView(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  artboardWidthPt: number,
  artboardHeightPt: number,
  transform: { xPt: number; yPt: number; widthPt: number; heightPt: number },
  region: RasterRegion,
  display: DisplayTransformV1,
): void {
  const left = Math.floor((transform.xPt / artboardWidthPt) * canvasWidth);
  const top = Math.floor((transform.yPt / artboardHeightPt) * canvasHeight);
  const right = Math.ceil(((transform.xPt + transform.widthPt) / artboardWidthPt) * canvasWidth);
  const bottom = Math.ceil(
    ((transform.yPt + transform.heightPt) / artboardHeightPt) * canvasHeight,
  );
  for (let y = Math.max(0, top); y < Math.min(canvasHeight, bottom); y += 1) {
    const sourceY = Math.min(
      region.heightPx - 1,
      Math.max(0, Math.floor(((y - top) / (bottom - top)) * region.heightPx)),
    );
    for (let x = Math.max(0, left); x < Math.min(canvasWidth, right); x += 1) {
      const sourceX = Math.min(
        region.widthPx - 1,
        Math.max(0, Math.floor(((x - left) / (right - left)) * region.widthPx)),
      );
      const sampleIndex = (sourceY * region.widthPx + sourceX) * region.channels;
      const targetIndex = (y * canvasWidth + x) * 4;
      const red = displayedSample(sampleAt(region, sampleIndex), region.bitDepth, display);
      const green =
        region.channels === 1
          ? red
          : displayedSample(sampleAt(region, sampleIndex + 1), region.bitDepth, display);
      const blue =
        region.channels === 1
          ? red
          : displayedSample(sampleAt(region, sampleIndex + 2), region.bitDepth, display);
      canvas[targetIndex] = red;
      canvas[targetIndex + 1] = green;
      canvas[targetIndex + 2] = blue;
      canvas[targetIndex + 3] = 255;
    }
  }
}

function sampleAt(region: RasterRegion, index: number): number {
  const sample = region.data[index];
  if (sample === undefined)
    throw new Error("Raster region data is shorter than its declared dimensions");
  return sample;
}

function displayedSample(sample: number, bitDepth: 8 | 16, display: DisplayTransformV1): number {
  return Math.round(applyDisplayTransform(sample, bitDepth, display) * 255);
}

function normalizedToPixelRect(
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
