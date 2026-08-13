import {
  MAX_EXPORT_EDGE_PX,
  MAX_EXPORT_PIXELS,
  type RecordExportRequest,
  validateRecordExportRequest,
} from "@figlab/api-contract";
import type { FigureDocumentV1 } from "@figlab/figure-schema";
import { composeArtboardPng, type RasterSourceResolver } from "@figlab/image-processing";

import { sha256 } from "./client";

export type OriginalSourcePngExporter = (
  document: FigureDocumentV1,
  size: { widthPx: number; heightPx: number },
) => Promise<Blob>;

export function createArtboardPngExporter(
  artboardId: string,
  resolver: RasterSourceResolver,
): OriginalSourcePngExporter {
  return async (document, size) => {
    const png = await composeArtboardPng(
      document,
      artboardId,
      size.widthPx,
      size.heightPx,
      resolver,
    );
    return new Blob([new Uint8Array(png).buffer as ArrayBuffer], { type: "image/png" });
  };
}

export type ExportPngOptions = {
  document: FigureDocumentV1;
  revision: number;
  widthPx: number;
  heightPx: number;
  sourceExporter: OriginalSourcePngExporter;
  record: (metadata: RecordExportRequest) => Promise<void>;
  download: (blob: Blob, filename: string) => void;
};

export async function exportPng(options: ExportPngOptions): Promise<void> {
  if (
    options.widthPx < 1 ||
    options.heightPx < 1 ||
    options.widthPx > MAX_EXPORT_EDGE_PX ||
    options.heightPx > MAX_EXPORT_EDGE_PX ||
    options.widthPx * options.heightPx > MAX_EXPORT_PIXELS
  ) {
    throw new Error("Export size exceeds the FigLab PNG limit");
  }
  const blob = await options.sourceExporter(options.document, {
    widthPx: options.widthPx,
    heightPx: options.heightPx,
  });
  const metadata = {
    format: "png" as const,
    revision: options.revision,
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    checksumSha256: await sha256(blob),
  };
  if (!validateRecordExportRequest(metadata)) throw new Error("Invalid PNG export metadata");
  await options.record(metadata);
  options.download(blob, `figlab-${options.widthPx}x${options.heightPx}.png`);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
