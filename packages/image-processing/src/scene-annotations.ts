import {
  type FigureObject,
  type ImagePanelObject,
  isImagePanel,
  type LaneTableObjectV3,
  type MwLabelsObjectV3,
  panelAssetIds,
  type ScaleBarObjectV3,
  type SourceInfoV3,
  TEXT_LINE_HEIGHT_EM,
  type TextStyleV2,
  type ZoomLinkObjectV3,
} from "@figlab/figure-schema";
import { cropSizePx, panelCrop, panelToSourcePx, sourcePxToPanel } from "./panel-render.js";
import type { PathCommand, TextMetrics, VectorPrimitive } from "./scene.js";

export type AnnotationContext = {
  metrics: TextMetrics;
  objects: ReadonlyMap<string, FigureObject>;
  sources: ReadonlyMap<string, SourceInfoV3>;
};

const labelStyle = (fontSizePt: number, colorHex: string): TextStyleV2 => ({
  fontSizePt,
  bold: false,
  italic: false,
  underline: false,
  colorHex,
  align: "start",
  backgroundHex: null,
});

function panelOf(context: AnnotationContext, id: string): ImagePanelObject {
  const object = context.objects.get(id);
  if (!object || !isImagePanel(object)) throw new Error(`Object ${id} is not an image panel`);
  return object;
}

function sourceOf(context: AnnotationContext, panel: ImagePanelObject): SourceInfoV3 {
  const assetId = panelAssetIds(panel)[0] ?? "";
  const source = context.sources.get(assetId);
  if (!source) throw new Error(`Source ${assetId} has no recorded size`);
  return source;
}

/** A source pixel's position on the artboard, through a panel's crop, rotation, and flips. */
export function sourcePointOnArtboard(
  panel: ImagePanelObject,
  source: SourceInfoV3,
  x: number,
  y: number,
): { x: number; y: number; s: number; t: number } {
  const { s, t } = sourcePxToPanel(panelCrop(panel), source, x, y);
  const { xPt, yPt, widthPt, heightPt } = panel.transform;
  return { x: xPt + s * widthPt, y: yPt + t * heightPt, s, t };
}

function textLine(
  context: AnnotationContext,
  text: string,
  style: TextStyleV2,
  anchorX: number,
  baselineY: number,
  align: "start" | "middle" | "end",
): Extract<VectorPrimitive, { type: "text" }> {
  const width = context.metrics.measure(text, style);
  return {
    type: "text",
    text,
    x: align === "start" ? anchorX : align === "middle" ? anchorX - width / 2 : anchorX - width,
    baselineY,
    fontSizePt: style.fontSizePt,
    bold: style.bold,
    italic: style.italic,
    colorHex: style.colorHex,
  };
}

const rect = (left: number, top: number, width: number, height: number): PathCommand[] => [
  { op: "M", x: left, y: top },
  { op: "L", x: left + width, y: top },
  { op: "L", x: left + width, y: top + height },
  { op: "L", x: left, y: top + height },
  { op: "Z" },
];

/** Formats a length in µm in the bar's display unit, without trailing zeros. */
export function scaleBarLabel(lengthUm: number, unit: "nm" | "µm" | "mm"): string {
  const value = unit === "nm" ? lengthUm * 1000 : unit === "mm" ? lengthUm / 1000 : lengthUm;
  return `${Number(value.toPrecision(6))} ${unit}`;
}

/**
 * The bar's width follows from the source calibration and the panel's scale, so it stays
 * correct when the panel is resized or recropped.
 */
export function scaleBarWidthPt(context: AnnotationContext, object: ScaleBarObjectV3): number {
  const panel = panelOf(context, object.scaleBar.targetObjectId);
  const source = sourceOf(context, panel);
  if (!source.calibration) throw new Error(`Source ${source.assetId} is not calibrated`);
  const crop = cropSizePx(panelCrop(panel), source);
  const ptPerPx = panel.transform.widthPt / crop.widthPx;
  return (object.scaleBar.lengthUm / source.calibration.umPerPxX) * ptPerPx;
}

export function scaleBarPrimitives(
  context: AnnotationContext,
  object: ScaleBarObjectV3,
): VectorPrimitive[] {
  const { xPt, yPt } = object.transform;
  const { thicknessPt, colorHex, showLabel, fontSizePt, lengthUm, displayUnit } = object.scaleBar;
  const width = scaleBarWidthPt(context, object);
  const primitives: VectorPrimitive[] = [
    { type: "path", commands: rect(xPt, yPt, width, thicknessPt), fillHex: colorHex },
  ];
  if (showLabel) {
    const style = labelStyle(fontSizePt, colorHex);
    const baseline = yPt + thicknessPt + fontSizePt * 0.2 + context.metrics.ascentEm * fontSizePt;
    primitives.push(
      textLine(
        context,
        scaleBarLabel(lengthUm, displayUnit),
        style,
        xPt + width / 2,
        baseline,
        "middle",
      ),
    );
  }
  return primitives;
}

export function zoomLinkPrimitives(
  context: AnnotationContext,
  object: ZoomLinkObjectV3,
): VectorPrimitive[] {
  const from = panelOf(context, object.zoomLink.sourceObjectId);
  const inset = panelOf(context, object.zoomLink.insetObjectId);
  const source = sourceOf(context, from);
  const insetCrop = panelCrop(inset);
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([s = 0, t = 0]) => {
    const point = panelToSourcePx(insetCrop, source, s, t);
    return sourcePointOnArtboard(from, source, point.x, point.y);
  });
  const stroke = {
    colorHex: object.zoomLink.stroke.colorHex,
    widthPt: object.zoomLink.stroke.widthPt,
    dash: object.zoomLink.stroke.dashed
      ? [object.zoomLink.stroke.widthPt * 3, object.zoomLink.stroke.widthPt * 2]
      : [],
  };
  const primitives: VectorPrimitive[] = [
    {
      type: "path",
      commands: [
        ...corners.map((corner, index) => ({
          op: index === 0 ? ("M" as const) : ("L" as const),
          x: corner.x,
          y: corner.y,
        })),
        { op: "Z" as const },
      ],
      stroke,
    },
  ];
  if (object.zoomLink.connectors) {
    const box = {
      left: Math.min(...corners.map((corner) => corner.x)),
      right: Math.max(...corners.map((corner) => corner.x)),
      top: Math.min(...corners.map((corner) => corner.y)),
      bottom: Math.max(...corners.map((corner) => corner.y)),
    };
    const target = inset.transform;
    const panel = {
      left: target.xPt,
      right: target.xPt + target.widthPt,
      top: target.yPt,
      bottom: target.yPt + target.heightPt,
    };
    // Connect the box's facing side to the inset's facing side.
    const pairs: [[number, number], [number, number]][] =
      panel.left >= box.right
        ? [
            [
              [box.right, box.top],
              [panel.left, panel.top],
            ],
            [
              [box.right, box.bottom],
              [panel.left, panel.bottom],
            ],
          ]
        : panel.right <= box.left
          ? [
              [
                [box.left, box.top],
                [panel.right, panel.top],
              ],
              [
                [box.left, box.bottom],
                [panel.right, panel.bottom],
              ],
            ]
          : panel.top >= box.bottom
            ? [
                [
                  [box.left, box.bottom],
                  [panel.left, panel.top],
                ],
                [
                  [box.right, box.bottom],
                  [panel.right, panel.top],
                ],
              ]
            : [
                [
                  [box.left, box.top],
                  [panel.left, panel.bottom],
                ],
                [
                  [box.right, box.top],
                  [panel.right, panel.bottom],
                ],
              ];
    for (const [[x1, y1], [x2, y2]] of pairs)
      primitives.push({
        type: "path",
        commands: [
          { op: "M", x: x1, y: y1 },
          { op: "L", x: x2, y: y2 },
        ],
        stroke,
      });
  }
  return primitives;
}

/** Lane boundaries (as fractions of the panel width) from explicit or even lane centers. */
export function laneBoundaries(lanes: number, centers: number[] | null): number[] {
  if (!centers) return Array.from({ length: lanes + 1 }, (_, index) => index / lanes);
  if (lanes === 1) return [0, 1];
  const at = (index: number) => centers[index] ?? 0;
  const bounds = [Math.max(0, at(0) - (at(1) - at(0)) / 2)];
  for (let index = 1; index < lanes; index += 1) bounds.push((at(index - 1) + at(index)) / 2);
  bounds.push(Math.min(1, at(lanes - 1) + (at(lanes - 1) - at(lanes - 2)) / 2));
  return bounds;
}

export function laneTablePrimitives(
  context: AnnotationContext,
  object: LaneTableObjectV3,
): VectorPrimitive[] {
  const panel = panelOf(context, object.laneTable.targetObjectId);
  const { rows, lanes, laneCenters, placement, fontSizePt, colorHex, gapPt } = object.laneTable;
  const { xPt, yPt, widthPt, heightPt } = panel.transform;
  const bounds = laneBoundaries(lanes, laneCenters);
  const style = labelStyle(fontSizePt, colorHex);
  const lineHeight = fontSizePt * TEXT_LINE_HEIGHT_EM;
  const rowHeight = (row: (typeof rows)[number]) =>
    lineHeight + (row.cells.some((cell) => cell.underline) ? fontSizePt * 0.35 : 0);
  const total = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  let top = placement === "above" ? yPt - gapPt - total : yPt + heightPt + gapPt;
  const primitives: VectorPrimitive[] = [];
  const halfLeading =
    (lineHeight - (context.metrics.ascentEm + context.metrics.descentEm) * fontSizePt) / 2;
  for (const row of rows) {
    let lane = 0;
    const baseline = top + halfLeading + context.metrics.ascentEm * fontSizePt;
    for (const cell of row.cells) {
      const left = xPt + (bounds[lane] ?? 0) * widthPt;
      const right = xPt + (bounds[lane + cell.span] ?? 1) * widthPt;
      if (cell.text)
        primitives.push(
          textLine(context, cell.text, style, (left + right) / 2, baseline, "middle"),
        );
      if (cell.underline) {
        const inset = Math.min((right - left) * 0.08, 2);
        const lineY = top + lineHeight + fontSizePt * 0.15;
        primitives.push({
          type: "path",
          commands: rect(
            left + inset,
            lineY,
            Math.max(0.1, right - left - inset * 2),
            Math.max(0.4, fontSizePt * 0.06),
          ),
          fillHex: colorHex,
        });
      }
      lane += cell.span;
    }
    top += rowHeight(row);
  }
  return primitives;
}

export function mwLabelPrimitives(
  context: AnnotationContext,
  object: MwLabelsObjectV3,
): VectorPrimitive[] {
  const panel = panelOf(context, object.mwLabels.targetObjectId);
  const source = sourceOf(context, panel);
  const { side, fontSizePt, tickLengthPt, colorHex, showUnit } = object.mwLabels;
  const crop = panelCrop(panel);
  // Markers are read along the crop's vertical center line, so rotation and flips follow.
  const center = panelToSourcePx(crop, source, 0.5, 0.5);
  const edge =
    side === "left" ? panel.transform.xPt : panel.transform.xPt + panel.transform.widthPt;
  const direction = side === "left" ? -1 : 1;
  const style = labelStyle(fontSizePt, colorHex);
  const textOffset = fontSizePt * 0.25;
  const visible = source.markers
    .map((marker) => ({
      marker,
      point: sourcePointOnArtboard(panel, source, center.x, marker.yPx),
    }))
    .filter(({ point }) => point.t >= 0 && point.t <= 1)
    .sort((left, right) => left.point.y - right.point.y);
  const primitives: VectorPrimitive[] = [];
  const middle = (context.metrics.ascentEm - context.metrics.descentEm) * fontSizePt * 0.5;
  for (const { marker, point } of visible) {
    if (tickLengthPt > 0)
      primitives.push({
        type: "path",
        commands: rect(
          Math.min(edge, edge + direction * tickLengthPt),
          point.y - 0.25,
          tickLengthPt,
          0.5,
        ),
        fillHex: colorHex,
      });
    primitives.push(
      textLine(
        context,
        String(Number(marker.kDa.toPrecision(6))),
        style,
        edge + direction * (tickLengthPt + textOffset),
        point.y + middle,
        side === "left" ? "end" : "start",
      ),
    );
  }
  const first = visible[0];
  if (showUnit && first)
    primitives.push(
      textLine(
        context,
        "kDa",
        style,
        edge + direction * (tickLengthPt + textOffset),
        first.point.y + middle - fontSizePt * TEXT_LINE_HEIGHT_EM,
        side === "left" ? "end" : "start",
      ),
    );
  return primitives;
}
