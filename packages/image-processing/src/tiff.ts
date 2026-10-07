import { fromArrayBuffer } from "geotiff";
import {
  MAX_RASTER_PIXELS,
  type RasterDescription,
  type RasterRegion,
  type SourcePixelRect,
} from "./raster.js";

export const MAX_TIFF_PLANES = 1000;
/** None, LZW, Adobe Deflate, PackBits, and old-style Deflate: all lossless. */
const LOSSLESS_COMPRESSIONS = [1, 5, 8, 32773, 32946];

export function tiffReadOptions(sourceRect: SourcePixelRect): {
  window: [number, number, number, number];
  interleave: true;
} {
  return {
    window: [
      sourceRect.x,
      sourceRect.y,
      sourceRect.x + sourceRect.width,
      sourceRect.y + sourceRect.height,
    ],
    interleave: true,
  };
}

/** Per-page facts; the validator checks one page at a time. */
export type TiffMetadata = {
  width: number;
  height: number;
  sampleFormats: number[];
  photometricInterpretation: number;
  bitsPerSample: number[];
  samplesPerPixel: number;
  compression: number;
  /** Pages in the file; informational (multi-page files are accepted). */
  imageCount?: number;
  isTiled?: boolean;
  bigTiff?: boolean;
  hasOmeMetadata?: boolean;
};

export type TiffCalibration = {
  umPerPxX: number;
  umPerPxY: number;
  source: "imagej" | "ome" | "tiff-resolution";
};

/** A verified TIFF: every full-resolution page shares this geometry and sample layout. */
export type TiffDescription = RasterDescription & {
  planes: number;
  planeLabels: string[];
  calibration?: TiffCalibration;
  ome: boolean;
  tiled: boolean;
  bigTiff: boolean;
};

export function validateTiffMetadata(metadata: TiffMetadata): RasterDescription {
  const fail = (reason: string): never => {
    throw new Error(`Unsupported TIFF: ${reason}`);
  };
  if (
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1
  )
    fail("invalid dimensions");
  if (metadata.width * metadata.height > MAX_RASTER_PIXELS)
    fail("image exceeds 100,000,000 pixels");
  if (
    metadata.sampleFormats.length !== metadata.samplesPerPixel ||
    !metadata.sampleFormats.every((sampleFormat) => sampleFormat === 1)
  )
    fail("only unsigned samples are supported");
  if (metadata.samplesPerPixel !== 1 && metadata.samplesPerPixel !== 3)
    fail("only grayscale or RGB is supported");
  if (metadata.photometricInterpretation !== 1 && metadata.photometricInterpretation !== 2)
    fail("only grayscale or RGB is supported");
  if (
    (metadata.samplesPerPixel === 1 && metadata.photometricInterpretation !== 1) ||
    (metadata.samplesPerPixel === 3 && metadata.photometricInterpretation !== 2)
  )
    fail("channel layout does not match photometric interpretation");
  const bitDepth = metadata.bitsPerSample[0];
  if (
    (bitDepth !== 8 && bitDepth !== 16) ||
    metadata.bitsPerSample.length !== metadata.samplesPerPixel ||
    !metadata.bitsPerSample.every((bits) => bits === bitDepth)
  )
    fail("only uniform 8-bit or 16-bit samples are supported");
  if (!LOSSLESS_COMPRESSIONS.includes(metadata.compression))
    fail("compression must be lossless (none, LZW, Deflate, or PackBits)");
  return {
    widthPx: metadata.width,
    heightPx: metadata.height,
    bitDepth: bitDepth as 8 | 16,
    channels: metadata.samplesPerPixel as 1 | 3,
  };
}

const UNIT_UM: Record<string, number> = {
  nm: 0.001,
  nanometer: 0.001,
  um: 1,
  µm: 1,
  μm: 1,
  micron: 1,
  microns: 1,
  micrometer: 1,
  mm: 1000,
  millimeter: 1000,
  cm: 10_000,
  centimeter: 10_000,
};

/** geotiff returns RATIONAL tags as [numerator, denominator] in an array or typed array. */
function rational(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (
    (Array.isArray(value) || ArrayBuffer.isView(value)) &&
    typeof (value as ArrayLike<unknown>)[0] === "number"
  ) {
    const pair = value as ArrayLike<number>;
    const denominator = pair.length > 1 ? (pair[1] ?? 1) : 1;
    return denominator === 0 ? undefined : (pair[0] ?? 0) / denominator;
  }
  return undefined;
}

export type OmeInfo = {
  sizeC: number;
  sizeZ: number;
  sizeT: number;
  dimensionOrder: string;
  channelNames: string[];
  physicalSizeX?: number | undefined;
  physicalSizeY?: number | undefined;
  unitX: string;
  unitY: string;
};

const attribute = (xml: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];

/** Reads the dimensions, channel names, and pixel size of the first OME image. */
export function parseOmeXml(description: string): OmeInfo | undefined {
  if (!/<OME\b/i.test(description)) return undefined;
  const pixels = /<Pixels\b[^>]*>/i.exec(description)?.[0];
  if (!pixels) return undefined;
  const number = (name: string) => {
    const value = Number(attribute(pixels, name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const channelNames = [...description.matchAll(/<Channel\b[^>]*>/gi)].map(
    (match) => attribute(match[0], "Name") ?? "",
  );
  return {
    sizeC: number("SizeC") ?? 1,
    sizeZ: number("SizeZ") ?? 1,
    sizeT: number("SizeT") ?? 1,
    dimensionOrder: attribute(pixels, "DimensionOrder") ?? "XYCZT",
    channelNames,
    physicalSizeX: number("PhysicalSizeX"),
    physicalSizeY: number("PhysicalSizeY"),
    unitX: attribute(pixels, "PhysicalSizeXUnit") ?? "µm",
    unitY: attribute(pixels, "PhysicalSizeYUnit") ?? "µm",
  };
}

/** ImageJ writes `key=value` lines into ImageDescription, starting with `ImageJ=`. */
export function parseImageJDescription(description: string): Record<string, string> | undefined {
  if (!description.startsWith("ImageJ=")) return undefined;
  return Object.fromEntries(
    description
      .split("\n")
      .map((line) => line.split("="))
      .filter((parts) => parts.length >= 2)
      .map(([key = "", ...rest]) => [key.trim(), rest.join("=").trim()]),
  );
}

/**
 * Physical pixel size, in order of authority: OME physical size, an ImageJ calibrated unit with
 * the X/Y resolution tags, then a centimetre resolution unit. Inch units describe print DPI, not
 * the specimen, and are ignored.
 */
export function tiffCalibration(input: {
  imageDescription?: string | undefined;
  xResolution?: unknown;
  yResolution?: unknown;
  resolutionUnit?: number | undefined;
}): TiffCalibration | undefined {
  const description = input.imageDescription ?? "";
  const ome = parseOmeXml(description);
  if (ome?.physicalSizeX) {
    const factorX = UNIT_UM[ome.unitX] ?? UNIT_UM[ome.unitX.toLowerCase()];
    const factorY = UNIT_UM[ome.unitY] ?? UNIT_UM[ome.unitY.toLowerCase()];
    if (factorX && factorY)
      return {
        umPerPxX: ome.physicalSizeX * factorX,
        umPerPxY: (ome.physicalSizeY ?? ome.physicalSizeX) * factorY,
        source: "ome",
      };
  }
  const xPerUnit = rational(input.xResolution);
  const yPerUnit = rational(input.yResolution) ?? xPerUnit;
  const imagej = parseImageJDescription(description);
  const unit = imagej?.unit?.replace(/\\u00B5/i, "µ").toLowerCase();
  const factor = unit ? UNIT_UM[unit] : undefined;
  if (factor && xPerUnit && yPerUnit && xPerUnit > 0 && yPerUnit > 0)
    return { umPerPxX: factor / xPerUnit, umPerPxY: factor / yPerUnit, source: "imagej" };
  if (input.resolutionUnit === 3 && xPerUnit && yPerUnit && xPerUnit > 0 && yPerUnit > 0)
    return { umPerPxX: 10_000 / xPerUnit, umPerPxY: 10_000 / yPerUnit, source: "tiff-resolution" };
  return undefined;
}

/** Human labels for each page, from OME or ImageJ hyperstack dimensions when they fit. */
export function tiffPlaneLabels(planes: number, description = ""): string[] {
  const ome = parseOmeXml(description);
  const imagej = parseImageJDescription(description);
  const dims = ome
    ? {
        c: ome.sizeC,
        z: ome.sizeZ,
        t: ome.sizeT,
        order: ome.dimensionOrder,
        names: ome.channelNames,
      }
    : imagej
      ? {
          c: Number(imagej.channels ?? 1),
          z: Number(imagej.slices ?? 1),
          t: Number(imagej.frames ?? 1),
          order: "XYCZT",
          names: [] as string[],
        }
      : undefined;
  if (!dims || dims.c * dims.z * dims.t !== planes || planes === 1)
    return Array.from({ length: planes }, (_, index) =>
      planes === 1 ? "Image" : `Page ${index + 1}`,
    );
  const order = dims.order.toUpperCase().replace(/^XY/, "").split("") as ("C" | "Z" | "T")[];
  const sizes = { C: dims.c, Z: dims.z, T: dims.t };
  return Array.from({ length: planes }, (_, index) => {
    const position = { C: 0, Z: 0, T: 0 };
    let rest = index;
    for (const axis of order) {
      position[axis] = rest % sizes[axis];
      rest = Math.floor(rest / sizes[axis]);
    }
    const parts: string[] = [];
    if (sizes.C > 1) {
      const name = dims.names[position.C];
      parts.push(`C${position.C + 1}${name ? ` ${name}` : ""}`);
    }
    if (sizes.Z > 1) parts.push(`Z${position.Z + 1}`);
    if (sizes.T > 1) parts.push(`T${position.T + 1}`);
    return parts.join(" · ");
  });
}

export type TiffReadOptions = ReturnType<typeof tiffReadOptions> & {
  width?: number;
  height?: number;
};
export type TiffWindowSource = {
  description: RasterDescription & Partial<TiffDescription>;
  readRasters(options: TiffReadOptions, plane?: number): Promise<Uint8Array | Uint16Array>;
};
export type TiffWindowSourceOpener = (bytes: ArrayBuffer) => Promise<TiffWindowSource>;

function numberTag(value: unknown): number {
  if (typeof value === "number") return value;
  if (
    (Array.isArray(value) || ArrayBuffer.isView(value)) &&
    typeof (value as ArrayLike<unknown>)[0] === "number"
  )
    return (value as ArrayLike<number>)[0] ?? 0;
  return 0;
}

function isBigTiff(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes);
  const littleEndian = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
  const bigEndian = view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d;
  return (littleEndian || bigEndian) && view.getUint16(2, littleEndian) === 43;
}

/**
 * Opens a TIFF for windowed reads of any of its full-resolution pages. Reduced-resolution pages
 * (pyramids, thumbnails) are skipped; the remaining pages must share one geometry.
 */
export async function openTiffWindowSource(bytes: ArrayBuffer): Promise<TiffWindowSource> {
  const tiff = await fromArrayBuffer(bytes);
  const imageCount = await tiff.getImageCount();
  const pages: Awaited<ReturnType<typeof tiff.getImage>>[] = [];
  for (let index = 0; index < imageCount; index += 1) {
    const image = await tiff.getImage(index);
    const subfileType = numberTag(image.getFileDirectory().getValue("NewSubfileType"));
    if (subfileType & 1) continue;
    pages.push(image);
    if (pages.length > MAX_TIFF_PLANES)
      throw new Error(`Unsupported TIFF: more than ${MAX_TIFF_PLANES} pages`);
  }
  const first = pages[0];
  if (!first) throw new Error("Unsupported TIFF: no full-resolution image");
  const describe = (image: typeof first) =>
    validateTiffMetadata({
      width: image.getWidth(),
      height: image.getHeight(),
      sampleFormats: Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
        image.getSampleFormat(index),
      ),
      photometricInterpretation: numberTag(
        image.getFileDirectory().getValue("PhotometricInterpretation"),
      ),
      bitsPerSample: Array.from({ length: image.getSamplesPerPixel() }, (_, index) =>
        image.getBitsPerSample(index),
      ),
      samplesPerPixel: image.getSamplesPerPixel(),
      compression: numberTag(image.getFileDirectory().getValue("Compression")),
    });
  const base = describe(first);
  for (const page of pages.slice(1)) {
    const other = describe(page);
    if (
      other.widthPx !== base.widthPx ||
      other.heightPx !== base.heightPx ||
      other.bitDepth !== base.bitDepth ||
      other.channels !== base.channels
    )
      throw new Error("Unsupported TIFF: pages differ in size or sample layout");
  }
  const directory = first.getFileDirectory();
  const imageDescription = await directory.loadValue("ImageDescription");
  const descriptionText = typeof imageDescription === "string" ? imageDescription : "";
  const calibration = tiffCalibration({
    imageDescription: descriptionText,
    xResolution: await directory.loadValue("XResolution"),
    yResolution: await directory.loadValue("YResolution"),
    resolutionUnit: numberTag(await directory.loadValue("ResolutionUnit")) || undefined,
  });
  const description: TiffDescription = {
    ...base,
    planes: pages.length,
    planeLabels: tiffPlaneLabels(pages.length, descriptionText),
    ...(calibration ? { calibration } : {}),
    ome: parseOmeXml(descriptionText) !== undefined,
    tiled: first.isTiled,
    bigTiff: isBigTiff(bytes),
  };
  return {
    description,
    async readRasters(options, plane = 0) {
      const page = pages[plane];
      if (!page) throw new Error(`TIFF page ${plane} does not exist`);
      const data = (await page.readRasters(options)) as Uint8Array | Uint16Array;
      assertTiffRasterData(data, base.bitDepth);
      return data;
    },
  };
}

function assertTiffRasterData(data: Uint8Array | Uint16Array, bitDepth: 8 | 16): void {
  if (bitDepth === 8 && !(data instanceof Uint8Array))
    throw new Error("Unsupported TIFF: decoder returned non-8-bit samples");
  if (bitDepth === 16 && !(data instanceof Uint16Array))
    throw new Error("Unsupported TIFF: decoder returned non-16-bit samples");
}

/** Decodes one whole page (the first by default) at full resolution. */
export async function decodeTiff(bytes: ArrayBuffer, plane = 0): Promise<RasterRegion> {
  const source = await openTiffWindowSource(bytes);
  const sourceRect = {
    x: 0,
    y: 0,
    width: source.description.widthPx,
    height: source.description.heightPx,
  };
  const data = await source.readRasters(tiffReadOptions(sourceRect), plane);
  return {
    data,
    sourceRect,
    widthPx: source.description.widthPx,
    heightPx: source.description.heightPx,
    bitDepth: source.description.bitDepth,
    channels: source.description.channels,
    pyramidLevel: 0,
  };
}

/** Decodes every page fully, proving each is readable; returns the shared description. */
export async function verifyTiff(bytes: ArrayBuffer): Promise<TiffDescription> {
  const source = await openTiffWindowSource(bytes);
  const description = source.description as TiffDescription;
  const window = tiffReadOptions({
    x: 0,
    y: 0,
    width: description.widthPx,
    height: description.heightPx,
  });
  for (let plane = 0; plane < description.planes; plane += 1) {
    const data = await source.readRasters(window, plane);
    if (data.length !== description.widthPx * description.heightPx * description.channels)
      throw new Error(`Unsupported TIFF: page ${plane + 1} decoded to the wrong size`);
  }
  return description;
}

export type TiffWorkerRequest =
  | { requestId: number; kind: "open"; assetId: string; bytes: ArrayBuffer }
  | {
      requestId: number;
      kind: "read";
      assetId: string;
      sourceRect: SourcePixelRect;
      pyramidLevel: number;
      plane?: number;
    }
  | { requestId: number; kind: "preview"; assetId: string; maxEdge: number; plane?: number }
  | { requestId: number; kind: "remove"; assetId: string };

export type TiffWorkerResponse =
  | { requestId: number; kind: "opened"; assetId: string; description: RasterDescription }
  | { requestId: number; kind: "region"; assetId: string; region: RasterRegion }
  | { requestId: number; kind: "removed"; assetId: string }
  | { requestId: number; kind: "error"; message: string };

export type TiffWorkerHandlerResult = {
  response: TiffWorkerResponse;
  transfer: Transferable[];
};

export function createTiffWorkerHandler(open: TiffWindowSourceOpener = openTiffWindowSource): {
  handle(request: TiffWorkerRequest): Promise<TiffWorkerHandlerResult>;
} {
  const sources = new Map<string, TiffWindowSource>();
  return {
    async handle(request) {
      try {
        if (request.kind === "open") {
          const source = await open(request.bytes);
          sources.set(request.assetId, source);
          return {
            response: {
              requestId: request.requestId,
              kind: "opened",
              assetId: request.assetId,
              description: source.description,
            },
            transfer: [],
          };
        }
        if (request.kind === "remove") {
          sources.delete(request.assetId);
          return {
            response: { requestId: request.requestId, kind: "removed", assetId: request.assetId },
            transfer: [],
          };
        }
        const source = sources.get(request.assetId);
        if (!source) throw new Error(`TIFF source ${request.assetId} is not open`);
        const sourceRect =
          request.kind === "preview"
            ? { x: 0, y: 0, width: source.description.widthPx, height: source.description.heightPx }
            : request.sourceRect;
        if (request.kind === "read" && request.pyramidLevel !== 0)
          throw new Error("TIFF pyramids are not supported");
        assertSourceRect(sourceRect, source.description);
        const previewScale =
          request.kind === "preview"
            ? Math.min(1, request.maxEdge / Math.max(sourceRect.width, sourceRect.height))
            : 1;
        const widthPx = Math.max(1, Math.round(sourceRect.width * previewScale));
        const heightPx = Math.max(1, Math.round(sourceRect.height * previewScale));
        const options: TiffReadOptions = tiffReadOptions(sourceRect);
        if (request.kind === "preview") {
          options.width = widthPx;
          options.height = heightPx;
        }
        const plane = request.plane ?? 0;
        const decoded =
          plane === 0
            ? await source.readRasters(options)
            : await source.readRasters(options, plane);
        const data = transferableRasterData(decoded);
        assertTiffRasterData(data, source.description.bitDepth);
        return {
          response: {
            requestId: request.requestId,
            kind: "region",
            assetId: request.assetId,
            region: {
              data,
              sourceRect,
              widthPx,
              heightPx,
              bitDepth: source.description.bitDepth,
              channels: source.description.channels,
              pyramidLevel: 0,
            },
          },
          transfer: [data.buffer],
        };
      } catch (error) {
        return {
          response: {
            requestId: request.requestId,
            kind: "error",
            message: error instanceof Error ? error.message : "TIFF worker failed",
          },
          transfer: [],
        };
      }
    },
  };
}

function assertSourceRect(sourceRect: SourcePixelRect, description: RasterDescription): void {
  if (
    !Number.isSafeInteger(sourceRect.x) ||
    !Number.isSafeInteger(sourceRect.y) ||
    !Number.isSafeInteger(sourceRect.width) ||
    !Number.isSafeInteger(sourceRect.height) ||
    sourceRect.x < 0 ||
    sourceRect.y < 0 ||
    sourceRect.width < 1 ||
    sourceRect.height < 1 ||
    sourceRect.x + sourceRect.width > description.widthPx ||
    sourceRect.y + sourceRect.height > description.heightPx
  ) {
    throw new Error("TIFF source region is outside the image");
  }
}

function transferableRasterData(data: Uint8Array | Uint16Array): Uint8Array | Uint16Array {
  if (data.buffer instanceof ArrayBuffer) return data;
  return data instanceof Uint8Array ? new Uint8Array(data) : new Uint16Array(data);
}
