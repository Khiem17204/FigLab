import type { ExportFormat } from "@figlab/api-contract";
import type { FigureDocument } from "@figlab/figure-schema";
import { Button, Section } from "@figlab/ui";
import { useState } from "react";

import { DEFAULT_DPI, EXPORT_DPI_CHOICES, type ExportScope, plannedExport } from "./export-figure";

export type ExportChoice = { format: ExportFormat; dpi: number; scope: ExportScope };

const FORMATS: [ExportFormat, string][] = [
  ["png", "PNG"],
  ["tiff", "TIFF"],
  ["svg", "SVG"],
  ["pdf", "PDF"],
];

/**
 * Export options. Size follows the figure's physical size at the chosen resolution; every
 * format renders image panels from original pixels.
 */
export function ExportPanel({
  document,
  activeArtboardId,
  disabled,
  onExport,
  status,
}: {
  document: FigureDocument;
  activeArtboardId: string;
  disabled?: boolean;
  onExport: (choice: ExportChoice) => Promise<void>;
  status: string;
}) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [dpiChoice, setDpiChoice] = useState<string>(String(DEFAULT_DPI));
  const [customDpi, setCustomDpi] = useState("1200");
  const [scope, setScope] = useState<ExportScope>("figure");
  const dpi = Number(dpiChoice === "custom" ? customDpi : dpiChoice);
  const validDpi = Number.isInteger(dpi) && dpi >= 1 && dpi <= 2400;
  const planned = validDpi ? plannedExport({ document, scope, activeArtboardId, dpi }) : [];
  const label = FORMATS.find(([value]) => value === format)?.[1] ?? format;
  return (
    <Section className="export-controls figure-tools-panel" label="Export" title="Export">
      <label>
        Format
        <select onChange={(event) => setFormat(event.target.value as ExportFormat)} value={format}>
          {FORMATS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Resolution
        <select onChange={(event) => setDpiChoice(event.target.value)} value={dpiChoice}>
          {EXPORT_DPI_CHOICES.map((value) => (
            <option key={value} value={value}>
              {value} dpi
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {dpiChoice === "custom" && (
        <label>
          Custom DPI
          <input
            max="2400"
            min="1"
            onChange={(event) => setCustomDpi(event.target.value)}
            type="number"
            value={customDpi}
          />
        </label>
      )}
      <fieldset>
        <legend>Figures</legend>
        <label className="inline">
          <input
            checked={scope === "figure"}
            name="export-scope"
            onChange={() => setScope("figure")}
            type="radio"
          />
          This figure
        </label>
        <label className="inline">
          <input
            checked={scope === "all"}
            name="export-scope"
            onChange={() => setScope("all")}
            type="radio"
          />
          All figures{format === "pdf" ? " (one page each)" : " (zip)"}
        </label>
      </fieldset>
      <p>
        {planned
          .map(({ artboard, widthPx, heightPx }) =>
            format === "pdf" || format === "svg"
              ? `${artboard.name}: vector page, image panels at ${dpi} dpi`
              : `${artboard.name}: ${widthPx} × ${heightPx} px`,
          )
          .join("; ")}
      </p>
      <Button
        disabled={disabled || !validDpi || planned.length === 0}
        onClick={() => void onExport({ format, dpi, scope })}
      >
        Export {label}
      </Button>
      <p role="status">{status}</p>
    </Section>
  );
}
