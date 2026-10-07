import {
  type FigureDocument,
  type FigureObject,
  type ImagePanelObject,
  isImagePanel,
  type StrokeV2,
  TEXT_LINE_HEIGHT_EM,
  type TextStyleV2,
} from "@figlab/figure-schema";

import {
  type AnnotationContext,
  laneTablePrimitives,
  mwLabelPrimitives,
  scaleBarPrimitives,
  zoomLinkPrimitives,
} from "./scene-annotations.js";

/** Font facts the layout needs; supplied by the bundled font so every renderer agrees. */
export type TextMetrics = {
  /** Width of one line in points, without kerning. */
  measure(text: string, style: TextStyleV2): number;
  ascentEm: number;
  descentEm: number;
  underlinePositionEm: number;
  underlineThicknessEm: number;
};

export type PathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "Z" };

export type StrokeStyle = { colorHex: string; widthPt: number; dash: number[] };

export type VectorPrimitive =
  | { type: "path"; commands: PathCommand[]; stroke?: StrokeStyle; fillHex?: string }
  | {
      type: "ellipse";
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      stroke?: StrokeStyle;
      fillHex?: string;
    }
  | {
      type: "text";
      text: string;
      /** Left end of the baseline, in points. */
      x: number;
      baselineY: number;
      fontSizePt: number;
      bold: boolean;
      italic: boolean;
      colorHex: string;
    };

export type Bounds = { left: number; top: number; right: number; bottom: number };

export type RasterSceneItem = { kind: "raster"; object: ImagePanelObject };
export type VectorSceneItem = {
  kind: "vector";
  objectId: string;
  primitives: VectorPrimitive[];
  /** Rotation in degrees (clockwise on screen) about a center point, applied to all primitives. */
  rotation?: { deg: number; cx: number; cy: number };
  /** Conservative axis-aligned bounds of the drawn result, including stroke and rotation. */
  bounds: Bounds;
};
export type SceneItem = RasterSceneItem | VectorSceneItem;

export type ArtboardScene = {
  artboardId: string;
  widthPt: number;
  heightPt: number;
  backgroundHex: string;
  /** Visible objects in paint order (z-index, then document order). */
  items: SceneItem[];
};

/**
 * Resolves one artboard into an ordered draw list. Image panels stay references to their
 * immutable source; every other object becomes explicit geometry, so the preview and each
 * export format draw identical positions from the same layout.
 */
export function buildArtboardScene(
  document: FigureDocument,
  artboardId: string,
  metrics: TextMetrics,
): ArtboardScene {
  const artboard = document.artboards.find((candidate) => candidate.id === artboardId);
  if (artboard === undefined) throw new Error(`Artboard ${artboardId} was not found`);
  const context: AnnotationContext = {
    metrics,
    objects: new Map(document.objects.map((object) => [object.id, object])),
    sources: new Map(document.sources.map((source) => [source.assetId, source])),
  };
  const items = document.objects
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => object.artboardId === artboardId && !object.hidden)
    .sort((left, right) => left.object.zIndex - right.object.zIndex || left.index - right.index)
    .map(({ object }) => sceneItem(object, context));
  return {
    artboardId,
    widthPt: artboard.widthPt,
    heightPt: artboard.heightPt,
    backgroundHex: artboard.backgroundHex,
    items,
  };
}

function sceneItem(object: FigureObject, context: AnnotationContext): SceneItem {
  if (isImagePanel(object)) return { kind: "raster", object };
  const primitives = vectorPrimitives(object, context);
  const { xPt, yPt, widthPt, heightPt, rotationDeg } = object.transform;
  const rotation =
    rotationDeg === 0
      ? undefined
      : { deg: rotationDeg, cx: xPt + widthPt / 2, cy: yPt + heightPt / 2 };
  return {
    kind: "vector",
    objectId: object.id,
    primitives,
    ...(rotation ? { rotation } : {}),
    bounds: rotatedBounds(primitivesBounds(primitives), rotation),
  };
}

function vectorPrimitives(
  object: Exclude<FigureObject, ImagePanelObject>,
  context: AnnotationContext,
): VectorPrimitive[] {
  switch (object.type) {
    case "text":
      return textPrimitives(object, context.metrics);
    case "line":
      return linePrimitives(object);
    case "shape":
      return shapePrimitives(object);
    case "scale-bar":
      return scaleBarPrimitives(context, object);
    case "zoom-link":
      return zoomLinkPrimitives(context, object);
    case "lane-table":
      return laneTablePrimitives(context, object);
    case "mw-labels":
      return mwLabelPrimitives(context, object);
  }
}

/**
 * Keeps each derived object's stored box (used for selection and arrangement) equal to the
 * bounds it actually draws at. Rendering never relies on these stored sizes.
 */
export function syncDerivedTransforms(
  document: FigureDocument,
  metrics: TextMetrics,
): FigureDocument {
  const context: AnnotationContext = {
    metrics,
    objects: new Map(document.objects.map((object) => [object.id, object])),
    sources: new Map(document.sources.map((source) => [source.assetId, source])),
  };
  let changed = false;
  const objects = document.objects.map((object) => {
    if (
      object.type !== "scale-bar" &&
      object.type !== "zoom-link" &&
      object.type !== "lane-table" &&
      object.type !== "mw-labels"
    )
      return object;
    let bounds: Bounds;
    try {
      bounds = primitivesBounds(vectorPrimitives(object, context), metrics);
    } catch {
      return object;
    }
    const transform = {
      ...object.transform,
      ...(object.type === "scale-bar" ? {} : { xPt: bounds.left, yPt: bounds.top }),
      widthPt: Math.max(
        0.01,
        bounds.right - (object.type === "scale-bar" ? object.transform.xPt : bounds.left),
      ),
      heightPt: Math.max(
        0.01,
        bounds.bottom - (object.type === "scale-bar" ? object.transform.yPt : bounds.top),
      ),
    };
    const same = (["xPt", "yPt", "widthPt", "heightPt"] as const).every(
      (key) => Math.abs(transform[key] - object.transform[key]) < 1e-6,
    );
    if (same) return object;
    changed = true;
    return { ...object, transform } as FigureObject;
  });
  return changed ? { ...document, objects } : document;
}

function strokeStyle(stroke: StrokeV2): StrokeStyle {
  return {
    colorHex: stroke.colorHex,
    widthPt: stroke.widthPt,
    dash: stroke.dashed ? [stroke.widthPt * 3, stroke.widthPt * 2] : [],
  };
}

const rectPath = (left: number, top: number, width: number, height: number): PathCommand[] => [
  { op: "M", x: left, y: top },
  { op: "L", x: left + width, y: top },
  { op: "L", x: left + width, y: top + height },
  { op: "L", x: left, y: top + height },
  { op: "Z" },
];

function textPrimitives(
  object: Extract<FigureObject, { type: "text" }>,
  metrics: TextMetrics,
): VectorPrimitive[] {
  const { style } = object.text;
  const { xPt, yPt, widthPt, heightPt } = object.transform;
  const size = style.fontSizePt;
  const lineHeight = size * TEXT_LINE_HEIGHT_EM;
  const halfLeading = (lineHeight - (metrics.ascentEm + metrics.descentEm) * size) / 2;
  const primitives: VectorPrimitive[] = [];
  if (style.backgroundHex !== null)
    primitives.push({
      type: "path",
      commands: rectPath(xPt, yPt, widthPt, heightPt),
      fillHex: style.backgroundHex,
    });
  object.text.content.split("\n").forEach((line, index) => {
    const lineWidth = metrics.measure(line, style);
    const x =
      style.align === "start"
        ? xPt
        : style.align === "middle"
          ? xPt + (widthPt - lineWidth) / 2
          : xPt + widthPt - lineWidth;
    const baselineY = yPt + index * lineHeight + halfLeading + metrics.ascentEm * size;
    if (line.length > 0)
      primitives.push({
        type: "text",
        text: line,
        x,
        baselineY,
        fontSizePt: size,
        bold: style.bold,
        italic: style.italic,
        colorHex: style.colorHex,
      });
    if (style.underline && lineWidth > 0) {
      const thickness = metrics.underlineThicknessEm * size;
      const top = baselineY - metrics.underlinePositionEm * size - thickness / 2;
      primitives.push({
        type: "path",
        commands: rectPath(x, top, lineWidth, thickness),
        fillHex: style.colorHex,
      });
    }
  });
  return primitives;
}

function linePrimitives(object: Extract<FigureObject, { type: "line" }>): VectorPrimitive[] {
  const { xPt, yPt, widthPt, heightPt } = object.transform;
  const { direction, heads, stroke } = object.line;
  const start = direction === "down" ? { x: xPt, y: yPt } : { x: xPt, y: yPt + heightPt };
  const end =
    direction === "down" ? { x: xPt + widthPt, y: yPt + heightPt } : { x: xPt + widthPt, y: yPt };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const unit = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const headLength = Math.max(4, stroke.widthPt * 4);
  const headHalfWidth = headLength * 0.4;
  // Shorten the shaft under each head so a wide stroke cannot poke through the tip.
  const inset = Math.min(headLength * 0.8, length / 2);
  const startHead = heads === "start" || heads === "both";
  const endHead = heads === "end" || heads === "both";
  const shaftStart = startHead
    ? { x: start.x + unit.x * inset, y: start.y + unit.y * inset }
    : start;
  const shaftEnd = endHead ? { x: end.x - unit.x * inset, y: end.y - unit.y * inset } : end;
  const primitives: VectorPrimitive[] = [
    {
      type: "path",
      commands: [
        { op: "M", ...shaftStart },
        { op: "L", ...shaftEnd },
      ],
      stroke: strokeStyle(stroke),
    },
  ];
  const head = (tip: { x: number; y: number }, direction: { x: number; y: number }) => {
    const base = { x: tip.x - direction.x * headLength, y: tip.y - direction.y * headLength };
    const normal = { x: -direction.y * headHalfWidth, y: direction.x * headHalfWidth };
    primitives.push({
      type: "path",
      commands: [
        { op: "M", ...tip },
        { op: "L", x: base.x + normal.x, y: base.y + normal.y },
        { op: "L", x: base.x - normal.x, y: base.y - normal.y },
        { op: "Z" },
      ],
      fillHex: stroke.colorHex,
    });
  };
  if (endHead) head(end, unit);
  if (startHead) head(start, { x: -unit.x, y: -unit.y });
  return primitives;
}

function shapePrimitives(object: Extract<FigureObject, { type: "shape" }>): VectorPrimitive[] {
  const { xPt, yPt, widthPt, heightPt } = object.transform;
  const { shape } = object;
  if (shape.kind === "bracket") {
    const right = xPt + widthPt;
    const bottom = yPt + heightPt;
    const points =
      shape.opening === "down"
        ? [
            [xPt, bottom],
            [xPt, yPt],
            [right, yPt],
            [right, bottom],
          ]
        : shape.opening === "up"
          ? [
              [xPt, yPt],
              [xPt, bottom],
              [right, bottom],
              [right, yPt],
            ]
          : shape.opening === "right"
            ? [
                [right, yPt],
                [xPt, yPt],
                [xPt, bottom],
                [right, bottom],
              ]
            : [
                [xPt, yPt],
                [right, yPt],
                [right, bottom],
                [xPt, bottom],
              ];
    return [
      {
        type: "path",
        commands: points.map(([x = 0, y = 0], index) => ({ op: index === 0 ? "M" : "L", x, y })),
        stroke: strokeStyle(shape.stroke),
      },
    ];
  }
  const paint = {
    ...(shape.stroke ? { stroke: strokeStyle(shape.stroke) } : {}),
    ...(shape.fillHex ? { fillHex: shape.fillHex } : {}),
  };
  if (shape.kind === "ellipse")
    return [
      {
        type: "ellipse",
        cx: xPt + widthPt / 2,
        cy: yPt + heightPt / 2,
        rx: widthPt / 2,
        ry: heightPt / 2,
        ...paint,
      },
    ];
  return [{ type: "path", commands: rectPath(xPt, yPt, widthPt, heightPt), ...paint }];
}

/** Bounds of drawn primitives: conservative for rasterizing, or exact when given font metrics. */
function primitivesBounds(primitives: ReadonlyArray<VectorPrimitive>, exact?: TextMetrics): Bounds {
  const bounds: Bounds = {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  const include = (x: number, y: number, pad: number) => {
    bounds.left = Math.min(bounds.left, x - pad);
    bounds.top = Math.min(bounds.top, y - pad);
    bounds.right = Math.max(bounds.right, x + pad);
    bounds.bottom = Math.max(bounds.bottom, y + pad);
  };
  for (const primitive of primitives) {
    if (primitive.type === "path") {
      // Miter joins can extend past half the stroke width; pad generously.
      const pad = (primitive.stroke?.widthPt ?? 0) * 2;
      for (const command of primitive.commands)
        if (command.op !== "Z") include(command.x, command.y, pad);
    } else if (primitive.type === "ellipse") {
      const pad = (primitive.stroke?.widthPt ?? 0) / 2;
      include(primitive.cx - primitive.rx, primitive.cy - primitive.ry, pad);
      include(primitive.cx + primitive.rx, primitive.cy + primitive.ry, pad);
    } else {
      const size = primitive.fontSizePt;
      if (exact) {
        // Exact boxes (for selection) use the measured advance and the font's vertical extent.
        const width = exact.measure(primitive.text, {
          fontSizePt: size,
          bold: primitive.bold,
          italic: primitive.italic,
          underline: false,
          colorHex: primitive.colorHex,
          align: "start",
          backgroundHex: null,
        });
        include(primitive.x, primitive.baselineY - exact.ascentEm * size, 0);
        include(primitive.x + width, primitive.baselineY + exact.descentEm * size, 0);
      } else {
        // Glyphs may overhang their advance; allow an em around the baseline box.
        include(primitive.x, primitive.baselineY - size * 1.2, size * 0.3);
        include(
          primitive.x + primitive.text.length * size * 1.2,
          primitive.baselineY + size * 0.4,
          0,
        );
      }
    }
  }
  if (!Number.isFinite(bounds.left)) return { left: 0, top: 0, right: 0, bottom: 0 };
  return bounds;
}

function rotatedBounds(bounds: Bounds, rotation: VectorSceneItem["rotation"]): Bounds {
  if (!rotation) return bounds;
  const radians = (rotation.deg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [bounds.left, bounds.top],
    [bounds.right, bounds.top],
    [bounds.right, bounds.bottom],
    [bounds.left, bounds.bottom],
  ].map(([x = 0, y = 0]) => {
    const dx = x - rotation.cx;
    const dy = y - rotation.cy;
    return [rotation.cx + dx * cos - dy * sin, rotation.cy + dx * sin + dy * cos] as const;
  });
  return {
    left: Math.min(...corners.map(([x]) => x)),
    top: Math.min(...corners.map(([, y]) => y)),
    right: Math.max(...corners.map(([x]) => x)),
    bottom: Math.max(...corners.map(([, y]) => y)),
  };
}
