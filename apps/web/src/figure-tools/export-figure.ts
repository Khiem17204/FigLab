import type { ExportFormat, RecordExportRequest } from "@figlab/api-contract";
import type { FigureDocument } from "@figlab/figure-schema";
import {
  composeArtboardPng,
  composeArtboardSvg,
  composeArtboardTiff,
  exportPixelSize,
  type RasterSourceResolver,
  type VectorRasterizer,
  validateExportDimensions,
} from "@figlab/image-processing";
import { zipSync } from "fflate";

import { sha256 } from "../api/client";
import type { FigureFonts } from "./fonts";

export const EXPORT_DPI_CHOICES = [72, 150, 300, 600] as const;
export const DEFAULT_DPI = 300;

export type ExportScope = "figure" | "all";
export type ExportRequest = {
  format: ExportFormat;
  dpi: number;
  scope: ExportScope;
  /** The exact saved document and revision; exports never render unsaved state. */
  document: FigureDocument;
  revision: number;
  activeArtboardId: string;
  projectName: string;
};
export type ExportDependencies = {
  resolver: RasterSourceResolver;
  fonts: FigureFonts;
  rasterize: VectorRasterizer;
  record: (metadata: RecordExportRequest) => Promise<void>;
  download: (blob: Blob, filename: string) => void;
  /** Loads pdf-lib on demand. */
  composePdf?: typeof import("@figlab/image-processing/vector").composeDocumentPdf;
};

const MIME: Record<ExportFormat, string> = {
  png: "image/png",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};
const EXTENSION: Record<ExportFormat, string> = { png: "png", tiff: "tif", svg: "svg", pdf: "pdf" };

export function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .toLowerCase()
      .slice(0, 60) || "figure"
  );
}

/** The files an export will produce, so the dialog can show their size before rendering. */
export function plannedExport(
  request: Pick<ExportRequest, "document" | "scope" | "activeArtboardId" | "dpi">,
) {
  const artboards =
    request.scope === "all"
      ? request.document.artboards
      : request.document.artboards.filter((artboard) => artboard.id === request.activeArtboardId);
  return artboards.map((artboard) => ({ artboard, ...exportPixelSize(artboard, request.dpi) }));
}

/**
 * Renders the requested figures from original pixels, records each export against the saved
 * revision, then downloads one file (or a zip when several raster/SVG files are produced).
 */
export async function exportFigures(
  request: ExportRequest,
  dependencies: ExportDependencies,
): Promise<{ filename: string; figures: number }> {
  const planned = plannedExport(request);
  if (planned.length === 0) throw new Error("There is no figure to export");
  const base = slug(request.projectName);
  const { metrics, faces } = dependencies.fonts;
  const files: { name: string; bytes: Uint8Array; records: RecordExportRequest[] }[] = [];

  if (request.format === "pdf") {
    const composePdf =
      dependencies.composePdf ??
      (await import("@figlab/image-processing/vector")).composeDocumentPdf;
    const bytes = await composePdf(
      request.document,
      planned.map(({ artboard }) => artboard.id),
      {
        dpi: request.dpi,
        resolver: dependencies.resolver,
        metrics,
        fonts: faces,
        title: request.projectName,
      },
    );
    files.push({
      name: `${base}${planned.length === 1 ? `-${slug(planned[0]?.artboard.name ?? "")}` : ""}.pdf`,
      bytes,
      records: [],
    });
  } else {
    for (const { artboard, widthPx, heightPx } of planned) {
      if (request.format !== "svg") validateExportDimensions(widthPx, heightPx);
      const options = { metrics, rasterizeVector: dependencies.rasterize, dpi: request.dpi };
      const bytes =
        request.format === "png"
          ? await composeArtboardPng(
              request.document,
              artboard.id,
              widthPx,
              heightPx,
              dependencies.resolver,
              options,
            )
          : request.format === "tiff"
            ? await composeArtboardTiff(
                request.document,
                artboard.id,
                widthPx,
                heightPx,
                dependencies.resolver,
                options,
              )
            : new TextEncoder().encode(
                await composeArtboardSvg(request.document, artboard.id, {
                  dpi: request.dpi,
                  resolver: dependencies.resolver,
                  metrics,
                  fonts: faces,
                }),
              );
      files.push({
        name: `${base}-${slug(artboard.name)}-${request.dpi}dpi.${EXTENSION[request.format]}`,
        bytes,
        records: [],
      });
    }
  }

  // Each figure gets an export record carrying the checksum of the file it was written into.
  for (const [index, file] of files.entries()) {
    const checksumSha256 = await sha256(new Blob([file.bytes as BlobPart]));
    const covered = request.format === "pdf" ? planned : [planned[index]];
    for (const entry of covered) {
      if (!entry) continue;
      await dependencies.record({
        format: request.format,
        artboardId: entry.artboard.id,
        dpi: request.dpi,
        revision: request.revision,
        widthPx: entry.widthPx,
        heightPx: entry.heightPx,
        checksumSha256,
      });
    }
  }

  if (files.length === 1) {
    const [file] = files;
    if (!file) throw new Error("Export produced no file");
    dependencies.download(
      new Blob([file.bytes as BlobPart], { type: MIME[request.format] }),
      file.name,
    );
    return { filename: file.name, figures: planned.length };
  }
  const zip = zipSync(Object.fromEntries(files.map((file) => [file.name, file.bytes])), {
    level: 0,
  });
  const filename = `${base}-figures-${request.dpi}dpi-${request.format}.zip`;
  dependencies.download(new Blob([zip as BlobPart], { type: "application/zip" }), filename);
  return { filename, figures: planned.length };
}
