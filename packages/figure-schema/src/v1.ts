import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type ArtboardId, FigureDocumentDecodeError } from "./errors.js";

export const NormalizedRectSchema = Type.Object(
  {
    x: Type.Number({ minimum: 0, maximum: 1 }),
    y: Type.Number({ minimum: 0, maximum: 1 }),
    width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const DisplayTransformV1Schema = Type.Object(
  {
    brightness: Type.Number({ minimum: -1, maximum: 1 }),
    contrast: Type.Number({ minimum: 0, maximum: 4 }),
    gamma: Type.Number({ minimum: 0.1, maximum: 10 }),
    invert: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ScientificImageViewV1Schema = Type.Object(
  {
    sourceAssetId: Type.String({ minLength: 1 }),
    viewport: NormalizedRectSchema,
    display: DisplayTransformV1Schema,
  },
  { additionalProperties: false },
);

export const ObjectTransformV1Schema = Type.Object(
  {
    xPt: Type.Number(),
    yPt: Type.Number(),
    widthPt: Type.Number({ exclusiveMinimum: 0 }),
    heightPt: Type.Number({ exclusiveMinimum: 0 }),
    rotationDeg: Type.Literal(0),
  },
  { additionalProperties: false },
);

export const ImageViewObjectV1Schema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.Literal("image-view"),
    artboardId: Type.String({ minLength: 1 }),
    transform: ObjectTransformV1Schema,
    zIndex: Type.Integer(),
    locked: Type.Boolean(),
    hidden: Type.Boolean(),
    view: ScientificImageViewV1Schema,
  },
  { additionalProperties: false },
);

export const ArtboardV1Schema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    widthPt: Type.Number({ exclusiveMinimum: 0 }),
    heightPt: Type.Number({ exclusiveMinimum: 0 }),
    backgroundHex: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
  },
  { additionalProperties: false },
);

export const FigureDocumentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    artboards: Type.Array(ArtboardV1Schema, { minItems: 1 }),
    objects: Type.Array(ImageViewObjectV1Schema),
    groups: Type.Tuple([]),
    constraints: Type.Tuple([]),
    styles: Type.Tuple([]),
  },
  { additionalProperties: false },
);

export type NormalizedRect = Static<typeof NormalizedRectSchema>;
export type DisplayTransformV1 = Static<typeof DisplayTransformV1Schema>;
export type ScientificImageViewV1 = Static<typeof ScientificImageViewV1Schema>;
export type ObjectTransformV1 = Static<typeof ObjectTransformV1Schema>;
export type ImageViewObjectV1 = Static<typeof ImageViewObjectV1Schema>;
export type ArtboardV1 = Static<typeof ArtboardV1Schema>;
export type FigureDocumentV1 = Static<typeof FigureDocumentV1Schema>;

export function createDefaultFigureDocumentV1(artboardId: ArtboardId): FigureDocumentV1 {
  return {
    schemaVersion: 1,
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

function assertV1SemanticInvariants(document: FigureDocumentV1): void {
  const artboardIds = new Set<string>();
  for (const artboard of document.artboards) {
    if (artboardIds.has(artboard.id)) {
      throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Artboard IDs must be unique");
    }
    artboardIds.add(artboard.id);
  }

  const objectIds = new Set<string>();
  for (const object of document.objects) {
    if (objectIds.has(object.id)) {
      throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Object IDs must be unique");
    }
    objectIds.add(object.id);
    if (!artboardIds.has(object.artboardId)) {
      throw new FigureDocumentDecodeError(
        "INVALID_DOCUMENT",
        `Object ${object.id} references a missing artboard`,
      );
    }

    const { viewport } = object.view;
    if (viewport.x + viewport.width > 1 || viewport.y + viewport.height > 1) {
      throw new FigureDocumentDecodeError(
        "INVALID_DOCUMENT",
        `Object ${object.id} has a viewport outside the source image`,
      );
    }
  }
}

/** Strictly decodes a v1 document. Use `migrateFigureDocument` to open stored documents. */
export function decodeFigureDocumentV1(input: unknown): FigureDocumentV1 {
  if (!Value.Check(FigureDocumentV1Schema, input)) {
    const details = [...Value.Errors(FigureDocumentV1Schema, input)].map(
      (error) => `${error.path || "/"}: ${error.message}`,
    );
    throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Invalid v1 figure document", details);
  }

  const document = structuredClone(input) as FigureDocumentV1;
  assertV1SemanticInvariants(document);
  return document;
}
