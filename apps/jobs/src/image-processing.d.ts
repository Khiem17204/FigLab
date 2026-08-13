declare module "@figlab/image-processing" {
  export function decodeTiff(bytes: ArrayBuffer): Promise<{
    widthPx: number;
    heightPx: number;
    bitDepth: 8 | 16;
    channels: 1 | 3;
  }>;
}
