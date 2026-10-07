import type { ImageViewObjectV3 } from "@figlab/figure-schema";
import {
  cropSizePx,
  cropSourceRect,
  luminance,
  panelToSourcePx,
  type SourceSizes,
} from "./panel-render.js";
import type { RasterSourceResolver } from "./raster.js";
import { laneBoundaries } from "./scene-annotations.js";

export type QuantificationOptions = {
  lanes: number;
  /** Lane centers as fractions of the panel width; even spacing when null. */
  laneCenters: number[] | null;
  /** Share of each lane's slot that is measured, centered on the lane (avoids neighbours). */
  laneWidthFraction?: number;
  /** Bands darker than the background (most blots); signal is then 1 − sample. */
  darkBands?: boolean;
  /** `line` subtracts a straight baseline between the lane profile's ends. */
  background?: "line" | "none";
};

export type LaneQuantification = {
  lane: number;
  label: string;
  /** Sum of the signal over the measured area, in normalized-intensity × pixels. */
  rawDensity: number;
  background: number;
  net: number;
  /** Share of measured samples at the detector's limit (white, or black for dark bands). */
  saturated: number;
  normalized?: number;
  relative?: number;
};

export type QuantificationResult = {
  lanes: LaneQuantification[];
  warnings: string[];
};

/**
 * Raw normalized samples of a view's selected channel on a grid of its crop, read from the
 * original. Display adjustments are ignored: densitometry measures data, not presentation.
 */
export async function rawViewSamples(
  view: ImageViewObjectV3,
  resolver: RasterSourceResolver,
  sizes: SourceSizes,
): Promise<{ values: Float64Array; columns: number; rows: number; atLimit: Uint8Array }> {
  const size = await sizes(view.view.sourceAssetId);
  const crop = cropSizePx(view.view, size);
  const columns = Math.max(1, Math.round(crop.widthPx));
  const rows = Math.max(1, Math.round(crop.heightPx));
  const rect = cropSourceRect(view.view, size);
  const region = await resolver.getRegion(view.view.sourceAssetId, rect, 0, view.view.plane);
  const max = region.bitDepth === 8 ? 255 : 65_535;
  const values = new Float64Array(columns * rows);
  const atLimit = new Uint8Array(columns * rows);
  const sample = (x: number, y: number): number => {
    const localX = Math.min(region.widthPx - 1, Math.max(0, Math.floor(x) - region.sourceRect.x));
    const localY = Math.min(region.heightPx - 1, Math.max(0, Math.floor(y) - region.sourceRect.y));
    const base = (localY * region.widthPx + localX) * region.channels;
    const at = (offset: number) => (region.data[base + offset] ?? 0) / max;
    if (view.view.channel !== null) return at(view.view.channel);
    return region.channels === 1 ? at(0) : luminance(at(0), at(1), at(2));
  };
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const point = panelToSourcePx(view.view, size, (column + 0.5) / columns, (row + 0.5) / rows);
      const value = sample(point.x, point.y);
      values[row * columns + column] = value;
      atLimit[row * columns + column] = value <= 0 || value >= 1 ? 1 : 0;
    }
  return { values, columns, rows, atLimit };
}

/** Measures integrated band density per lane of a blot panel. */
export function quantifyLanes(
  samples: { values: Float64Array; columns: number; rows: number; atLimit: Uint8Array },
  options: QuantificationOptions,
  labels: ReadonlyArray<string> = [],
): LaneQuantification[] {
  const { values, columns, rows, atLimit } = samples;
  const bounds = laneBoundaries(options.lanes, options.laneCenters);
  const share = Math.min(1, Math.max(0.05, options.laneWidthFraction ?? 0.6));
  const dark = options.darkBands ?? true;
  const results: LaneQuantification[] = [];
  for (let lane = 0; lane < options.lanes; lane += 1) {
    const left = (bounds[lane] ?? 0) * columns;
    const right = (bounds[lane + 1] ?? 1) * columns;
    const center = (left + right) / 2;
    const half = ((right - left) * share) / 2;
    const first = Math.max(0, Math.floor(center - half));
    const last = Math.min(columns, Math.max(first + 1, Math.ceil(center + half)));
    const width = last - first;
    const profile = new Float64Array(rows);
    let limited = 0;
    for (let row = 0; row < rows; row += 1) {
      let sum = 0;
      for (let column = first; column < last; column += 1) {
        const value = values[row * columns + column] ?? 0;
        sum += dark ? 1 - value : value;
        // Dark bands saturate at black; light bands (fluorescence) at white.
        if (atLimit[row * columns + column] && (dark ? value <= 0 : value >= 1)) limited += 1;
      }
      profile[row] = sum / width;
    }
    const start = profile[0] ?? 0;
    const end = profile[rows - 1] ?? 0;
    let raw = 0;
    let background = 0;
    let net = 0;
    for (let row = 0; row < rows; row += 1) {
      const baseline =
        options.background === "none"
          ? 0
          : rows === 1
            ? start
            : start + ((end - start) * row) / (rows - 1);
      const value = profile[row] ?? 0;
      raw += value * width;
      background += Math.min(value, baseline) * width;
      net += Math.max(0, value - baseline) * width;
    }
    results.push({
      lane: lane + 1,
      label: labels[lane] ?? `Lane ${lane + 1}`,
      rawDensity: raw,
      background,
      net,
      saturated: limited / (width * rows),
    });
  }
  return results;
}

/**
 * Divides each lane by its loading control and expresses it relative to a reference lane, and
 * reports the checks reviewers ask about: saturation and uneven loading.
 */
export function normalizeToControl(
  target: ReadonlyArray<LaneQuantification>,
  control: ReadonlyArray<LaneQuantification> | undefined,
  referenceLane = 1,
): QuantificationResult {
  const warnings: string[] = [];
  for (const lane of target)
    if (lane.saturated > 0.001)
      warnings.push(
        `Lane ${lane.lane} has ${(lane.saturated * 100).toFixed(2)}% saturated samples; its density is underestimated.`,
      );
  if (!control) {
    warnings.push("No loading control selected; values are not normalized.");
    const reference = target.find((lane) => lane.lane === referenceLane)?.net ?? 0;
    return {
      lanes: target.map((lane) => ({
        ...lane,
        ...(reference > 0 ? { relative: lane.net / reference } : {}),
      })),
      warnings,
    };
  }
  if (control.length !== target.length)
    warnings.push(
      `The loading control has ${control.length} lanes but the target has ${target.length}.`,
    );
  const nets = control.map((lane) => lane.net);
  const mean = nets.reduce((sum, value) => sum + value, 0) / Math.max(1, nets.length);
  const deviation = Math.sqrt(
    nets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, nets.length),
  );
  if (mean > 0 && deviation / mean > 0.2)
    warnings.push(
      `The loading control varies ${((deviation / mean) * 100).toFixed(0)}% across lanes; check that loading was even.`,
    );
  for (const lane of control)
    if (lane.saturated > 0.001)
      warnings.push(`Loading-control lane ${lane.lane} is saturated; normalization is unreliable.`);
  const lanes = target.map((lane, index) => {
    const reference = control[index]?.net ?? 0;
    if (reference <= 0) {
      warnings.push(`Loading-control lane ${lane.lane} has no signal; it cannot be normalized.`);
      return { ...lane };
    }
    return { ...lane, normalized: lane.net / reference };
  });
  const base = lanes.find((lane) => lane.lane === referenceLane)?.normalized;
  return {
    lanes: lanes.map((lane) =>
      base && lane.normalized !== undefined ? { ...lane, relative: lane.normalized / base } : lane,
    ),
    warnings,
  };
}

export function quantificationCsv(
  result: QuantificationResult,
  context: { target: string; control?: string },
): string {
  const cell = (value: unknown) => {
    const text =
      typeof value === "number" ? Number(value.toPrecision(8)).toString() : String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = [
    "lane",
    "label",
    "target",
    "raw_density",
    "background",
    "net",
    "saturated_fraction",
    "loading_control",
    "normalized",
    "relative",
  ];
  const rows = result.lanes.map((lane) =>
    [
      lane.lane,
      lane.label,
      context.target,
      lane.rawDensity,
      lane.background,
      lane.net,
      lane.saturated,
      context.control ?? "",
      lane.normalized ?? "",
      lane.relative ?? "",
    ]
      .map(cell)
      .join(","),
  );
  const notes = result.warnings.map((warning) => `# ${warning}`);
  return [...notes, header.join(","), ...rows].join("\n");
}
