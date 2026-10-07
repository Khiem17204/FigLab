import type { FigureDocumentV1 } from "@figlab/figure-schema";
import { Field, Input, Section, Segmented } from "@figlab/ui";

export type ExportScale = "1" | "2" | "custom";

export function exportDimensions(
  artboard: FigureDocumentV1["artboards"][number] | undefined,
  scale: ExportScale,
  customWidth: string,
): { width: number; height: number; valid: boolean } {
  const width =
    scale === "custom" ? Number(customWidth) : Math.round((artboard?.widthPt ?? 0) * Number(scale));
  const height = Math.round(width * ((artboard?.heightPt ?? 0) / (artboard?.widthPt ?? 1)));
  return {
    width,
    height,
    valid: !!artboard && Number.isFinite(width) && width >= 1 && height >= 1,
  };
}

/** PNG export settings. The "Export PNG" action lives in the editor toolbar. */
export function ExportSection({
  scale,
  customWidth,
  width,
  height,
  valid,
  status,
  statusTone = "info",
  onScaleChange,
  onCustomWidthChange,
}: {
  scale: ExportScale;
  customWidth: string;
  width: number;
  height: number;
  valid: boolean;
  status: string;
  statusTone?: "info" | "success" | "error";
  onScaleChange: (scale: ExportScale) => void;
  onCustomWidthChange: (value: string) => void;
}) {
  return (
    <Section title="Export">
      <Segmented
        block
        label="PNG scale"
        onChange={onScaleChange}
        options={[
          { value: "1", label: "1×" },
          { value: "2", label: "2×" },
          { value: "custom", label: "Custom" },
        ]}
        value={scale}
      />
      {scale === "custom" && (
        <Field label="Custom width" hint="Height follows the artboard's aspect ratio.">
          <Input
            min="1"
            onChange={(event) => onCustomWidthChange(event.target.value)}
            size="sm"
            type="number"
            value={customWidth}
          />
        </Field>
      )}
      <p className="export-dims fl-mono">
        {valid ? `${width} × ${height} px · 8-bit PNG` : "Enter a width of at least 1 px"}
      </p>
      <p className="export-note">Rendered from the original samples, not the preview.</p>
      {status && (
        <p className="export-status" data-tone={statusTone} role="status">
          {status}
        </p>
      )}
    </Section>
  );
}
