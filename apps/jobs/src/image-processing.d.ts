declare module "@figlab/image-processing" {
  export type TiffDescription = {
    widthPx: number;
    heightPx: number;
    bitDepth: 8 | 16;
    channels: 1 | 3;
    planes: number;
    planeLabels: string[];
    calibration?: {
      umPerPxX: number;
      umPerPxY: number;
      source: "imagej" | "ome" | "tiff-resolution";
    };
    ome: boolean;
    tiled: boolean;
    bigTiff: boolean;
  };
  /** Decodes every page, proving the whole original is readable. */
  export function verifyTiff(bytes: ArrayBuffer): Promise<TiffDescription>;
}
