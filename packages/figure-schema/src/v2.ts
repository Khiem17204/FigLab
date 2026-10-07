import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type ArtboardId, FigureDocumentDecodeError } from "./errors.js";
import { ArtboardV1Schema, ImageViewObjectV1Schema } from "./v1.js";

/** Line advance for text objects, in ems; the renderer and box sizing both use it. */
export const TEXT_LINE_HEIGHT_EM = 1.2;

const HexColorSchema = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });
const IdSchema = Type.String({ minLength: 1 });

/** Box transform for objects that may rotate about their center (text and box shapes). */
export const RotatableTransformV2Schema = Type.Object(
  {
    xPt: Type.Number(),
    yPt: Type.Number(),
    widthPt: Type.Number({ exclusiveMinimum: 0 }),
    heightPt: Type.Number({ exclusiveMinimum: 0 }),
    rotationDeg: Type.Number({ minimum: -180, maximum: 180 }),
  },
  { additionalProperties: false },
);

/**
 * A line's bounding box. One dimension may be zero (a horizontal or vertical line); the line
 * runs between two opposite corners chosen by `direction`.
 */
export const LineTransformV2Schema = Type.Object(
  {
    xPt: Type.Number(),
    yPt: Type.Number(),
    widthPt: Type.Number({ minimum: 0 }),
    heightPt: Type.Number({ minimum: 0 }),
    rotationDeg: Type.Literal(0),
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

export const StrokeV2Schema = Type.Object(
  {
    colorHex: HexColorSchema,
    widthPt: Type.Number({ minimum: 0.1, maximum: 20 }),
    dashed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const TextStyleV2Schema = Type.Object(
  {
    fontSizePt: Type.Number({ minimum: 2, maximum: 144 }),
    bold: Type.Boolean(),
    italic: Type.Boolean(),
    underline: Type.Boolean(),
    colorHex: HexColorSchema,
    align: Type.Union([Type.Literal("start"), Type.Literal("middle"), Type.Literal("end")]),
    backgroundHex: Type.Union([HexColorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const PanelLabelLinkV2Schema = Type.Object(
  {
    targetObjectId: IdSchema,
    /** Auto labels are renamed by the relabel command; manual labels keep their text. */
    auto: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const TextObjectV2Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("text"),
    transform: RotatableTransformV2Schema,
    text: Type.Object(
      {
        content: Type.String({ minLength: 1, maxLength: 2000 }),
        style: TextStyleV2Schema,
      },
      { additionalProperties: false },
    ),
    panelLabel: Type.Optional(PanelLabelLinkV2Schema),
  },
  { additionalProperties: false },
);

export const LineObjectV2Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("line"),
    transform: LineTransformV2Schema,
    line: Type.Object(
      {
        /** `down` runs top-left → bottom-right; `up` runs bottom-left → top-right. */
        direction: Type.Union([Type.Literal("down"), Type.Literal("up")]),
        heads: Type.Union([
          Type.Literal("none"),
          Type.Literal("start"),
          Type.Literal("end"),
          Type.Literal("both"),
        ]),
        stroke: StrokeV2Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ShapeObjectV2Schema = Type.Object(
  {
    ...objectBase,
    type: Type.Literal("shape"),
    transform: RotatableTransformV2Schema,
    shape: Type.Union([
      Type.Object(
        {
          kind: Type.Union([Type.Literal("rect"), Type.Literal("ellipse")]),
          stroke: Type.Union([StrokeV2Schema, Type.Null()]),
          fillHex: Type.Union([HexColorSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("bracket"),
          /** The side the bracket's end ticks point toward. */
          opening: Type.Union([
            Type.Literal("down"),
            Type.Literal("up"),
            Type.Literal("left"),
            Type.Literal("right"),
          ]),
          stroke: StrokeV2Schema,
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export const FigureObjectV2Schema = Type.Union([
  ImageViewObjectV1Schema,
  TextObjectV2Schema,
  LineObjectV2Schema,
  ShapeObjectV2Schema,
]);

export const ObjectGroupV2Schema = Type.Object(
  {
    id: IdSchema,
    objectIds: Type.Array(IdSchema, { minItems: 2, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const FigureDocumentV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    artboards: Type.Array(ArtboardV1Schema, { minItems: 1 }),
    objects: Type.Array(FigureObjectV2Schema),
    groups: Type.Array(ObjectGroupV2Schema),
    constraints: Type.Tuple([]),
    styles: Type.Tuple([]),
  },
  { additionalProperties: false },
);

export type RotatableTransformV2 = Static<typeof RotatableTransformV2Schema>;
export type LineTransformV2 = Static<typeof LineTransformV2Schema>;
export type StrokeV2 = Static<typeof StrokeV2Schema>;
export type TextStyleV2 = Static<typeof TextStyleV2Schema>;
export type PanelLabelLinkV2 = Static<typeof PanelLabelLinkV2Schema>;
export type TextObjectV2 = Static<typeof TextObjectV2Schema>;
export type LineObjectV2 = Static<typeof LineObjectV2Schema>;
export type ShapeObjectV2 = Static<typeof ShapeObjectV2Schema>;
export type FigureObjectV2 = Static<typeof FigureObjectV2Schema>;
export type ObjectGroupV2 = Static<typeof ObjectGroupV2Schema>;
export type FigureDocumentV2 = Static<typeof FigureDocumentV2Schema>;

export function createDefaultFigureDocumentV2(artboardId: ArtboardId): FigureDocumentV2 {
  return {
    schemaVersion: 2,
    artboards: [
      {
        id: artboardId,
        name: "Figure 1",
        widthPt: 612,
        heightPt: 792,
        backgroundHex: "#FFFFFF",
      },
    ],
    objects: [],
    groups: [],
    constraints: [],
    styles: [],
  };
}

function invalid(message: string): never {
  throw new FigureDocumentDecodeError("INVALID_DOCUMENT", message);
}

function assertV2SemanticInvariants(document: FigureDocumentV2): void {
  const artboardIds = new Set<string>();
  for (const artboard of document.artboards) {
    if (artboardIds.has(artboard.id)) invalid("Artboard IDs must be unique");
    artboardIds.add(artboard.id);
  }

  const objects = new Map<string, FigureObjectV2>();
  for (const object of document.objects) {
    if (objects.has(object.id)) invalid("Object IDs must be unique");
    objects.set(object.id, object);
    if (!artboardIds.has(object.artboardId))
      invalid(`Object ${object.id} references a missing artboard`);
    if (object.type === "image-view") {
      const { viewport } = object.view;
      if (viewport.x + viewport.width > 1 || viewport.y + viewport.height > 1)
        invalid(`Object ${object.id} has a viewport outside the source image`);
    }
    if (object.type === "line" && object.transform.widthPt === 0 && object.transform.heightPt === 0)
      invalid(`Line ${object.id} has zero length`);
  }

  for (const object of document.objects) {
    if (object.type !== "text" || !object.panelLabel) continue;
    const target = objects.get(object.panelLabel.targetObjectId);
    if (!target || target.id === object.id)
      invalid(`Panel label ${object.id} references a missing object`);
    if (target.artboardId !== object.artboardId)
      invalid(`Panel label ${object.id} must be on its target's artboard`);
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

/** Strictly decodes a v2 document. */
export function decodeFigureDocumentV2(input: unknown): FigureDocumentV2 {
  if (!Value.Check(FigureDocumentV2Schema, input)) {
    const details = [...Value.Errors(FigureDocumentV2Schema, input)]
      .slice(0, 20)
      .map((error) => `${error.path || "/"}: ${error.message}`);
    throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Invalid figure document", details);
  }

  const document = structuredClone(input) as FigureDocumentV2;
  assertV2SemanticInvariants(document);
  return document;
}
