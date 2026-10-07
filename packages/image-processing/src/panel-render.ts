import type {
  CompositeObjectV3,
  DisplayTransformV3,
  FigureDocument,
  ImagePanelObject,
  ImageViewObjectV3,
  LutV3,
  NormalizedRect,
} from "@figlab/figure-schema";
import type { RasterRegion, RasterSourceResolver, SourcePixelRect } from "./raster.js";

export type CropGeometry = {
  viewport: NormalizedRect;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
};
export type PixelSize = { widthPx: number; heightPx: number };
/** A source's recorded size, from the document's registry or the resolver. */
export type SourceSizes = (assetId: string) => Promise<PixelSize>;

export const LUT_RGB: Record<Exclude<LutV3, "none">, readonly [number, number, number]> = {
  gray: [1, 1, 1],
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  cyan: [0, 1, 1],
  magenta: [1, 0, 1],
  yellow: [1, 1, 0],
};

/**
 * Maps a normalized sample through the v3 display pipeline: levels first, then the v1
 * contrast → brightness → clamp → gamma → invert sequence. Identity levels reproduce v1 exactly.
 */
export function applyDisplayV3(normalized: number, display: DisplayTransformV3): number {
  const { black, white } = display.levels;
  const span = white - black;
  const leveled =
    span <= 0
      ? normalized >= white
        ? 1
        : 0
      : Math.min(1, Math.max(0, (normalized - black) / span));
  const contrasted = (leveled - 0.5) * display.contrast + 0.5;
  const clamped = Math.min(1, Math.max(0, contrasted + display.brightness));
  const corrected = clamped ** (1 / display.gamma);
  return display.invert ? 1 - corrected : corrected;
}

/** Rec. 709 luma, used when a LUT is applied to a multi-sample pixel without a chosen channel. */
export const luminance = (red: number, green: number, blue: number) =>
  0.2126 * red + 0.7152 * green + 0.0722 * blue;

function cropCenterAndSize(crop: CropGeometry, size: PixelSize) {
  const width = crop.viewport.width * size.widthPx;
  const height = crop.viewport.height * size.heightPx;
  return {
    cx: (crop.viewport.x + crop.viewport.width / 2) * size.widthPx,
    cy: (crop.viewport.y + crop.viewport.height / 2) * size.heightPx,
    width,
    height,
    radians: (crop.rotationDeg * Math.PI) / 180,
  };
}

/** A point in panel space (fractions of the panel box) to continuous source pixel coordinates. */
export function panelToSourcePx(
  crop: CropGeometry,
  size: PixelSize,
  s: number,
  t: number,
): { x: number; y: number } {
  const { cx, cy, width, height, radians } = cropCenterAndSize(crop, size);
  const dx = ((crop.flipX ? 1 - s : s) - 0.5) * width;
  const dy = ((crop.flipY ? 1 - t : t) - 0.5) * height;
  return {
    x: cx + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: cy + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

/** The inverse of `panelToSourcePx`: where a source point appears in the panel box. */
export function sourcePxToPanel(
  crop: CropGeometry,
  size: PixelSize,
  x: number,
  y: number,
): { s: number; t: number } {
  const { cx, cy, width, height, radians } = cropCenterAndSize(crop, size);
  const rx = (x - cx) * Math.cos(radians) + (y - cy) * Math.sin(radians);
  const ry = -(x - cx) * Math.sin(radians) + (y - cy) * Math.cos(radians);
  const s = rx / width + 0.5;
  const t = ry / height + 0.5;
  return { s: crop.flipX ? 1 - s : s, t: crop.flipY ? 1 - t : t };
}

/**
 * The integer source window a crop reads. Axis-aligned crops floor their left/top and ceil
 * their right/bottom (the v1 rule); rotated crops read their clamped bounding box.
 */
export function cropSourceRect(crop: CropGeometry, size: PixelSize): SourcePixelRect {
  if (crop.rotationDeg === 0) {
    const x = Math.floor(crop.viewport.x * size.widthPx);
    const y = Math.floor(crop.viewport.y * size.heightPx);
    const right = Math.ceil((crop.viewport.x + crop.viewport.width) * size.widthPx);
    const bottom = Math.ceil((crop.viewport.y + crop.viewport.height) * size.heightPx);
    return { x, y, width: right - x, height: bottom - y };
  }
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([s = 0, t = 0]) => panelToSourcePx(crop, size, s, t));
  const left = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
  const right = Math.min(size.widthPx, Math.ceil(Math.max(...corners.map((point) => point.x))));
  const bottom = Math.min(size.heightPx, Math.ceil(Math.max(...corners.map((point) => point.y))));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** The size of a crop in source pixels (before rotation), for aspect ratios and scale. */
export function cropSizePx(crop: CropGeometry, size: PixelSize): PixelSize {
  if (crop.rotationDeg === 0) {
    const rect = cropSourceRect(crop, size);
    return { widthPx: rect.width, heightPx: rect.height };
  }
  return {
    widthPx: crop.viewport.width * size.widthPx,
    heightPx: crop.viewport.height * size.heightPx,
  };
}

/** Returns RGBA (0–255, non-premultiplied) for a cell of a panel divided into columns × rows. */
export type PanelSampler = (column: number, columns: number, row: number, rows: number) => Rgba;
export type Rgba = [number, number, number, number];

type Reading = { channel: number | null; display: DisplayTransformV3; region: RasterRegion };

const maxSample = (region: RasterRegion) => (region.bitDepth === 8 ? 255 : 65_535);

function samplesAt(region: RasterRegion, x: number, y: number, out: number[]): void {
  const localX = Math.min(region.widthPx - 1, Math.max(0, x - region.sourceRect.x));
  const localY = Math.min(region.heightPx - 1, Math.max(0, y - region.sourceRect.y));
  const index = (localY * region.widthPx + localX) * region.channels;
  const max = maxSample(region);
  for (let channel = 0; channel < region.channels; channel += 1)
    out[channel] = (region.data[index + channel] ?? 0) / max;
}

/** Bilinear interpolation of raw samples at continuous source coordinates (pixel edges at integers). */
function bilinearAt(region: RasterRegion, x: number, y: number, out: number[]): void {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const corner: number[][] = [[], [], [], []];
  samplesAt(region, x0, y0, corner[0] as number[]);
  samplesAt(region, x0 + 1, y0, corner[1] as number[]);
  samplesAt(region, x0, y0 + 1, corner[2] as number[]);
  samplesAt(region, x0 + 1, y0 + 1, corner[3] as number[]);
  for (let channel = 0; channel < region.channels; channel += 1) {
    const [a = [], b = [], c = [], d = []] = corner;
    const top = (a[channel] ?? 0) * (1 - ax) + (b[channel] ?? 0) * ax;
    const bottom = (c[channel] ?? 0) * (1 - ax) + (d[channel] ?? 0) * ax;
    out[channel] = top * (1 - ay) + bottom * ay;
  }
}

/** Turns raw normalized samples into displayed RGBA (0–1) for one reading of a source. */
function displayed(samples: number[], reading: Reading): [number, number, number, number] {
  const { region, display, channel } = reading;
  if (channel !== null) {
    if (channel >= region.channels)
      throw new Error(`Channel ${channel} does not exist in a ${region.channels}-sample source`);
    return colorize(applyDisplayV3(samples[channel] ?? 0, display), display.lut);
  }
  if (region.channels === 1) return colorize(applyDisplayV3(samples[0] ?? 0, display), display.lut);
  const [red = 0, green = 0, blue = 0, alpha = 1] = samples;
  if (display.lut !== "none")
    return colorize(applyDisplayV3(luminance(red, green, blue), display), display.lut);
  return [
    applyDisplayV3(red, display),
    applyDisplayV3(green, display),
    applyDisplayV3(blue, display),
    region.channels === 4 ? alpha : 1,
  ];
}

function colorize(value: number, lut: LutV3): [number, number, number, number] {
  if (lut === "none") return [value, value, value, 1];
  const [r, g, b] = LUT_RGB[lut];
  return [value * r, value * g, value * b, 1];
}

function createReadingSampler(
  readings: Reading[],
  crop: CropGeometry,
  size: PixelSize,
  additive: boolean,
): PanelSampler {
  const raw: number[] = [];
  const rect = readings[0]?.region.sourceRect;
  if (!rect) throw new Error("A panel needs at least one source reading");
  return (column, columns, row, rows) => {
    let x: number;
    let y: number;
    const rotated = crop.rotationDeg !== 0;
    if (!rotated) {
      // The v1 nearest-neighbour index rule, so axis-aligned crops keep exact source samples.
      let ix = Math.min(rect.width - 1, Math.max(0, Math.floor((column / columns) * rect.width)));
      let iy = Math.min(rect.height - 1, Math.max(0, Math.floor((row / rows) * rect.height)));
      if (crop.flipX) ix = rect.width - 1 - ix;
      if (crop.flipY) iy = rect.height - 1 - iy;
      x = rect.x + ix;
      y = rect.y + iy;
    } else {
      const point = panelToSourcePx(crop, size, (column + 0.5) / columns, (row + 0.5) / rows);
      x = point.x;
      y = point.y;
    }
    const out: Rgba = [0, 0, 0, 0];
    for (const reading of readings) {
      if (rotated) bilinearAt(reading.region, x, y, raw);
      else samplesAt(reading.region, x, y, raw);
      const [r, g, b, a] = displayed(raw, reading);
      if (additive) {
        out[0] += r;
        out[1] += g;
        out[2] += b;
        out[3] = 1;
      } else {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        out[3] = a;
      }
    }
    return [
      Math.round(Math.min(1, out[0]) * 255),
      Math.round(Math.min(1, out[1]) * 255),
      Math.round(Math.min(1, out[2]) * 255),
      Math.round(Math.min(1, out[3]) * 255),
    ];
  };
}

/** Source sizes from the document's registry, falling back to the resolver. */
export function documentSourceSizes(
  document: Pick<FigureDocument, "sources">,
  resolver: Pick<RasterSourceResolver, "describe">,
): SourceSizes {
  const recorded = new Map(document.sources.map((source) => [source.assetId, source]));
  return async (assetId) => {
    const source = recorded.get(assetId);
    if (source) return { widthPx: source.widthPx, heightPx: source.heightPx };
    const description = await resolver.describe(assetId);
    return { widthPx: description.widthPx, heightPx: description.heightPx };
  };
}

export function panelCrop(object: ImagePanelObject): CropGeometry {
  return object.type === "image-view" ? object.view : object.composite;
}

/** Reads the source windows a panel needs and returns its sampler. */
export async function createPanelSampler(
  object: ImageViewObjectV3 | CompositeObjectV3,
  resolver: RasterSourceResolver,
  sizes: SourceSizes,
): Promise<PanelSampler> {
  if (object.type === "image-view") {
    const size = await sizes(object.view.sourceAssetId);
    const region = await resolver.getRegion(
      object.view.sourceAssetId,
      cropSourceRect(object.view, size),
      0,
      object.view.plane,
    );
    return createReadingSampler(
      [{ channel: object.view.channel, display: object.view.display, region }],
      object.view,
      size,
      false,
    );
  }
  const visible = object.composite.channels.filter((channel) => channel.visible);
  const first = visible[0] ?? object.composite.channels[0];
  if (!first) throw new Error("A composite needs a channel");
  const size = await sizes(first.sourceAssetId);
  const rect = cropSourceRect(object.composite, size);
  const readings = await Promise.all(
    (visible.length > 0 ? visible : []).map(async (channel) => ({
      channel: channel.channel,
      display: {
        ...channel.display,
        lut: channel.display.lut === "none" ? ("gray" as const) : channel.display.lut,
      },
      region: await resolver.getRegion(channel.sourceAssetId, rect, 0, channel.plane),
    })),
  );
  if (readings.length === 0) return () => [0, 0, 0, 255];
  return createReadingSampler(readings, object.composite, size, true);
}

/** Renders a panel alone at an exact pixel size (transparent where the source is transparent). */
export async function renderPanelRgba(
  object: ImageViewObjectV3 | CompositeObjectV3,
  widthPx: number,
  heightPx: number,
  resolver: RasterSourceResolver,
  sizes: SourceSizes,
): Promise<Uint8Array> {
  const sampler = await createPanelSampler(object, resolver, sizes);
  const rgba = new Uint8Array(widthPx * heightPx * 4);
  for (let row = 0; row < heightPx; row += 1)
    for (let column = 0; column < widthPx; column += 1)
      rgba.set(sampler(column, widthPx, row, heightPx), (row * widthPx + column) * 4);
  return rgba;
}
