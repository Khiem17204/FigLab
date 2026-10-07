import type {
  AssetDescriptor,
  IntegrityReportSummary,
  RecordExportRequest,
} from "@figlab/api-contract";
import {
  type FigureDocument,
  IDENTITY_DISPLAY_V3,
  type ImagePanelObject,
  isImagePanel,
} from "@figlab/figure-schema";
import {
  type AssetFacts,
  buildIntegrityReport,
  buildUncroppedSheet,
  cropsCsv,
  documentSourceSizes,
  exportPixelSize,
  type IntegrityReport,
  integrityReportHtml,
  type RasterSourceResolver,
} from "@figlab/image-processing";
import { Button, Section } from "@figlab/ui";
import { strToU8, zipSync } from "fflate";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { type FigLabClient, sha256 } from "../api/client";
import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState } from "../editor/session-store";
import { slug } from "./export-figure";
import type { FigureFonts } from "./fonts";

export function assetFacts(assets: ReadonlyArray<AssetDescriptor>): Map<string, AssetFacts> {
  return new Map(
    assets.map((asset) => [
      asset.id,
      {
        filename: asset.filename,
        checksumSha256: asset.checksumSha256,
        ...(Array.isArray(asset.metadata.planeLabels)
          ? { planeLabels: asset.metadata.planeLabels as string[] }
          : {}),
      },
    ]),
  );
}

/**
 * Everything a reviewer or journal might ask for, for one saved revision: the figures as PDF,
 * the exact document, the integrity report (JSON and HTML), crop coordinates as CSV, and the
 * uncropped originals with each crop outlined.
 */
export async function buildProvenanceBundle(input: {
  document: FigureDocument;
  revision: number;
  projectName: string;
  resolver: RasterSourceResolver;
  assets: ReadonlyMap<string, AssetFacts>;
  fonts: FigureFonts;
  dpi: number;
  record: (metadata: RecordExportRequest) => Promise<void>;
  composePdf?: typeof import("@figlab/image-processing/vector").composeDocumentPdf;
}): Promise<{ zip: Uint8Array; report: IntegrityReport }> {
  const sizes = documentSourceSizes(input.document, input.resolver);
  const composePdf =
    input.composePdf ?? (await import("@figlab/image-processing/vector")).composeDocumentPdf;
  const report = await buildIntegrityReport({
    document: input.document,
    revision: input.revision,
    projectName: input.projectName,
    resolver: input.resolver,
    sizes,
    assets: input.assets,
  });
  const pdfOptions = {
    dpi: input.dpi,
    resolver: input.resolver,
    metrics: input.fonts.metrics,
    fonts: input.fonts.faces,
  };
  const figures = await composePdf(
    input.document,
    input.document.artboards.map((artboard) => artboard.id),
    { ...pdfOptions, title: input.projectName },
  );
  const sheet = await buildUncroppedSheet(input.document, sizes, input.assets);
  const originals = await composePdf(
    sheet,
    sheet.artboards.map((artboard) => artboard.id),
    { ...pdfOptions, title: `${input.projectName} — uncropped originals` },
  );
  const checksumSha256 = await sha256(new Blob([figures as BlobPart]));
  for (const artboard of input.document.artboards)
    await input.record({
      format: "pdf",
      artboardId: artboard.id,
      dpi: input.dpi,
      revision: input.revision,
      ...exportPixelSize(artboard, input.dpi),
      checksumSha256,
    });
  const readme = [
    `FigLab provenance bundle — ${input.projectName}, revision ${input.revision}`,
    `Generated ${report.generatedAt}.`,
    "",
    "figures.pdf                One page per figure, image panels rendered from original pixels.",
    "figure.json                The exact saved figure document (crops, adjustments, layout).",
    "integrity-report.json/.html Per-panel crop coordinates, adjustments, and findings.",
    "crops.csv                  The same crop facts as a table.",
    "uncropped-originals.pdf    Each original with every crop outlined and labelled.",
    "",
    `figures.pdf SHA-256: ${checksumSha256}`,
    "",
    "Suggested legend text:",
    report.legendText,
  ].join("\n");
  const zip = zipSync(
    {
      "README.txt": strToU8(readme),
      "figure.json": strToU8(JSON.stringify(input.document, null, 2)),
      "integrity-report.json": strToU8(JSON.stringify(report, null, 2)),
      "integrity-report.html": strToU8(integrityReportHtml(report)),
      "crops.csv": strToU8(cropsCsv(report)),
      "figures.pdf": figures,
      "uncropped-originals.pdf": originals,
    },
    { level: 6 },
  );
  return { zip, report };
}

function Findings({ report }: { report: IntegrityReport }) {
  return (
    <div>
      <p>
        <strong>Suggested legend:</strong> {report.legendText}
      </p>
      <ul className="history-list" aria-label="Integrity findings">
        {report.findings.map((finding) => (
          <li key={`${finding.code}-${finding.message}`}>
            <strong>{finding.severity}</strong> {finding.message}
          </li>
        ))}
        {report.panels.flatMap((panel) =>
          panel.findings.map((finding) => (
            <li key={`${panel.objectId}-${finding.code}`}>
              <strong>{finding.severity}</strong> {panel.label ? `Panel ${panel.label}` : "A panel"}
              : {finding.message}
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

/** Integrity checks, server reports, original-vs-figure comparison, and the provenance bundle. */
export function IntegrityPanel({
  session,
  client,
  projectId,
  projectName,
  assets,
  rasterSources,
  fonts,
  saveExact,
  download,
}: {
  session: StoreApi<EditorSessionState>;
  client: FigLabClient;
  projectId: string;
  projectName: string;
  assets: ReadonlyArray<AssetDescriptor>;
  rasterSources: BrowserRasterRepository;
  fonts: FigureFonts | undefined;
  saveExact: () => Promise<{ document: FigureDocument; revision: number } | undefined>;
  download: (blob: Blob, filename: string) => void;
}) {
  const state = useStore(session);
  const [report, setReport] = useState<IntegrityReport>();
  const [serverReports, setServerReports] = useState<IntegrityReportSummary[]>([]);
  const [status, setStatus] = useState("");
  const [comparison, setComparison] = useState<{ original: string; figure: string }>();
  const selectedPanel = state.document.objects.find(
    (object): object is ImagePanelObject =>
      isImagePanel(object) && state.selectedIds.includes(object.id),
  );

  const refreshServerReports = useCallback(async () => {
    try {
      setServerReports(await client.listIntegrityReports(projectId));
    } catch {
      // The list is optional; checks still run in the browser.
    }
  }, [client, projectId]);
  useEffect(() => {
    void refreshServerReports();
  }, [refreshServerReports]);

  const saved = async () => {
    const result = await saveExact();
    if (!result) setStatus("Save the project first; your local work is kept.");
    return result;
  };

  return (
    <Section className="figure-tools-panel" label="Integrity" title="Integrity">
      <Button
        onClick={async () => {
          setStatus("Checking panels against their originals…");
          try {
            const current = await saved();
            if (!current) return;
            setReport(
              await buildIntegrityReport({
                document: current.document,
                revision: current.revision,
                projectName,
                resolver: rasterSources,
                sizes: documentSourceSizes(current.document, rasterSources),
                assets: assetFacts(assets),
              }),
            );
            setStatus(`Checked revision ${current.revision}.`);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "The check failed.");
          }
        }}
      >
        Check integrity
      </Button>
      <Button
        onClick={async () => {
          try {
            const current = await saved();
            if (!current) return;
            await client.requestIntegrityReport(projectId, current.revision);
            setStatus("Server report requested; it appears below when ready.");
            await refreshServerReports();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "The request failed.");
          }
        }}
      >
        Request server report
      </Button>
      <Button
        disabled={!fonts}
        onClick={async () => {
          if (!fonts) return;
          setStatus("Building the provenance bundle from original pixels…");
          try {
            const current = await saved();
            if (!current) return;
            const { zip, report: built } = await buildProvenanceBundle({
              document: current.document,
              revision: current.revision,
              projectName,
              resolver: rasterSources,
              assets: assetFacts(assets),
              fonts,
              dpi: 300,
              record: (metadata) => client.recordExport(projectId, metadata),
            });
            setReport(built);
            const filename = `${slug(projectName)}-provenance-r${current.revision}.zip`;
            download(new Blob([zip as BlobPart], { type: "application/zip" }), filename);
            setStatus(`${filename} downloaded.`);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "The bundle could not be built.");
          }
        }}
      >
        Download provenance bundle
      </Button>
      {selectedPanel && (
        <Button
          onClick={async () => {
            const sizes = documentSourceSizes(state.document, rasterSources);
            const raw: ImagePanelObject =
              selectedPanel.type === "image-view"
                ? {
                    ...selectedPanel,
                    view: { ...selectedPanel.view, display: { ...IDENTITY_DISPLAY_V3 } },
                  }
                : {
                    ...selectedPanel,
                    composite: {
                      ...selectedPanel.composite,
                      channels: selectedPanel.composite.channels.map((channel) => ({
                        ...channel,
                        display: { ...IDENTITY_DISPLAY_V3, lut: channel.display.lut },
                      })),
                    },
                  };
            setComparison({
              original: await rasterSources.getPanelPreviewUrl(raw, sizes, 512),
              figure: await rasterSources.getPanelPreviewUrl(selectedPanel, sizes, 512),
            });
          }}
        >
          Compare with original
        </Button>
      )}
      {comparison && (
        <fieldset aria-label="Original and figure comparison" className="comparison">
          <figure>
            <img alt="Original pixels without adjustments" src={comparison.original} />
            <figcaption>Original (no adjustments)</figcaption>
          </figure>
          <figure>
            <img alt="As shown in the figure" src={comparison.figure} />
            <figcaption>As shown in the figure</figcaption>
          </figure>
        </fieldset>
      )}
      {status && <p role="status">{status}</p>}
      {report && <Findings report={report} />}
      {serverReports.length > 0 && (
        <>
          <h4>Server reports</h4>
          <ol className="history-list" aria-label="Server reports">
            {serverReports.map((entry) => (
              <li key={entry.id}>
                Revision {entry.revision} · {entry.status}
                {entry.error ? ` · ${entry.error}` : ""}
                {entry.status === "ready" && (
                  <Button
                    onClick={async () => {
                      const full = await client.getIntegrityReport(projectId, entry.id);
                      setReport(full.report as IntegrityReport);
                    }}
                  >
                    {`Open report for revision ${entry.revision}`}
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <Button onClick={() => void refreshServerReports()}>Refresh server reports</Button>
        </>
      )}
    </Section>
  );
}
