import {
  attachedTargetIds,
  type DisplayTransformV3,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
  isImageView,
  type NormalizedRect,
  type ScientificImageViewV3,
  type SourceInfoV3,
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
  ImageViewObjectV3,
  "type" | "locked" | "hidden" | "view"
> & {
  sourceAssetId: string;
  viewport: NormalizedRect;
  display?: DisplayTransformV3;
  view?: Partial<Omit<ScientificImageViewV3, "sourceAssetId" | "viewport" | "display">>;
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
            plane: 0,
            channel: null,
            viewport: input.viewport,
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            display: input.display ?? { ...IDENTITY_DISPLAY_V3 },
            ...input.view,
          },
        },
      ],
    });
}

export function setViewportCommand(id: string, viewport: NormalizedRect): EditorCommand {
  return (document) =>
    replaceImageView(document, id, (object) => ({ ...object, view: { ...object.view, viewport } }));
}

export function setDisplayCommand(id: string, display: DisplayTransformV3): EditorCommand {
  return (document) =>
    replaceImageView(document, id, (object) => ({ ...object, view: { ...object.view, display } }));
}

/** Changes how a view reads its source: plane, channel, crop rotation, or flips. */
export function setViewCommand(
  id: string,
  patch: Partial<Omit<ScientificImageViewV3, "sourceAssetId">>,
): EditorCommand {
  return (document) =>
    replaceImageView(document, id, (object) => ({ ...object, view: { ...object.view, ...patch } }));
}

/**
 * Records (or updates) measured facts about an original: its size, calibration, and ladder
 * markers. Existing calibration and markers are kept unless the patch replaces them.
 */
export function upsertSourceCommand(
  source: Pick<SourceInfoV3, "assetId" | "widthPx" | "heightPx"> & Partial<SourceInfoV3>,
): EditorCommand {
  return (document) => {
    const existing = document.sources.find((entry) => entry.assetId === source.assetId);
    const next: SourceInfoV3 = {
      calibration: null,
      markers: [],
      ...existing,
      ...source,
    };
    return decodeFigureDocument({
      ...document,
      sources: existing
        ? document.sources.map((entry) => (entry.assetId === source.assetId ? next : entry))
        : [...document.sources, next],
    });
  };
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
 * Deletes objects together with everything attached to them (panel labels, scale bars, lane
 * tables, MW labels, zoom links), and drops them from groups; a group left with fewer than two
 * members is dissolved.
 */
export function deleteObjectsCommand(ids: ReadonlyArray<string>): EditorCommand {
  return (document) => {
    const deleted = new Set(ids);
    for (const object of document.objects)
      if (attachedTargetIds(object).some((target) => deleted.has(target))) deleted.add(object.id);
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
  replacement: (object: ImageViewObjectV3) => ImageViewObjectV3,
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
  rotationDeg: number;
  display: DisplayTransformV3;
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
    rotationDeg: selected.view.rotationDeg,
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
