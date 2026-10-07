import { FigureDocumentDecodeError } from "./errors.js";
import { decodeFigureDocumentV1, type FigureDocumentV1 } from "./v1.js";
import { decodeFigureDocumentV2, type FigureDocumentV2 } from "./v2.js";
import {
  createDefaultFigureDocumentV3,
  decodeFigureDocumentV3,
  type FigureDocumentV3,
  FigureDocumentV3Schema,
  type FigureObjectV3,
  FigureObjectV3Schema,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
} from "./v3.js";

export * from "./errors.js";
export * from "./presets.js";
export * from "./v1.js";
export * from "./v2.js";
export * from "./v3.js";

/** Version every save writes. Older stored versions open through `migrateFigureDocument`. */
export const CURRENT_FIGURE_SCHEMA_VERSION = 3 as const;

export const FigureDocumentSchema = FigureDocumentV3Schema;
export const FigureObjectSchema = FigureObjectV3Schema;
export type FigureDocument = FigureDocumentV3;
export type FigureObject = FigureObjectV3;
export type FigureObjectType = FigureObject["type"];
export type ImageViewObject = ImageViewObjectV3;
export type ImagePanelObject = Extract<FigureObject, { type: "image-view" | "composite" }>;

export const createDefaultFigureDocument = createDefaultFigureDocumentV3;

/** Strictly decodes a current-version document (the shape editor commands produce). */
export function decodeFigureDocument(input: unknown): FigureDocument {
  rejectFutureVersion(input);
  return decodeFigureDocumentV3(input);
}

/**
 * The single entry point for opening a stored or received document: validates it as its own
 * version, then upgrades it step by step to the current version.
 */
export function migrateFigureDocument(input: unknown): FigureDocument {
  rejectFutureVersion(input);
  const version = schemaVersionOf(input);
  if (version === 1) return migrateV2ToV3(migrateV1ToV2(decodeFigureDocumentV1(input)));
  if (version === 2) return migrateV2ToV3(decodeFigureDocumentV2(input));
  if (version === 3) return decodeFigureDocumentV3(input);
  throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Unknown figure schema version");
}

export function serializeFigureDocument(document: FigureDocument): string {
  return JSON.stringify(decodeFigureDocument(document));
}

/** v2 adds object kinds and groups; every v1 document is already a valid v2 document body. */
function migrateV1ToV2(document: FigureDocumentV1): FigureDocumentV2 {
  return decodeFigureDocumentV2({ ...document, schemaVersion: 2, groups: [] });
}

/**
 * v3 adds a source registry, view orientation/plane/channel, levels and LUTs, and new object
 * kinds. Defaults are the identity, so every v2 figure renders exactly as before.
 */
function migrateV2ToV3(document: FigureDocumentV2): FigureDocumentV3 {
  return decodeFigureDocumentV3({
    ...document,
    schemaVersion: 3,
    sources: [],
    objects: document.objects.map((object) =>
      object.type === "image-view"
        ? {
            ...object,
            view: {
              sourceAssetId: object.view.sourceAssetId,
              plane: 0,
              channel: null,
              viewport: object.view.viewport,
              rotationDeg: 0,
              flipX: false,
              flipY: false,
              display: { ...IDENTITY_DISPLAY_V3, ...object.view.display },
            },
          }
        : object,
    ),
  });
}

function schemaVersionOf(input: unknown): unknown {
  return typeof input === "object" && input !== null && "schemaVersion" in input
    ? input.schemaVersion
    : undefined;
}

function rejectFutureVersion(input: unknown): void {
  const version = schemaVersionOf(input);
  if (typeof version === "number" && version > CURRENT_FIGURE_SCHEMA_VERSION)
    throw new FigureDocumentDecodeError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Figure schema version ${version} is newer than supported version ${CURRENT_FIGURE_SCHEMA_VERSION}`,
    );
}

export function isImageView(object: FigureObject): object is ImageViewObjectV3 {
  return object.type === "image-view";
}

/** Image views and composites: objects that draw source pixels. */
export function isImagePanel(object: FigureObject): object is ImagePanelObject {
  return object.type === "image-view" || object.type === "composite";
}

/** Every original a panel reads. */
export function panelAssetIds(object: FigureObject): string[] {
  if (object.type === "image-view") return [object.view.sourceAssetId];
  if (object.type === "composite")
    return [...new Set(object.composite.channels.map((channel) => channel.sourceAssetId))];
  return [];
}
