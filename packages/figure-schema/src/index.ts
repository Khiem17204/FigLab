import { FigureDocumentDecodeError } from "./errors.js";
import { decodeFigureDocumentV1, type FigureDocumentV1 } from "./v1.js";
import {
  createDefaultFigureDocumentV2,
  decodeFigureDocumentV2,
  type FigureDocumentV2,
  FigureDocumentV2Schema,
  type FigureObjectV2,
  FigureObjectV2Schema,
} from "./v2.js";

export * from "./errors.js";
export * from "./presets.js";
export * from "./v1.js";
export * from "./v2.js";

/** Version every save writes. Older stored versions open through `migrateFigureDocument`. */
export const CURRENT_FIGURE_SCHEMA_VERSION = 2 as const;

export const FigureDocumentSchema = FigureDocumentV2Schema;
export const FigureObjectSchema = FigureObjectV2Schema;
export type FigureDocument = FigureDocumentV2;
export type FigureObject = FigureObjectV2;
export type FigureObjectType = FigureObject["type"];

export const createDefaultFigureDocument = createDefaultFigureDocumentV2;

/** Strictly decodes a current-version document (the shape editor commands produce). */
export function decodeFigureDocument(input: unknown): FigureDocument {
  rejectFutureVersion(input);
  return decodeFigureDocumentV2(input);
}

/**
 * The single entry point for opening a stored or received document: validates it as its own
 * version, then upgrades it step by step to the current version.
 */
export function migrateFigureDocument(input: unknown): FigureDocument {
  rejectFutureVersion(input);
  const version = schemaVersionOf(input);
  if (version === 1) return migrateV1ToV2(decodeFigureDocumentV1(input));
  if (version === 2) return decodeFigureDocumentV2(input);
  throw new FigureDocumentDecodeError("INVALID_DOCUMENT", "Unknown figure schema version");
}

export function serializeFigureDocument(document: FigureDocument): string {
  return JSON.stringify(decodeFigureDocument(document));
}

/** v2 adds object kinds and groups; every v1 document is already a valid v2 document body. */
function migrateV1ToV2(document: FigureDocumentV1): FigureDocumentV2 {
  return decodeFigureDocumentV2({ ...document, schemaVersion: 2, groups: [] });
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

export function isImageView(
  object: FigureObject,
): object is Extract<FigureObject, { type: "image-view" }> {
  return object.type === "image-view";
}
