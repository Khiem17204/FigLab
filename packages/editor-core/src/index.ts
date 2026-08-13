import {
  type DisplayTransformV1,
  decodeFigureDocument,
  type FigureDocumentV1,
  type ImageViewObjectV1,
  type NormalizedRect,
  type ObjectTransformV1,
} from "@figlab/figure-schema";

export type PixelRect = { x: number; y: number; width: number; height: number };
export type EditorCommand = (document: FigureDocumentV1) => FigureDocumentV1;
export type ResizeAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const MAX_HISTORY_SNAPSHOTS = 100;

export type EditorSessionState = {
  document: FigureDocumentV1;
  undoStack: FigureDocumentV1[];
  redoStack: FigureDocumentV1[];
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

export function setObjectTransformsCommand(
  transforms: ReadonlyArray<readonly [id: string, transform: ObjectTransformV1]>,
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

export function deleteObjectsCommand(ids: ReadonlyArray<string>): EditorCommand {
  const deleted = new Set(ids);
  return (document) =>
    decodeFigureDocument({
      ...document,
      objects: document.objects.filter((object) => !deleted.has(object.id)),
    });
}

function replaceImageView(
  document: FigureDocumentV1,
  id: string,
  replacement: (object: ImageViewObjectV1) => ImageViewObjectV1,
): FigureDocumentV1 {
  return decodeFigureDocument({
    ...document,
    objects: document.objects.map((object) => (object.id === id ? replacement(object) : object)),
  });
}

export function createSessionState(document: FigureDocumentV1): EditorSessionState {
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

export function proportionallyResizeTransform(
  transform: ObjectTransformV1,
  widthPt: number,
  anchor: ResizeAnchor = "top-left",
): ObjectTransformV1 {
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
  document: FigureDocumentV1,
  objectId: string,
): ImageProvenance | undefined {
  const selected = document.objects.find((object) => object.id === objectId);
  if (selected === undefined) return undefined;
  return {
    assetId: selected.view.sourceAssetId,
    viewport: selected.view.viewport,
    display: selected.view.display,
    siblingImageViewIds: document.objects
      .filter(
        (object) =>
          object.id !== selected.id && object.view.sourceAssetId === selected.view.sourceAssetId,
      )
      .map((object) => object.id),
  };
}
