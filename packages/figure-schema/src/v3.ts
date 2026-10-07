import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type ArtboardId, FigureDocumentDecodeError } from "./errors.js";
import { ArtboardV1Schema, NormalizedRectSchema, ObjectTransformV1Schema } from "./v1.js";
import {
  LineObjectV2Schema,
  ObjectGroupV2Schema,
  ShapeObjectV2Schema,
  StrokeV2Schema,
  TextObjectV2Schema,
} from "./v2.js";

const IdSchema = Type.String({ minLength: 1 });
const HexColorSchema = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });
const unit = Type.Number({ minimum: 0, maximum: 1 });

/** Pseudocolor applied after display mapping; `none` keeps the source's own colors. */
export const LutV3Schema = Type.Union([
  Type.Literal("none"),
  Type.Literal("gray"),
  Type.Literal("red"),
  Type.Literal("green"),
  Type.Literal("blue"),
  Type.Literal("cyan"),
  Type.Literal("magenta"),
  Type.Literal("yellow"),
]);

export const DisplayTransformV3Schema = Type.Object(
  {
    /** Input range mapped to [0, 1] before contrast, as fractions of the sample range. */
    levels: Type.Object({ black: unit, white: unit }, { additionalProperties: false }),
    brightness: Type.Number({ minimum: -1, maximum: 1 }),
    contrast: Type.Number({ minimum: 0, maximum: 4 }),
    gamma: Type.Number({ minimum: 0.1, maximum: 10 }),
    invert: Type.Boolean(),
    lut: LutV3Schema,
  },
  { additionalProperties: false },
);

/** How a panel reads its source: which plane and sample, and the crop's orientation. */
const sourceReading = {
  plane: Type.Integer({ minimum: 0, maximum: 10_000 }),
  /** One sample of each pixel (for example the green channel of RGB), or null for all. */
  channel: Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()]),
};

const cropGeometry = {
  /** The crop rectangle before rotation, normalized to the source. */
  viewport: NormalizedRectSchema,
  /** Rotation of the crop rectangle about its center, clockwise, in source pixel space. */
  rotationDeg: Type.Number({ minimum: -180, maximum: 180 }),
  flipX: Type.Boolean(),
  flipY: Type.Boolean(),
};

export const ScientificImageViewV3Schema = Type.Object(
  {
    sourceAssetId: IdSchema,
    ...sourceReading,
    ...cropGeometry,
    display: DisplayTransformV3Schema,
  },
  { additionalProperties: false },
);

const infoText = Type.Optional(Type.String({ maxLength: 200 }));

/**
 * What a panel shows, recorded with the figure so legends and integrity reports can name it:
 * the target protein, antibody and its dilution, lot, supplier, and free notes.
 */
export const SampleInfoV3Schema = Type.Object(
  {
    target: infoText,
    antibody: infoText,
    dilution: infoText,
    lot: infoText,
    supplier: infoText,
    notes: Type.Optional(Type.String({ maxLength: 1000 })),
    /** The panel is the loading control the other blot panels are compared with. */
    loadingControl: Type.Optional(Type.Boolean()),
    /** Where the target's band should run; checked against the original's ladder marks. */
    expectedKDa: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })),
  },
  { additionalProperties: false },
);

const objectBase = {
  id: IdSchema,
  artboardId: IdSchema,
  zIndex: Type.Integer(),
  locked: Type.Boolean(),
  hidden: Type.Boolean(),
};

export const ImageViewObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("image-view"),
    transform: ObjectTransformV1Schema,
    view: ScientificImageViewV3Schema,
    sampleInfo: Type.Optional(SampleInfoV3Schema),
  },
  { additionalProperties: false },
);

export const CompositeChannelV3Schema = Type.Object(
  {
    sourceAssetId: IdSchema,
    ...sourceReading,
    display: DisplayTransformV3Schema,
    visible: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** An additive merge of channels that share one crop of same-sized sources. */
export const CompositeObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("composite"),
    transform: ObjectTransformV1Schema,
    composite: Type.Object(
      {
        ...cropGeometry,
        channels: Type.Array(CompositeChannelV3Schema, { minItems: 1, maxItems: 8 }),
      },
      { additionalProperties: false },
    ),
    sampleInfo: Type.Optional(SampleInfoV3Schema),
  },
  { additionalProperties: false },
);

/** Free position for the bar; its width is always derived from calibration and panel scale. */
export const ScaleBarObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("scale-bar"),
    transform: ObjectTransformV1Schema,
    scaleBar: Type.Object(
      {
        targetObjectId: IdSchema,
        lengthUm: Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 }),
        displayUnit: Type.Union([Type.Literal("nm"), Type.Literal("µm"), Type.Literal("mm")]),
        thicknessPt: Type.Number({ minimum: 0.25, maximum: 20 }),
        colorHex: HexColorSchema,
        showLabel: Type.Boolean(),
        fontSizePt: Type.Number({ minimum: 2, maximum: 72 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Outlines one panel's crop on another panel of the same source; geometry is derived. */
export const ZoomLinkObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("zoom-link"),
    transform: ObjectTransformV1Schema,
    zoomLink: Type.Object(
      {
        sourceObjectId: IdSchema,
        insetObjectId: IdSchema,
        stroke: StrokeV2Schema,
        connectors: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const LaneCellV3Schema = Type.Object(
  {
    text: Type.String({ maxLength: 200 }),
    span: Type.Integer({ minimum: 1, maximum: 48 }),
    underline: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Lane and condition labels (cell lines, +/−, doses) aligned to a blot panel's lanes. */
export const LaneTableObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("lane-table"),
    transform: ObjectTransformV1Schema,
    laneTable: Type.Object(
      {
        targetObjectId: IdSchema,
        lanes: Type.Integer({ minimum: 1, maximum: 48 }),
        /** Lane centers as fractions of the panel width; even spacing when null. */
        laneCenters: Type.Union([Type.Array(unit, { minItems: 1, maxItems: 48 }), Type.Null()]),
        placement: Type.Union([Type.Literal("above"), Type.Literal("below")]),
        rows: Type.Array(
          Type.Object(
            { cells: Type.Array(LaneCellV3Schema, { maxItems: 48 }) },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 20 },
        ),
        fontSizePt: Type.Number({ minimum: 2, maximum: 72 }),
        colorHex: HexColorSchema,
        /** Space between the panel and the nearest row. */
        gapPt: Type.Number({ minimum: 0, maximum: 200 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Molecular-weight ticks beside a blot panel, from the source's marked ladder bands. */
export const MwLabelsObjectV3Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("mw-labels"),
    transform: ObjectTransformV1Schema,
    mwLabels: Type.Object(
      {
        targetObjectId: IdSchema,
        side: Type.Union([Type.Literal("left"), Type.Literal("right")]),
        fontSizePt: Type.Number({ minimum: 2, maximum: 72 }),
        tickLengthPt: Type.Number({ minimum: 0, maximum: 50 }),
        colorHex: HexColorSchema,
        showUnit: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const FigureObjectV3Schema = Type.Union([
  ImageViewObjectV3Schema,
  CompositeObjectV3Schema,
  TextObjectV2Schema,
  LineObjectV2Schema,
  ShapeObjectV2Schema,
  ScaleBarObjectV3Schema,
  ZoomLinkObjectV3Schema,
  LaneTableObjectV3Schema,
  MwLabelsObjectV3Schema,
]);

export const SourceCalibrationV3Schema = Type.Object(
  {
    umPerPxX: Type.Number({ exclusiveMinimum: 0 }),
    umPerPxY: Type.Number({ exclusiveMinimum: 0 }),
    /** `metadata` came from the verified file; `manual` was entered by a person. */
    origin: Type.Union([Type.Literal("metadata"), Type.Literal("manual")]),
  },
  { additionalProperties: false },
);

export const MwMarkerV3Schema = Type.Object(
  {
    yPx: Type.Number({ minimum: 0 }),
    kDa: Type.Number({ exclusiveMinimum: 0, maximum: 10_000 }),
  },
  { additionalProperties: false },
);

/** Measured facts about an immutable original, recorded so figures render deterministically. */
export const SourceInfoV3Schema = Type.Object(
  {
    assetId: IdSchema,
    widthPx: Type.Integer({ minimum: 1 }),
    heightPx: Type.Integer({ minimum: 1 }),
    calibration: Type.Union([SourceCalibrationV3Schema, Type.Null()]),
    markers: Type.Array(MwMarkerV3Schema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

export const FigureDocumentV3Schema = Type.Object(
  {
    schemaVersion: Type.Literal(3),
    artboards: Type.Array(ArtboardV1Schema, { minItems: 1 }),
    sources: Type.Array(SourceInfoV3Schema),
    objects: Type.Array(FigureObjectV3Schema),
    groups: Type.Array(ObjectGroupV2Schema),
    constraints: Type.Tuple([]),
    styles: Type.Tuple([]),
  },
  { additionalProperties: false },
);

export type LutV3 = Static<typeof LutV3Schema>;
export type DisplayTransformV3 = Static<typeof DisplayTransformV3Schema>;
export type ScientificImageViewV3 = Static<typeof ScientificImageViewV3Schema>;
export type ImageViewObjectV3 = Static<typeof ImageViewObjectV3Schema>;
export type CompositeChannelV3 = Static<typeof CompositeChannelV3Schema>;
export type CompositeObjectV3 = Static<typeof CompositeObjectV3Schema>;
export type ScaleBarObjectV3 = Static<typeof ScaleBarObjectV3Schema>;
export type ZoomLinkObjectV3 = Static<typeof ZoomLinkObjectV3Schema>;
export type LaneTableObjectV3 = Static<typeof LaneTableObjectV3Schema>;
export type MwLabelsObjectV3 = Static<typeof MwLabelsObjectV3Schema>;
export type LaneCellV3 = Static<typeof LaneCellV3Schema>;
export type SampleInfoV3 = Static<typeof SampleInfoV3Schema>;
export type FigureObjectV3 = Static<typeof FigureObjectV3Schema>;
export type SourceInfoV3 = Static<typeof SourceInfoV3Schema>;
export type SourceCalibrationV3 = Static<typeof SourceCalibrationV3Schema>;
export type MwMarkerV3 = Static<typeof MwMarkerV3Schema>;
export type FigureDocumentV3 = Static<typeof FigureDocumentV3Schema>;

export const IDENTITY_DISPLAY_V3: DisplayTransformV3 = {
  levels: { black: 0, white: 1 },
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  lut: "none",
};

export function createDefaultFigureDocumentV3(artboardId: ArtboardId): FigureDocumentV3 {
  return {
    schemaVersion: 3,
    artboards: [
      { id: artboardId, name: "Figure 1", widthPt: 612, heightPt: 792, backgroundHex: "#FFFFFF" },
    ],
    sources: [],
    objects: [],
    groups: [],
    constraints: [],
    styles: [],
  };
}

/** Corners of a (possibly rotated) crop in source pixels, clockwise from its top-left. */
export function cropCornersPx(
  crop: { viewport: { x: number; y: number; width: number; height: number }; rotationDeg: number },
  source: { widthPx: number; heightPx: number },
): [number, number][] {
  const width = crop.viewport.width * source.widthPx;
  const height = crop.viewport.height * source.heightPx;
  const cx = (crop.viewport.x + crop.viewport.width / 2) * source.widthPx;
  const cy = (crop.viewport.y + crop.viewport.height / 2) * source.heightPx;
  const radians = (crop.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([dx = 0, dy = 0]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

function invalid(message: string): never {
  throw new FigureDocumentDecodeError("INVALID_DOCUMENT", message);
}

/** Objects whose geometry follows another object, keyed to that object's ID. */
export function attachedTargetIds(object: FigureObjectV3): string[] {
  switch (object.type) {
    case "text":
      return object.panelLabel ? [object.panelLabel.targetObjectId] : [];
    case "scale-bar":
      return [object.scaleBar.targetObjectId];
    case "lane-table":
      return [object.laneTable.targetObjectId];
    case "mw-labels":
      return [object.mwLabels.targetObjectId];
    case "zoom-link":
      return [object.zoomLink.sourceObjectId, object.zoomLink.insetObjectId];
    default:
      return [];
  }
}

const EPSILON_PX = 1e-6;

function assertV3SemanticInvariants(document: FigureDocumentV3): void {
  const artboardIds = new Set<string>();
  for (const artboard of document.artboards) {
    if (artboardIds.has(artboard.id)) invalid("Artboard IDs must be unique");
    artboardIds.add(artboard.id);
  }
  const sources = new Map<string, SourceInfoV3>();
  for (const source of document.sources) {
    if (sources.has(source.assetId)) invalid("Source entries must be unique per asset");
    sources.set(source.assetId, source);
    for (const marker of source.markers)
      if (marker.yPx > source.heightPx) invalid(`A marker on ${source.assetId} lies outside it`);
  }
  const objects = new Map<string, FigureObjectV3>();
  for (const object of document.objects) {
    if (objects.has(object.id)) invalid("Object IDs must be unique");
    objects.set(object.id, object);
    if (!artboardIds.has(object.artboardId))
      invalid(`Object ${object.id} references a missing artboard`);
  }

  const assertCrop = (
    id: string,
    crop: {
      viewport: { x: number; y: number; width: number; height: number };
      rotationDeg: number;
    },
    assetIds: string[],
  ) => {
    const { viewport } = crop;
    if (crop.rotationDeg === 0) {
      if (
        viewport.x + viewport.width > 1 + EPSILON_PX ||
        viewport.y + viewport.height > 1 + EPSILON_PX
      )
        invalid(`Object ${id} has a viewport outside the source image`);
      return;
    }
    for (const assetId of assetIds) {
      const source = sources.get(assetId);
      if (!source) invalid(`Rotated object ${id} needs a source entry for ${assetId}`);
      for (const [x, y] of cropCornersPx(crop, source))
        if (
          x < -EPSILON_PX ||
          y < -EPSILON_PX ||
          x > source.widthPx + EPSILON_PX ||
          y > source.heightPx + EPSILON_PX
        )
          invalid(`Object ${id} has a rotated crop outside the source image`);
    }
  };
  const isPanel = (object: FigureObjectV3 | undefined) =>
    object?.type === "image-view" || object?.type === "composite";
  const panelAssets = (object: FigureObjectV3): string[] =>
    object.type === "image-view"
      ? [object.view.sourceAssetId]
      : object.type === "composite"
        ? object.composite.channels.map((channel) => channel.sourceAssetId)
        : [];

  for (const object of document.objects) {
    if (object.type === "image-view")
      assertCrop(object.id, object.view, [object.view.sourceAssetId]);
    if (object.type === "composite") {
      const assets = panelAssets(object);
      const sizes = new Set(
        assets.map((assetId) => {
          const source = sources.get(assetId);
          if (!source) invalid(`Composite ${object.id} needs a source entry for ${assetId}`);
          return `${source.widthPx}x${source.heightPx}`;
        }),
      );
      if (sizes.size !== 1) invalid(`Composite ${object.id} merges sources of different sizes`);
      assertCrop(object.id, object.composite, assets);
    }
    if (object.type === "line" && object.transform.widthPt === 0 && object.transform.heightPt === 0)
      invalid(`Line ${object.id} has zero length`);
    for (const targetId of attachedTargetIds(object)) {
      const target = objects.get(targetId);
      if (!target || target.id === object.id)
        invalid(`Object ${object.id} references a missing object`);
      if (target.artboardId !== object.artboardId)
        invalid(`Object ${object.id} must be on its target's artboard`);
      if (object.type !== "text" && !isPanel(target))
        invalid(`Object ${object.id} must be attached to an image panel`);
    }
    if (object.type === "scale-bar") {
      const target = objects.get(object.scaleBar.targetObjectId) as FigureObjectV3;
      for (const assetId of panelAssets(target))
        if (!sources.get(assetId)?.calibration)
          invalid(`Scale bar ${object.id} needs a calibrated source`);
    }
    if (object.type === "mw-labels") {
      const target = objects.get(object.mwLabels.targetObjectId) as FigureObjectV3;
      if (target.type !== "image-view" || !sources.has(target.view.sourceAssetId))
        invalid(`MW labels ${object.id} need an image panel with a source entry`);
    }
    if (object.type === "zoom-link") {
      const [from, to] = [object.zoomLink.sourceObjectId, object.zoomLink.insetObjectId].map(
        (id) => objects.get(id) as FigureObjectV3,
      );
      if (!from || !to || from.id === to.id) invalid(`Zoom link ${object.id} needs two panels`);
      const shared = panelAssets(from).some((assetId) => panelAssets(to).includes(assetId));
      if (!shared) invalid(`Zoom link ${object.id} must join panels of the same source`);
      for (const assetId of panelAssets(from))
        if (!sources.has(assetId))
          invalid(`Zoom link ${object.id} needs a source entry for ${assetId}`);
    }
    if (object.type === "lane-table") {
      const { lanes, laneCenters, rows } = object.laneTable;
      if (laneCenters && laneCenters.length !== lanes)
        invalid(`Lane table ${object.id} needs one center per lane`);
      for (const row of rows)
        if (row.cells.reduce((total, cell) => total + cell.span, 0) > lanes)
          invalid(`Lane table ${object.id} has a row wider than its lanes`);
    }
  }

  const groupIds = new Set<string>();
  const grouped = new Set<string>();
  for (const group of document.groups) {
    if (groupIds.has(group.id) || objects.has(group.id))
      invalid("Group IDs must be unique and distinct from object IDs");
    groupIds.add(group.id);
    const artboards = new Set<string>();
    for (const objectId of group.objectIds) {
      const object = objects.get(objectId);
      if (!object) invalid(`Group ${group.id} references a missing object`);
      if (grouped.has(objectId)) invalid(`Object ${objectId} belongs to more than one group`);
      grouped.add(objectId);
      artboards.add(object.artboardId);
    }
    if (artboards.size !== 1) invalid(`Group ${group.id} spans more than one artboard`);
  }
}

/** Strictly decodes a v3 document. */
export function decodeFigureDocumentV3(input: unknown): FigureDocumentV3 {
  if (!Value.Check(FigureDocumentV3Schema, input)) {
    const details = [...Value.Errors(FigureDocumentV3Schema, input)]
      .slice(0, 20)
      .map((error) => `${error.path || "/"}: ${error.message}`);
    throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Invalid figure document", details);
  }
  const document = structuredClone(input) as FigureDocumentV3;
  assertV3SemanticInvariants(document);
  return document;
}
