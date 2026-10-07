import {
  arrangementUnits,
  artboardBounds,
  type Bounds,
  createImageViewCommand,
  deleteObjectsCommand,
  type EditorCommand,
  expandSelection,
  MAX_HISTORY_SNAPSHOTS,
  type ObjectTransform,
  objectBounds,
  type ResizeAnchor,
  type SnapGuide,
  setDisplayCommand,
  setObjectTransformsCommand,
  snapMove,
  unionBounds,
  upsertSourceCommand,
} from "@figlab/editor-core";
import {
  type DisplayTransformV3,
  type FigureDocument,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
  migrateFigureDocument,
  type NormalizedRect,
} from "@figlab/figure-schema";
import { createStore } from "zustand/vanilla";

import { resizeFreely, resizeFromDraggedCorner } from "./geometry";

export type Point = { x: number; y: number };
export type EditorTool = "select" | "text" | "line" | "arrow" | "rect" | "ellipse" | "bracket";

type CropDraft = { start: Point; end: Point };
/** A pointer gesture in progress; previewed live and committed as one command on pointer-up. */
type ObjectGesture = {
  /** The object the pointer grabbed (kept for the single-object API). */
  objectId: string;
  /** That object's previewed transform. */
  transform: ObjectTransform;
  /** Every object the gesture moves, with its previewed transform. */
  transforms: Map<string, ObjectTransform>;
  guides: SnapGuide[];
};

type EditorSnapshot = {
  document: FigureDocument;
  selectedIds: string[];
  activeArtboardId: string;
};

export type EditorSessionState = EditorSnapshot & {
  /** The first selected object, for single-selection controls. */
  selectedObjectId: string | undefined;
  history: EditorSnapshot[];
  future: EditorSnapshot[];
  tool: EditorTool;
  /** Snap moves to edges and centers within this many points; 0 disables snapping. */
  snapThresholdPt: number;
  cropDraft?: CropDraft | undefined;
  objectGesture?: ObjectGesture | undefined;
  beginCrop: (point: Point) => void;
  previewCrop: (point: Point) => void;
  /**
   * Commits the drafted crop as a new panel on the active artboard. With the source size, the
   * panel takes the crop's true aspect ratio, so export never stretches source pixels.
   */
  commitCrop: (
    assetId: string,
    objectId: string,
    sourceSize?: { widthPx: number; heightPx: number },
    plane?: number,
  ) => void;
  /**
   * Adds a panel for a crop of an original. With the source size, the panel takes the crop's
   * true aspect ratio and the size is recorded in the document's source registry.
   */
  addPanel: (input: {
    assetId: string;
    objectId: string;
    viewport: NormalizedRect;
    rotationDeg?: number;
    plane?: number;
    sourceSize?: { widthPx: number; heightPx: number };
  }) => void;
  beginObjectGesture: (objectId: string) => void;
  previewObjectTransform: (transform: Omit<ObjectTransform, "rotationDeg">) => void;
  /** Moves the grabbed object with its selection, groups, and labels, snapping when enabled. */
  previewObjectDelta: (delta: Point) => void;
  previewObjectResize: (delta: Point, draggedCorner: ResizeAnchor) => void;
  commitObjectTransform: () => void;
  cancelObjectGesture: () => void;
  setDisplay: (objectId: string, display: DisplayTransformV3) => void;
  deleteSelectedObject: () => void;
  selectObject: (objectId: string | undefined) => void;
  /** Replaces the selection, adds to it, or toggles membership. */
  select: (ids: ReadonlyArray<string>, mode?: "replace" | "add" | "toggle") => void;
  setActiveArtboard: (artboardId: string) => void;
  setTool: (tool: EditorTool) => void;
  setSnapThreshold: (thresholdPt: number) => void;
  /** Commits any document command as one undoable step, optionally setting the selection. */
  apply: (
    command: EditorCommand,
    next?: { selectedIds?: ReadonlyArray<string>; activeArtboardId?: string },
  ) => void;
  replaceDocument: (document: unknown) => void;
  undo: () => void;
  redo: () => void;
};

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));
const roundNormalized = (value: number): number => Number(value.toFixed(6));

const toViewport = (draft: CropDraft): NormalizedRect => {
  const start = { x: clampUnit(draft.start.x), y: clampUnit(draft.start.y) };
  const end = { x: clampUnit(draft.end.x), y: clampUnit(draft.end.y) };
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: roundNormalized(x),
    y: roundNormalized(y),
    width: roundNormalized(Math.abs(end.x - start.x)),
    height: roundNormalized(Math.abs(end.y - start.y)),
  };
};

const DEFAULT_PANEL_WIDTH_PT = 240;
const DEFAULT_PANEL_HEIGHT_PT = 180;
const DEFAULT_SNAP_THRESHOLD_PT = 4;

const snapshot = (state: EditorSnapshot): EditorSnapshot => ({
  document: structuredClone(state.document),
  selectedIds: [...state.selectedIds],
  activeArtboardId: state.activeArtboardId,
});

const clampUnitValue = (value: number) => Math.min(1, Math.max(0, value));
const clampDisplay = (display: DisplayTransformV3): DisplayTransformV3 => ({
  levels: {
    black: clampUnitValue(Math.min(display.levels.black, display.levels.white)),
    white: clampUnitValue(Math.max(display.levels.black, display.levels.white)),
  },
  brightness: Math.min(1, Math.max(-1, display.brightness)),
  contrast: Math.min(4, Math.max(0, display.contrast)),
  gamma: Math.min(10, Math.max(0.1, display.gamma)),
  invert: display.invert,
  lut: display.lut,
});

const pushHistory = (
  state: EditorSessionState,
): Pick<EditorSessionState, "history" | "future"> => ({
  history: [...state.history, snapshot(state)].slice(-MAX_HISTORY_SNAPSHOTS),
  future: [],
});

function selection(document: FigureDocument, ids: ReadonlyArray<string>) {
  const existing = new Set(document.objects.map((object) => object.id));
  const selectedIds = ids.filter((id, index) => existing.has(id) && ids.indexOf(id) === index);
  return { selectedIds, selectedObjectId: selectedIds[0] };
}

function validArtboard(document: FigureDocument, artboardId: string | undefined): string {
  return document.artboards.some((artboard) => artboard.id === artboardId)
    ? (artboardId as string)
    : (document.artboards[0]?.id ?? "");
}

function restored(state: EditorSnapshot) {
  return {
    ...snapshot(state),
    ...selection(state.document, state.selectedIds),
    cropDraft: undefined,
    objectGesture: undefined,
  };
}

/** Opens a document of any supported schema version as an editing session at the current one. */
export function createEditorSession(received: unknown) {
  const initialDocument = migrateFigureDocument(received);
  return createStore<EditorSessionState>()((set, get) => ({
    document: initialDocument,
    selectedIds: [],
    selectedObjectId: undefined,
    activeArtboardId: initialDocument.artboards[0]?.id ?? "",
    history: [],
    future: [],
    tool: "select",
    snapThresholdPt: DEFAULT_SNAP_THRESHOLD_PT,
    cropDraft: undefined,
    beginCrop: (point) => set({ cropDraft: { start: point, end: point } }),
    previewCrop: (point) => {
      const draft = get().cropDraft;
      if (draft) set({ cropDraft: { ...draft, end: point } });
    },
    commitCrop: (assetId, objectId, sourceSize, plane) => {
      const state = get();
      if (!state.cropDraft) return;
      const viewport = toViewport(state.cropDraft);
      set({ cropDraft: undefined });
      if (viewport.width === 0 || viewport.height === 0) return;
      get().addPanel({
        assetId,
        objectId,
        viewport,
        ...(plane ? { plane } : {}),
        ...(sourceSize ? { sourceSize } : {}),
      });
    },
    addPanel: ({ assetId, objectId, viewport, rotationDeg = 0, plane = 0, sourceSize }) => {
      const state = get();
      const artboardId = validArtboard(state.document, state.activeArtboardId);
      if (!artboardId) return;
      const heightPt = sourceSize
        ? (DEFAULT_PANEL_WIDTH_PT * viewport.height * sourceSize.heightPx) /
          (viewport.width * sourceSize.widthPx)
        : DEFAULT_PANEL_HEIGHT_PT;
      const onBoard = state.document.objects.filter((object) => object.artboardId === artboardId);
      const object: Omit<ImageViewObjectV3, "type" | "locked" | "hidden" | "view"> = {
        id: objectId,
        artboardId,
        transform: { xPt: 48, yPt: 48, widthPt: DEFAULT_PANEL_WIDTH_PT, heightPt, rotationDeg: 0 },
        zIndex: Math.max(-1, ...onBoard.map((candidate) => candidate.zIndex)) + 1,
      };
      const withSource = sourceSize
        ? upsertSourceCommand({ assetId, ...sourceSize })(state.document)
        : state.document;
      set({
        document: createImageViewCommand({
          ...object,
          sourceAssetId: assetId,
          viewport,
          display: { ...IDENTITY_DISPLAY_V3 },
          view: { rotationDeg, plane },
        })(withSource),
        selectedIds: [objectId],
        selectedObjectId: objectId,
        ...pushHistory(state),
      });
    },
    beginObjectGesture: (objectId) => {
      const state = get();
      const object = state.document.objects.find((candidate) => candidate.id === objectId);
      if (!object || object.locked) return;
      const selectedIds = state.selectedIds.includes(objectId) ? state.selectedIds : [objectId];
      set({
        selectedIds,
        selectedObjectId: selectedIds[0],
        objectGesture: {
          objectId,
          transform: object.transform,
          transforms: new Map([[objectId, object.transform]]),
          guides: [],
        },
      });
    },
    previewObjectTransform: (transform) => {
      const gesture = get().objectGesture;
      if (!gesture) return;
      const next = { ...transform, rotationDeg: gesture.transform.rotationDeg } as ObjectTransform;
      set({
        objectGesture: {
          ...gesture,
          transform: next,
          transforms: new Map([[gesture.objectId, next]]),
          guides: [],
        },
      });
    },
    previewObjectDelta: (delta) => {
      const state = get();
      const gesture = state.objectGesture;
      if (!gesture) return;
      const { document } = state;
      const moving = expandSelection(document, state.selectedIds);
      if (!moving.includes(gesture.objectId)) return;
      const movingSet = new Set(moving);
      const byId = new Map(document.objects.map((object) => [object.id, object]));
      let dx = delta.x;
      let dy = delta.y;
      let guides: SnapGuide[] = [];
      const artboardId = byId.get(gesture.objectId)?.artboardId;
      const artboard = document.artboards.find((board) => board.id === artboardId);
      if (state.snapThresholdPt > 0 && artboard) {
        const units = arrangementUnits(document, state.selectedIds);
        const bounds = unionBounds(units.map((unit) => unit.bounds)) as Bounds;
        const others = document.objects
          .filter(
            (object) =>
              object.artboardId === artboard.id && !object.hidden && !movingSet.has(object.id),
          )
          .map(objectBounds);
        const snapped = snapMove(
          {
            left: bounds.left + dx,
            top: bounds.top + dy,
            right: bounds.right + dx,
            bottom: bounds.bottom + dy,
          },
          others,
          artboardBounds(artboard),
          state.snapThresholdPt,
        );
        dx += snapped.dxPt;
        dy += snapped.dyPt;
        guides = snapped.guides;
      }
      const transforms = new Map<string, ObjectTransform>();
      for (const id of moving) {
        const origin = byId.get(id)?.transform;
        if (origin) transforms.set(id, { ...origin, xPt: origin.xPt + dx, yPt: origin.yPt + dy });
      }
      set({
        objectGesture: {
          ...gesture,
          transform: transforms.get(gesture.objectId) ?? gesture.transform,
          transforms,
          guides,
        },
      });
    },
    previewObjectResize: (delta, draggedCorner) => {
      const gesture = get().objectGesture;
      if (!gesture) return;
      const object = get().document.objects.find((candidate) => candidate.id === gesture.objectId);
      if (!object) return;
      // Image panels keep their crop's aspect ratio; drawn shapes resize freely.
      const transform =
        object.type === "image-view"
          ? resizeFromDraggedCorner(object.transform, draggedCorner, delta)
          : resizeFreely(object.transform, draggedCorner, delta, object.type === "line" ? 0 : 1);
      // A line may be horizontal or vertical, but never a point.
      if (transform.widthPt === 0 && transform.heightPt === 0) return;
      set({
        objectGesture: {
          ...gesture,
          transform,
          transforms: new Map([[gesture.objectId, transform]]),
          guides: [],
        },
      });
    },
    commitObjectTransform: () => {
      const state = get();
      const gesture = state.objectGesture;
      if (!gesture) return;
      const changed = [...gesture.transforms].filter(([id, transform]) => {
        const current = state.document.objects.find((object) => object.id === id)?.transform;
        return JSON.stringify(current) !== JSON.stringify(transform);
      });
      if (changed.length === 0) {
        set({ objectGesture: undefined });
        return;
      }
      set({
        document: setObjectTransformsCommand(changed)(state.document),
        ...pushHistory(state),
        objectGesture: undefined,
      });
    },
    cancelObjectGesture: () => set({ objectGesture: undefined }),
    setDisplay: (objectId, display) => {
      const state = get();
      if (!state.document.objects.some((object) => object.id === objectId)) return;
      set({
        document: setDisplayCommand(objectId, clampDisplay(display))(state.document),
        ...pushHistory(state),
      });
    },
    deleteSelectedObject: () => {
      const state = get();
      const ids = state.selectedIds.filter(
        (id) => !state.document.objects.find((object) => object.id === id)?.locked,
      );
      if (ids.length === 0) return;
      set({
        document: deleteObjectsCommand(ids)(state.document),
        selectedIds: [],
        selectedObjectId: undefined,
        ...pushHistory(state),
      });
    },
    selectObject: (objectId) => get().select(objectId ? [objectId] : []),
    select: (ids, mode = "replace") => {
      const state = get();
      let next: string[];
      if (mode === "replace") next = [...ids];
      else if (mode === "add") next = [...state.selectedIds, ...ids];
      else {
        next = [...state.selectedIds];
        for (const id of ids) {
          const index = next.indexOf(id);
          if (index >= 0) next.splice(index, 1);
          else next.push(id);
        }
      }
      const result = selection(state.document, next);
      const first = state.document.objects.find((object) => object.id === result.selectedObjectId);
      set({ ...result, ...(first ? { activeArtboardId: first.artboardId } : {}) });
    },
    setActiveArtboard: (artboardId) => {
      const state = get();
      if (!state.document.artboards.some((artboard) => artboard.id === artboardId)) return;
      if (artboardId === state.activeArtboardId) return;
      set({ activeArtboardId: artboardId, selectedIds: [], selectedObjectId: undefined });
    },
    setTool: (tool) => set({ tool }),
    setSnapThreshold: (thresholdPt) => set({ snapThresholdPt: Math.max(0, thresholdPt) }),
    apply: (command, next = {}) => {
      const state = get();
      const document = command(state.document);
      // Documents hold no raster bytes, so comparing them to skip no-op history entries is cheap.
      if (JSON.stringify(document) === JSON.stringify(state.document)) return;
      const activeArtboardId = validArtboard(
        document,
        next.activeArtboardId ?? state.activeArtboardId,
      );
      set({
        document,
        ...selection(document, next.selectedIds ?? state.selectedIds),
        activeArtboardId,
        ...pushHistory(state),
      });
    },
    replaceDocument: (received) => {
      const document = migrateFigureDocument(received);
      set({
        document,
        selectedIds: [],
        selectedObjectId: undefined,
        activeArtboardId: validArtboard(document, get().activeArtboardId),
        history: [],
        future: [],
        cropDraft: undefined,
        objectGesture: undefined,
      });
    },
    undo: () => {
      const state = get();
      const previous = state.history.at(-1);
      if (!previous) return;
      set({
        ...restored(previous),
        history: state.history.slice(0, -1),
        future: [snapshot(state), ...state.future],
      });
    },
    redo: () => {
      const state = get();
      const next = state.future[0];
      if (!next) return;
      set({
        ...restored(next),
        history: [...state.history, snapshot(state)].slice(-MAX_HISTORY_SNAPSHOTS),
        future: state.future.slice(1),
      });
    },
  }));
}
