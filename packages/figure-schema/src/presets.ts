export const POINTS_PER_INCH = 72;
export const MILLIMETERS_PER_INCH = 25.4;

export const mmToPt = (mm: number): number => (mm * POINTS_PER_INCH) / MILLIMETERS_PER_INCH;
export const ptToMm = (pt: number): number => (pt * MILLIMETERS_PER_INCH) / POINTS_PER_INCH;

export type ArtboardSizePreset = {
  id: string;
  label: string;
  widthMm: number;
  /** Fixed page height, or undefined when only the width is prescribed. */
  heightMm?: number;
  /** Journal maximum figure height, when the guide states one. */
  maxHeightMm?: number;
  source?: string;
};

/**
 * Figure widths from each journal's author guide (checked 2026-10-06). Journals revise these;
 * the `source` link is the authority, and users can always enter a custom size.
 */
export const ARTBOARD_SIZE_PRESETS: readonly ArtboardSizePreset[] = [
  { id: "us-letter", label: "US Letter (portrait)", widthMm: 215.9, heightMm: 279.4 },
  { id: "a4", label: "A4 (portrait)", widthMm: 210, heightMm: 297 },
  ...[
    ["single", "single column", 89],
    ["one-and-half", "1.5 column", 120],
    ["double", "double column", 183],
  ].map(([id, label, widthMm]) => ({
    id: `nature-${id}`,
    label: `Nature — ${label}`,
    widthMm: Number(widthMm),
    maxHeightMm: 170,
    source:
      "https://research-figure-guide.nature.com/figures/building-and-exporting-figure-panels/",
  })),
  ...[
    ["single", "single column", 85],
    ["one-and-half", "1.5 column", 114],
    ["full", "full width", 174],
  ].map(([id, label, widthMm]) => ({
    id: `cell-${id}`,
    label: `Cell Press — ${label}`,
    widthMm: Number(widthMm),
    source: "https://www.cell.com/information-for-authors/figure-guidelines",
  })),
  ...[
    ["single", "1 column", 87],
    ["one-and-half", "1.5 column", 114],
    ["double", "2 column", 178],
  ].map(([id, label, widthMm]) => ({
    id: `pnas-${id}`,
    label: `PNAS — ${label}`,
    widthMm: Number(widthMm),
    source: "https://www.pnas.org/author-center/submitting-your-manuscript#digital-art",
  })),
  ...[
    ["column", "text column", 132],
    ["max", "maximum width", 190.5],
  ].map(([id, label, widthMm]) => ({
    id: `plos-${id}`,
    label: `PLOS — ${label}`,
    widthMm: Number(widthMm),
    maxHeightMm: 222.3,
    source: "https://journals.plos.org/plosone/s/figures",
  })),
];

/** Resolves a preset to points. Width-only presets keep the given height within the maximum. */
export function presetSizePt(
  preset: ArtboardSizePreset,
  currentHeightPt: number,
): { widthPt: number; heightPt: number } {
  const widthPt = mmToPt(preset.widthMm);
  if (preset.heightMm !== undefined) return { widthPt, heightPt: mmToPt(preset.heightMm) };
  const maxHeightPt = preset.maxHeightMm === undefined ? Infinity : mmToPt(preset.maxHeightMm);
  return { widthPt, heightPt: Math.min(currentHeightPt, maxHeightPt) };
}
