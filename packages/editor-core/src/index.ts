import {
  type DisplayTransformV1,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  type ImageViewObjectV1,
  isImageView,
  type NormalizedRect,
} from "@figlab/figure-schema";

import { pruneGroups } from "./arrange.js";

export * from "./arrange.js";
export * from "./artboards.js";
export * from "./bounds.js";
export * from "./labels.js";

export type PixelRect = { x: number; y: number; width: number; height: number };
export type EditorCommand = (document: FigureDocument) => FigureDocument;
export type ObjectTransform = FigureObject["transform"];
export type ResizeAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const MAX_HISTORY_SNAPSHOTS = 100;

export type EditorSessionState = {
  document: FigureDocument;
  undoStack: FigureDocument[];
  redoStack: FigureDocument[];
};

export type CreateImageViewInput = Omit<
  ImageViewObjectV1,
  "type" | "locked" | "hidden" | "view"
> & {
  sourceAssetId: string;
  viewport: NormalizedRect;
  display: DisplayTransformV1;
  locked?: boolean;
  hidden?: boolean;
};

export function createImageViewCommand(input: CreateImageViewInput): EditorCommand {
  return (document) =>
    decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        {
          id: input.id,
          artboardId: input.artboardId,
          transform: input.transform,
          zIndex: input.zIndex,
          type: "image-view",
          locked: input.locked ?? false,
          hidden: input.hidden ?? false,
          view: {
            sourceAssetId: input.sourceAssetId,
            viewport: input.viewport,
            display: input.display,
          },
        },
      ],
    });
}

export function setViewportCommand(id: string, viewport: NormalizedRect): EditorCommand {
  return (document) =>
    replaceImageView(document, id, (object) => ({ ...object, view: { ...object.view, viewport } }));
}

export function setDisplayCommand(id: string, display: DisplayTransformV1): EditorCommand {
  return (document) =>
    replaceImageView(document, id, (object) => ({ ...object, view: { ...object.view, display } }));
}

/** Replaces transforms; each must suit its object's kind, or validation rejects the result. */
export function setObjectTransformsCommand(
  transforms: ReadonlyArray<readonly [id: string, transform: ObjectTransform]>,
): EditorCommand {
  const replacements = new Map(transforms);
  return (document) =>
    decodeFigureDocument({
      ...document,
      objects: document.objects.map((object) => {
        const transform = replacements.get(object.id);
        return transform === undefined ? object : { ...object, transform };
      }),
    });
}

export function createObjectCommand(object: FigureObject): EditorCommand {
  return (document) =>
    decodeFigureDocument({ ...document, objects: [...document.objects, object] });
}

/** Replaces one object; the replacement must keep the object's ID and type. */
export function updateObjectCommand(
  id: string,
  replacement: (object: FigureObject) => FigureObject,
): EditorCommand {
  return (document) =>
    decodeFigureDocument({
      ...document,
      objects: document.objects.map((object) => {
        if (object.id !== id) return object;
        const next = replacement(object);
        if (next.id !== object.id || next.type !== object.type)
          throw new Error("An object update cannot change its ID or type");
        return next;
      }),
    });
}

/**
 * Deletes objects together with panel labels attached to them, and drops them from groups;
 * a group left with fewer than two members is dissolved.
 */
export function deleteObjectsCommand(ids: ReadonlyArray<string>): EditorCommand {
  return (document) => {
    const deleted = new Set(ids);
    for (const object of document.objects)
      if (
        object.type === "text" &&
        object.panelLabel &&
        deleted.has(object.panelLabel.targetObjectId)
      )
        deleted.add(object.id);
    return decodeFigureDocument({
      ...document,
      objects: document.objects.filter((object) => !deleted.has(object.id)),
      groups: pruneGroups(document.groups, deleted),
    });
  };
}

function replaceImageView(
  document: FigureDocument,
  id: string,
  replacement: (object: ImageViewObjectV1) => ImageViewObjectV1,
): FigureDocument {
  return decodeFigureDocument({
    ...document,
    objects: document.objects.map((object) =>
      object.id === id && isImageView(object) ? replacement(object) : object,
    ),
  });
}

export function createSessionState(document: FigureDocument): EditorSessionState {
  return { document: decodeFigureDocument(document), undoStack: [], redoStack: [] };
}

export function commitCommand(
  state: EditorSessionState,
  command: EditorCommand,
): EditorSessionState {
  const document = command(state.document);
  return {
    document,
    undoStack: [...state.undoStack, state.document].slice(-MAX_HISTORY_SNAPSHOTS),
    redoStack: [],
  };
}

export function undo(state: EditorSessionState): EditorSessionState {
  const document = state.undoStack.at(-1);
  if (document === undefined) return state;
  return {
    document,
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [state.document, ...state.redoStack].slice(0, MAX_HISTORY_SNAPSHOTS),
  };
}

export function redo(state: EditorSessionState): EditorSessionState {
  const document = state.redoStack[0];
  if (document === undefined) return state;
  return {
    document,
    undoStack: [...state.undoStack, state.document].slice(-MAX_HISTORY_SNAPSHOTS),
    redoStack: state.redoStack.slice(1),
  };
}

export function normalizedToPixelRect(
  viewport: NormalizedRect,
  sourceWidthPx: number,
  sourceHeightPx: number,
): PixelRect {
  const x = Math.floor(viewport.x * sourceWidthPx);
  const y = Math.floor(viewport.y * sourceHeightPx);
  const right = Math.ceil((viewport.x + viewport.width) * sourceWidthPx);
  const bottom = Math.ceil((viewport.y + viewport.height) * sourceHeightPx);
  return { x, y, width: right - x, height: bottom - y };
}

export type BoxTransform = { xPt: number; yPt: number; widthPt: number; heightPt: number };

export function proportionallyResizeTransform<T extends BoxTransform>(
  transform: T,
  widthPt: number,
  anchor: ResizeAnchor = "top-left",
): T {
  if (!(widthPt > 0)) throw new RangeError("Resized width must be positive");
  const heightPt = (transform.heightPt * widthPt) / transform.widthPt;
  const xPt = anchor.endsWith("right")
    ? transform.xPt + transform.widthPt - widthPt
    : transform.xPt;
  const yPt = anchor.startsWith("bottom")
    ? transform.yPt + transform.heightPt - heightPt
    : transform.yPt;
  return { ...transform, xPt, yPt, widthPt, heightPt };
}

export type ImageProvenance = {
  assetId: string;
  viewport: NormalizedRect;
  display: DisplayTransformV1;
  siblingImageViewIds: string[];
};

export function selectImageProvenance(
  document: FigureDocument,
  objectId: string,
): ImageProvenance | undefined {
  const selected = document.objects.find((object) => object.id === objectId);
  if (selected === undefined || !isImageView(selected)) return undefined;
  return {
    assetId: selected.view.sourceAssetId,
    viewport: selected.view.viewport,
    display: selected.view.display,
    siblingImageViewIds: document.objects
      .filter(
        (object) =>
          object.id !== selected.id &&
          isImageView(object) &&
          object.view.sourceAssetId === selected.view.sourceAssetId,
      )
      .map((object) => object.id),
  };
}
