export const MAX_RASTER_PIXELS = 100_000_000;
export const MAX_EXPORT_EDGE_PX = 16_384;
export const MAX_EXPORT_PIXELS = 100_000_000;

export type RasterChannelCount = 1 | 3 | 4;
export type RasterDescription = {
  widthPx: number;
  heightPx: number;
  bitDepth: 8 | 16;
  channels: RasterChannelCount;
  /** Pages of a multi-page TIFF; 1 when absent. */
  planes?: number;
};
export type SourcePixelRect = { x: number; y: number; width: number; height: number };
export type RasterRegion = {
  data: Uint8Array | Uint16Array;
  sourceRect: SourcePixelRect;
  widthPx: number;
  heightPx: number;
  bitDepth: 8 | 16;
  channels: RasterChannelCount;
  pyramidLevel: number;
};

export interface RasterSourceResolver {
  describe(assetId: string): Promise<RasterDescription>;
  /** Reads a window of one plane (page) of an original; plane 0 is the first page. */
  getRegion(
    assetId: string,
    sourceRect: SourcePixelRect,
    pyramidLevel?: number,
    plane?: number,
  ): Promise<RasterRegion>;
}

export type BrowserRasterDecoder = {
  decode(bytes: ArrayBuffer, mimeType: "image/png" | "image/jpeg"): Promise<RasterRegion>;
};
