import {
  type DisplayTransformV3,
  type FigureDocument,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
  type ImagePanelObject,
  isImagePanel,
  type SampleInfoV3,
} from "@figlab/figure-schema";
import { cropKDaRange, isLoadingControl } from "./mw.js";
import { cropSourceRect, luminance, panelCrop, type SourceSizes } from "./panel-render.js";
import type { RasterRegion, RasterSourceResolver, SourcePixelRect } from "./raster.js";

export const INTEGRITY_REPORT_SCHEMA = "figlab-integrity-report/1";

/**
 * `disclose`: a legitimate change journals ask authors to state in the legend.
 * `warn`: something reviewers commonly question (non-linear mapping, clipping, saturation).
 */
export type IntegrityFinding = {
  severity: "info" | "disclose" | "warn";
  code: string;
  message: string;
};

export type SourceReadingIntegrity = {
  assetId: string;
  filename?: string;
  checksumSha256?: string;
  plane: number;
  planeLabel?: string;
  channel: number | null;
  /** The crop before rotation, in source pixels (center-based for rotated crops). */
  cropPx: SourcePixelRect;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
  resampling: "nearest" | "bilinear";
  display: DisplayTransformV3;
  stats: {
    pixels: number;
    /** Share of crop samples at the source's maximum value. */
    sourceSaturated: number;
    /** Share of crop samples at zero. */
    sourceZero: number;
    /** Share pushed above white by the display mapping that were not already saturated. */
    displayClippedHigh: number;
    /** Share pushed below black by the display mapping that were not already zero. */
    displayClippedLow: number;
  };
};

export type PanelIntegrity = {
  objectId: string;
  /** Target, antibody, dilution, lot, supplier, and notes recorded on the panel. */
  sampleInfo?: SampleInfoV3;
  kind: ImagePanelObject["type"];
  artboardId: string;
  artboardName: string;
  label?: string;
  readings: SourceReadingIntegrity[];
  findings: IntegrityFinding[];
};

export type IntegrityReport = {
  schema: typeof INTEGRITY_REPORT_SCHEMA;
  projectName: string;
  revision: number;
  generatedAt: string;
  panels: PanelIntegrity[];
  findings: IntegrityFinding[];
  /** Suggested methods/legend text summarizing what was done to the images. */
  legendText: string;
};

export type AssetFacts = {
  filename?: string;
  checksumSha256?: string;
  planeLabels?: string[];
};

const percent = (value: number) => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;

const CLIP_WARNING = 0.005;
const SATURATION_WARNING = 0.001;

/** Where a normalized sample lands before clamping: levels, then contrast and brightness. */
function unclamped(value: number, display: DisplayTransformV3): number {
  const { black, white } = display.levels;
  const span = white - black;
  const leveled = span <= 0 ? (value >= white ? 1 : 0) : (value - black) / span;
  return (leveled - 0.5) * display.contrast + 0.5 + display.brightness;
}

function readingStats(
  region: RasterRegion,
  channel: number | null,
  display: DisplayTransformV3,
): SourceReadingIntegrity["stats"] {
  const max = region.bitDepth === 8 ? 255 : 65_535;
  const pixels = region.widthPx * region.heightPx;
  let saturated = 0;
  let zero = 0;
  let high = 0;
  let low = 0;
  let samples = 0;
  const visit = (value: number) => {
    samples += 1;
    if (value >= 1) saturated += 1;
    if (value <= 0) zero += 1;
    const mapped = unclamped(value, display);
    if (mapped > 1 && value < 1) high += 1;
    if (mapped < 0 && value > 0) low += 1;
  };
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const base = pixel * region.channels;
    const at = (offset: number) => (region.data[base + offset] ?? 0) / max;
    if (channel !== null) visit(at(channel));
    else if (region.channels === 1) visit(at(0));
    else if (display.lut !== "none") visit(luminance(at(0), at(1), at(2)));
    else for (let index = 0; index < Math.min(3, region.channels); index += 1) visit(at(index));
  }
  const share = (count: number) => (samples === 0 ? 0 : count / samples);
  return {
    pixels,
    sourceSaturated: share(saturated),
    sourceZero: share(zero),
    displayClippedHigh: share(high),
    displayClippedLow: share(low),
  };
}

function displayFindings(
  display: DisplayTransformV3,
  stats: SourceReadingIntegrity["stats"],
  usesLuminance: boolean,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const identity = IDENTITY_DISPLAY_V3;
  if (
    display.levels.black !== identity.levels.black ||
    display.levels.white !== identity.levels.white
  )
    findings.push({
      severity: "disclose",
      code: "levels",
      message: `Linear levels: input ${display.levels.black.toFixed(3)}–${display.levels.white.toFixed(3)} mapped to full range.`,
    });
  if (display.brightness !== 0 || display.contrast !== 1)
    findings.push({
      severity: "disclose",
      code: "brightness-contrast",
      message: `Linear brightness ${display.brightness.toFixed(2)} and contrast ${display.contrast.toFixed(2)} applied to the whole panel.`,
    });
  if (display.gamma !== 1)
    findings.push({
      severity: "warn",
      code: "gamma",
      message: `Non-linear gamma ${display.gamma.toFixed(2)} applied; state it in the legend.`,
    });
  if (display.invert)
    findings.push({ severity: "disclose", code: "invert", message: "Intensities are inverted." });
  if (display.lut !== "none")
    findings.push({
      severity: "info",
      code: "pseudocolor",
      message: `Shown in ${display.lut} pseudocolor (linear lookup table).`,
    });
  if (usesLuminance)
    findings.push({
      severity: "disclose",
      code: "luminance",
      message: "A color original is shown as its luminance (Rec. 709) under a lookup table.",
    });
  const clipped = stats.displayClippedHigh + stats.displayClippedLow;
  if (clipped > CLIP_WARNING)
    findings.push({
      severity: "warn",
      code: "display-clipping",
      message: `The display mapping clips ${percent(clipped)} of crop samples to black or white.`,
    });
  if (stats.sourceSaturated > SATURATION_WARNING)
    findings.push({
      severity: "warn",
      code: "source-saturation",
      message: `${percent(stats.sourceSaturated)} of crop samples are saturated in the original (possible overexposure).`,
    });
  return findings;
}

function panelLabels(document: FigureDocument): Map<string, string> {
  const labels = new Map<string, string>();
  for (const object of document.objects)
    if (object.type === "text" && object.panelLabel)
      labels.set(object.panelLabel.targetObjectId, object.text.content);
  return labels;
}

/** Rectangles of two crops in source pixels overlap (bounding boxes, for rotated crops). */
function overlaps(left: SourcePixelRect, right: SourcePixelRect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/**
 * Builds the integrity report for one saved revision by reading each panel's crop from the
 * original samples. The browser and the server job share this, so both report the same facts.
 */
export async function buildIntegrityReport(input: {
  document: FigureDocument;
  revision: number;
  projectName: string;
  resolver: RasterSourceResolver;
  sizes: SourceSizes;
  assets?: ReadonlyMap<string, AssetFacts>;
  now?: Date;
}): Promise<IntegrityReport> {
  const { document, resolver, sizes } = input;
  const assets = input.assets ?? new Map<string, AssetFacts>();
  const labels = panelLabels(document);
  const artboardName = new Map(document.artboards.map((board) => [board.id, board.name]));
  const panels: PanelIntegrity[] = [];
  const crops: { objectId: string; assetId: string; plane: number; rect: SourcePixelRect }[] = [];

  for (const object of document.objects.filter(isImagePanel)) {
    const crop = panelCrop(object);
    const readings =
      object.type === "image-view"
        ? [
            {
              sourceAssetId: object.view.sourceAssetId,
              plane: object.view.plane,
              channel: object.view.channel,
              display: object.view.display,
            },
          ]
        : object.composite.channels
            .filter((channel) => channel.visible)
            .map((channel) => ({
              sourceAssetId: channel.sourceAssetId,
              plane: channel.plane,
              channel: channel.channel,
              display: {
                ...channel.display,
                lut: channel.display.lut === "none" ? ("gray" as const) : channel.display.lut,
              },
            }));
    const findings: IntegrityFinding[] = [];
    const results: SourceReadingIntegrity[] = [];
    for (const reading of readings) {
      const size = await sizes(reading.sourceAssetId);
      const rect = cropSourceRect(crop, size);
      const region = await resolver.getRegion(reading.sourceAssetId, rect, 0, reading.plane);
      const usesLuminance =
        reading.channel === null && region.channels > 1 && reading.display.lut !== "none";
      const stats = readingStats(region, reading.channel, reading.display);
      const facts = assets.get(reading.sourceAssetId);
      const cropPx =
        crop.rotationDeg === 0
          ? rect
          : {
              x: crop.viewport.x * size.widthPx,
              y: crop.viewport.y * size.heightPx,
              width: crop.viewport.width * size.widthPx,
              height: crop.viewport.height * size.heightPx,
            };
      results.push({
        assetId: reading.sourceAssetId,
        ...(facts?.filename ? { filename: facts.filename } : {}),
        ...(facts?.checksumSha256 ? { checksumSha256: facts.checksumSha256 } : {}),
        plane: reading.plane,
        ...(facts?.planeLabels?.[reading.plane]
          ? { planeLabel: facts.planeLabels[reading.plane] }
          : {}),
        channel: reading.channel,
        cropPx,
        rotationDeg: crop.rotationDeg,
        flipX: crop.flipX,
        flipY: crop.flipY,
        resampling: crop.rotationDeg === 0 ? "nearest" : "bilinear",
        display: reading.display,
        stats,
      });
      findings.push(...displayFindings(reading.display, stats, usesLuminance));
      crops.push({
        objectId: object.id,
        assetId: reading.sourceAssetId,
        plane: reading.plane,
        rect,
      });
    }
    if (crop.rotationDeg !== 0)
      findings.push({
        severity: "disclose",
        code: "rotation",
        message: `Crop rotated ${crop.rotationDeg.toFixed(1)}° with bilinear resampling.`,
      });
    if (crop.flipX || crop.flipY)
      findings.push({
        severity: "disclose",
        code: "flip",
        message: `Mirrored ${[crop.flipX ? "horizontally" : "", crop.flipY ? "vertically" : ""].filter(Boolean).join(" and ")}.`,
      });
    const expectedKDa = object.sampleInfo?.expectedKDa;
    if (object.type === "image-view" && expectedKDa !== undefined) {
      const source = document.sources.find((entry) => entry.assetId === object.view.sourceAssetId);
      const range = source
        ? cropKDaRange(object.view, await sizes(source.assetId), source.markers)
        : undefined;
      if (!range)
        findings.push({
          severity: "info",
          code: "unchecked-mw",
          message: `Expected band at ${expectedKDa} kDa; mark at least two ladder bands on the original to check it.`,
        });
      else if (expectedKDa < range.lowKDa || expectedKDa > range.highKDa)
        findings.push({
          severity: "warn",
          code: "unexpected-mw",
          message: `Expected band at ${expectedKDa} kDa lies outside this crop's ladder range (${range.lowKDa.toFixed(0)}–${range.highKDa.toFixed(0)} kDa).`,
        });
    }
    if (object.type === "composite")
      findings.push({
        severity: "info",
        code: "composite",
        message: `Additive merge of ${readings.length} channel${readings.length === 1 ? "" : "s"}.`,
      });
    panels.push({
      objectId: object.id,
      kind: object.type,
      artboardId: object.artboardId,
      artboardName: artboardName.get(object.artboardId) ?? object.artboardId,
      ...(labels.has(object.id) ? { label: labels.get(object.id) as string } : {}),
      ...(object.sampleInfo ? { sampleInfo: object.sampleInfo } : {}),
      readings: results,
      findings: dedupe(findings),
    });
  }

  const findings: IntegrityFinding[] = [];
  const zoomPairs = new Set(
    document.objects.flatMap((object) =>
      object.type === "zoom-link"
        ? [
            `${object.zoomLink.sourceObjectId}|${object.zoomLink.insetObjectId}`,
            `${object.zoomLink.insetObjectId}|${object.zoomLink.sourceObjectId}`,
          ]
        : [],
    ),
  );
  for (let left = 0; left < crops.length; left += 1)
    for (let right = left + 1; right < crops.length; right += 1) {
      const a = crops[left];
      const b = crops[right];
      if (!a || !b || a.objectId === b.objectId || a.assetId !== b.assetId || a.plane !== b.plane)
        continue;
      if (!overlaps(a.rect, b.rect) || zoomPairs.has(`${a.objectId}|${b.objectId}`)) continue;
      findings.push({
        severity: "info",
        code: "overlapping-crops",
        message: `${name(a.objectId, labels)} and ${name(b.objectId, labels)} show overlapping regions of the same original; say so if they are presented as different samples.`,
      });
    }
  const byChecksum = new Map<string, string[]>();
  for (const [assetId, facts] of assets)
    if (facts.checksumSha256)
      byChecksum.set(facts.checksumSha256, [
        ...(byChecksum.get(facts.checksumSha256) ?? []),
        assetId,
      ]);
  const used = new Set(crops.map((crop) => crop.assetId));
  for (const [checksum, ids] of byChecksum) {
    const inUse = ids.filter((id) => used.has(id));
    if (inUse.length > 1)
      findings.push({
        severity: "warn",
        code: "duplicate-originals",
        message: `${inUse.length} uploaded originals are byte-identical (SHA-256 ${checksum.slice(0, 12)}…): ${inUse.map((id) => assets.get(id)?.filename ?? id).join(", ")}.`,
      });
  }
  for (const object of document.objects) {
    if (object.type !== "scale-bar") continue;
    const target = document.objects.find(
      (candidate) => candidate.id === object.scaleBar.targetObjectId,
    );
    const assetId =
      target?.type === "image-view"
        ? target.view.sourceAssetId
        : target?.type === "composite"
          ? target.composite.channels[0]?.sourceAssetId
          : undefined;
    const calibration = document.sources.find((source) => source.assetId === assetId)?.calibration;
    findings.push(
      calibration?.origin === "manual"
        ? {
            severity: "disclose",
            code: "manual-calibration",
            message: `Scale bar on ${name(object.scaleBar.targetObjectId, labels)} uses a manually entered pixel size (${calibration.umPerPxX} µm/px).`,
          }
        : {
            severity: "info",
            code: "scale-bar",
            message: `Scale bar on ${name(object.scaleBar.targetObjectId, labels)} uses the pixel size recorded in the original.`,
          },
    );
  }

  // Blot panels are those with lane labels or MW labels attached.
  const blotIds = new Set(
    document.objects.flatMap((object) =>
      object.type === "lane-table"
        ? [object.laneTable.targetObjectId]
        : object.type === "mw-labels"
          ? [object.mwLabels.targetObjectId]
          : [],
    ),
  );
  const blots = panels.filter((panel) => blotIds.has(panel.objectId));
  if (blots.length > 0 && !panels.some((panel) => isLoadingControl(panel.sampleInfo)))
    findings.push({
      severity: "warn",
      code: "missing-loading-control",
      message:
        "No blot panel is marked as a loading control (for example β-actin, GAPDH, or total protein). Record it in the panel's sample info.",
    });

  return {
    schema: INTEGRITY_REPORT_SCHEMA,
    projectName: input.projectName,
    revision: input.revision,
    generatedAt: (input.now ?? new Date()).toISOString(),
    panels,
    findings,
    legendText: legendText(panels),
  };
}

function name(objectId: string, labels: ReadonlyMap<string, string>): string {
  const label = labels.get(objectId);
  return label ? `panel ${label}` : `panel ${objectId}`;
}

function dedupe(findings: IntegrityFinding[]): IntegrityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Plain sentences for a methods section or figure legend. */
export function legendText(panels: ReadonlyArray<PanelIntegrity>): string {
  if (panels.length === 0) return "";
  const named = (panel: PanelIntegrity) => (panel.label ? panel.label : panel.objectId);
  const withCode = (code: string) =>
    panels.filter((panel) => panel.findings.some((finding) => finding.code === code)).map(named);
  const sentences = [
    "All panels were cropped from unaltered originals; crop coordinates and file checksums are listed in the integrity report.",
  ];
  const linear = [...new Set([...withCode("brightness-contrast"), ...withCode("levels")])];
  if (linear.length > 0)
    sentences.push(
      `Linear brightness, contrast, or levels adjustments were applied uniformly to the whole of panel${linear.length > 1 ? "s" : ""} ${linear.join(", ")}.`,
    );
  const gamma = withCode("gamma");
  if (gamma.length > 0)
    sentences.push(
      `A non-linear gamma adjustment was applied to panel${gamma.length > 1 ? "s" : ""} ${gamma.join(", ")}.`,
    );
  const rotated = withCode("rotation");
  if (rotated.length > 0)
    sentences.push(
      `Panel${rotated.length > 1 ? "s" : ""} ${rotated.join(", ")} ${rotated.length > 1 ? "were" : "was"} rotated to straighten lanes (bilinear resampling).`,
    );
  const pseudocolor = [...new Set([...withCode("pseudocolor"), ...withCode("composite")])];
  if (pseudocolor.length > 0)
    sentences.push(
      `Pseudocolor and channel merges use linear lookup tables (${pseudocolor.join(", ")}).`,
    );
  const antibodies = panels.filter(
    (panel) => panel.sampleInfo?.antibody || panel.sampleInfo?.target,
  );
  if (antibodies.length > 0)
    sentences.push(
      `Detection: ${antibodies
        .map((panel) => {
          const info = panel.sampleInfo ?? {};
          const details = [
            info.antibody,
            info.dilution,
            info.supplier,
            info.lot ? `lot ${info.lot}` : undefined,
          ]
            .filter(Boolean)
            .join(", ");
          return `${named(panel)} ${info.target ?? ""}${details ? ` (${details})` : ""}`.trim();
        })
        .join("; ")}.`,
    );
  const inverted = withCode("invert");
  if (inverted.length > 0) sentences.push(`Intensities were inverted in ${inverted.join(", ")}.`);
  return sentences.join(" ");
}

/** A self-contained HTML rendering of a report, for reading or printing to PDF. */
export function integrityReportHtml(report: IntegrityReport): string {
  const html = (value: string) =>
    value.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  const finding = (item: IntegrityFinding) =>
    `<li class="${item.severity}"><strong>${item.severity}</strong> ${html(item.message)}</li>`;
  const reading = (item: SourceReadingIntegrity) =>
    `<tr><td>${html(item.filename ?? item.assetId)}${item.planeLabel ? ` · ${html(item.planeLabel)}` : ""}${item.channel === null ? "" : ` · channel ${item.channel + 1}`}</td><td><code>${html(item.checksumSha256 ?? "")}</code></td><td>${Math.round(item.cropPx.x)}, ${Math.round(item.cropPx.y)}, ${Math.round(item.cropPx.width)} × ${Math.round(item.cropPx.height)}${item.rotationDeg ? `, ${item.rotationDeg.toFixed(1)}°` : ""}</td><td>${percent(item.stats.sourceSaturated)}</td><td>${percent(item.stats.displayClippedHigh + item.stats.displayClippedLow)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Integrity report — ${html(report.projectName)}</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;max-width:960px}table{border-collapse:collapse;width:100%;margin:8px 0 16px}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;font-size:12px}code{font-size:11px;word-break:break-all}.warn strong{color:#b00020}.disclose strong{color:#8a5a00}.info strong{color:#555}</style></head><body><h1>Integrity report</h1><p>${html(report.projectName)} · revision ${report.revision} · generated ${html(report.generatedAt)}</p><h2>Suggested legend text</h2><p>${html(report.legendText)}</p><h2>Figure-wide findings</h2><ul>${report.findings.map(finding).join("") || "<li>None.</li>"}</ul>${report.panels
    .map(
      (panel) =>
        `<h2>${html(panel.label ? `Panel ${panel.label}` : panel.objectId)} <small>(${html(panel.artboardName)}, ${panel.kind})</small></h2>${
          panel.sampleInfo
            ? `<p>${html(
                Object.entries(panel.sampleInfo)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(" · "),
              )}</p>`
            : ""
        }<table><tr><th>Original</th><th>SHA-256</th><th>Crop (px)</th><th>Saturated in original</th><th>Clipped by display</th></tr>${panel.readings.map(reading).join("")}</table><ul>${panel.findings.map(finding).join("") || "<li>No adjustments.</li>"}</ul>`,
    )
    .join("")}</body></html>`;
}

/**
 * Histogram of normalized samples in `bins` buckets: one channel, luminance for color without a
 * channel, or the single gray sample.
 */
export function sampleHistogram(region: RasterRegion, channel: number | null, bins = 64): number[] {
  const counts = new Array<number>(bins).fill(0);
  const max = region.bitDepth === 8 ? 255 : 65_535;
  const pixels = region.widthPx * region.heightPx;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const base = pixel * region.channels;
    const at = (offset: number) => (region.data[base + offset] ?? 0) / max;
    const value =
      channel !== null
        ? at(channel)
        : region.channels === 1
          ? at(0)
          : luminance(at(0), at(1), at(2));
    const bin = Math.min(bins - 1, Math.floor(value * bins));
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}

/** One row per panel reading, for spreadsheets. */
export function cropsCsv(report: IntegrityReport): string {
  const header = [
    "figure",
    "panel",
    "object_id",
    "original",
    "sha256",
    "plane",
    "channel",
    "crop_x_px",
    "crop_y_px",
    "crop_width_px",
    "crop_height_px",
    "rotation_deg",
    "flip_x",
    "flip_y",
    "levels_black",
    "levels_white",
    "brightness",
    "contrast",
    "gamma",
    "invert",
    "lut",
    "source_saturated",
    "display_clipped",
  ];
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = report.panels.flatMap((panel) =>
    panel.readings.map((reading) =>
      [
        panel.artboardName,
        panel.label ?? "",
        panel.objectId,
        reading.filename ?? reading.assetId,
        reading.checksumSha256 ?? "",
        reading.plane,
        reading.channel ?? "",
        reading.cropPx.x,
        reading.cropPx.y,
        reading.cropPx.width,
        reading.cropPx.height,
        reading.rotationDeg,
        reading.flipX,
        reading.flipY,
        reading.display.levels.black,
        reading.display.levels.white,
        reading.display.brightness,
        reading.display.contrast,
        reading.display.gamma,
        reading.display.invert,
        reading.display.lut,
        reading.stats.sourceSaturated,
        reading.stats.displayClippedHigh + reading.stats.displayClippedLow,
      ]
        .map(cell)
        .join(","),
    ),
  );
  return [header.join(","), ...rows].join("\n");
}

/**
 * A document for the "uncropped originals" supplement: each original on its own figure with
 * every crop outlined and labelled, and ladder markers ticked. It renders with the normal
 * renderers, so the outlines use the same geometry as the figure.
 */
export async function buildUncroppedSheet(
  document: FigureDocument,
  sizes: SourceSizes,
  assets: ReadonlyMap<string, AssetFacts> = new Map(),
): Promise<FigureDocument> {
  const labels = panelLabels(document);
  const panels = document.objects.filter(isImagePanel);
  const byAsset = new Map<string, { panel: ImagePanelObject; plane: number }[]>();
  for (const panel of panels)
    for (const reading of panel.type === "image-view" ? [panel.view] : panel.composite.channels) {
      const key = `${reading.sourceAssetId}|${reading.plane}`;
      byAsset.set(key, [...(byAsset.get(key) ?? []), { panel, plane: reading.plane }]);
    }
  const artboards: FigureDocument["artboards"] = [];
  const objects: FigureObject[] = [];
  const stroke = { colorHex: "#FF2D55", widthPt: 1, dashed: false };
  const margin = 36;
  const widthPt = 468;
  let index = 0;
  for (const [key, uses] of byAsset) {
    const [assetId = "", planeText = "0"] = key.split("|");
    const plane = Number(planeText);
    const size = await sizes(assetId);
    const scale = widthPt / size.widthPx;
    const heightPt = size.heightPx * scale;
    const artboardId = `sheet-${index}`;
    index += 1;
    const facts = assets.get(assetId);
    artboards.push({
      id: artboardId,
      name: `${facts?.filename ?? assetId}${facts?.planeLabels?.[plane] ? ` · ${facts.planeLabels[plane]}` : ""}`,
      widthPt: widthPt + margin * 2,
      heightPt: heightPt + margin * 2 + 18,
      backgroundHex: "#FFFFFF",
    });
    const base = { artboardId, locked: false, hidden: false };
    objects.push({
      ...base,
      id: `${artboardId}-original`,
      type: "image-view",
      zIndex: 0,
      transform: { xPt: margin, yPt: margin + 18, widthPt, heightPt, rotationDeg: 0 },
      view: {
        sourceAssetId: assetId,
        plane,
        channel: null,
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        display: { ...IDENTITY_DISPLAY_V3 },
      },
    });
    const title = artboards.at(-1)?.name ?? assetId;
    objects.push(
      textObject(
        `${artboardId}-title`,
        artboardId,
        `Uncropped original: ${title}`,
        margin,
        margin - 4,
        10,
        true,
        1,
      ),
    );
    let z = 2;
    for (const { panel } of uses) {
      const corners = cornersOnSheet(panel, size, scale, margin, margin + 18);
      for (const [cornerIndex, start] of corners.entries()) {
        const end = corners[(cornerIndex + 1) % corners.length] ?? start;
        objects.push(
          segment(
            `${artboardId}-${panel.id}-edge-${cornerIndex}`,
            artboardId,
            start,
            end,
            stroke,
            z,
          ),
        );
        z += 1;
      }
      const top = corners.reduce((best, corner) => (corner.y < best.y ? corner : best));
      objects.push(
        textObject(
          `${artboardId}-${panel.id}-label`,
          artboardId,
          labels.get(panel.id) ?? panel.id.slice(0, 8),
          top.x + 2,
          Math.max(margin + 18, top.y - 12),
          9,
          true,
          z,
        ),
      );
      z += 1;
    }
    const markers = document.sources.find((source) => source.assetId === assetId)?.markers ?? [];
    for (const marker of markers) {
      const y = margin + 18 + marker.yPx * scale;
      objects.push(
        segment(
          `${artboardId}-mw-${marker.kDa}`,
          artboardId,
          { x: margin - 6, y },
          { x: margin, y },
          { ...stroke, colorHex: "#000000" },
          z,
        ),
      );
      objects.push(
        textObject(
          `${artboardId}-mw-${marker.kDa}-text`,
          artboardId,
          `${marker.kDa}`,
          2,
          y - 4.5,
          7,
          false,
          z + 1,
        ),
      );
      z += 2;
    }
  }
  return {
    schemaVersion: 3,
    artboards:
      artboards.length > 0
        ? artboards
        : [
            {
              id: "sheet-empty",
              name: "No originals",
              widthPt: 300,
              heightPt: 100,
              backgroundHex: "#FFFFFF",
            },
          ],
    sources: document.sources,
    objects,
    groups: [],
    constraints: [],
    styles: [],
  };
}

function cornersOnSheet(
  panel: ImagePanelObject,
  size: { widthPx: number; heightPx: number },
  scale: number,
  left: number,
  top: number,
): { x: number; y: number }[] {
  const crop = panelCrop(panel);
  const width = crop.viewport.width * size.widthPx;
  const height = crop.viewport.height * size.heightPx;
  const cx = (crop.viewport.x + crop.viewport.width / 2) * size.widthPx;
  const cy = (crop.viewport.y + crop.viewport.height / 2) * size.heightPx;
  const radians = (crop.rotationDeg * Math.PI) / 180;
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([dx = 0, dy = 0]) => ({
    x: left + (cx + dx * Math.cos(radians) - dy * Math.sin(radians)) * scale,
    y: top + (cy + dx * Math.sin(radians) + dy * Math.cos(radians)) * scale,
  }));
}

function segment(
  id: string,
  artboardId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  stroke: { colorHex: string; widthPt: number; dashed: boolean },
  zIndex: number,
): FigureObject {
  const [start, end] = from.x <= to.x ? [from, to] : [to, from];
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return {
    id,
    artboardId,
    type: "line",
    zIndex,
    locked: false,
    hidden: false,
    transform: {
      xPt: start.x,
      yPt: Math.min(start.y, end.y),
      widthPt: width === 0 && height === 0 ? 0.01 : width,
      heightPt: height,
      rotationDeg: 0,
    },
    line: { direction: end.y >= start.y ? "down" : "up", heads: "none", stroke },
  };
}

function textObject(
  id: string,
  artboardId: string,
  content: string,
  x: number,
  y: number,
  fontSizePt: number,
  bold: boolean,
  zIndex: number,
): FigureObject {
  return {
    id,
    artboardId,
    type: "text",
    zIndex,
    locked: false,
    hidden: false,
    transform: {
      xPt: x,
      yPt: y,
      widthPt: Math.max(1, content.length * fontSizePt * 0.6),
      heightPt: fontSizePt * 1.2,
      rotationDeg: 0,
    },
    text: {
      content,
      style: {
        fontSizePt,
        bold,
        italic: false,
        underline: false,
        colorHex: "#000000",
        align: "start",
        backgroundHex: null,
      },
    },
  };
}
