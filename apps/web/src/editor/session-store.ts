import type {
  DisplayTransformV1,
  FigureDocumentV1,
  ImageViewObjectV1,
  NormalizedRect,
  ObjectTransformV1,
} from "@figlab/figure-schema";
import { createStore } from "zustand/vanilla";

export type Point = { x: number; y: number };

type CropDraft = { start: Point; end: Point };
type ObjectGesture = { objectId: string; transform: ObjectTransformV1 };

type EditorSnapshot = {
  document: FigureDocumentV1;
  selectedObjectId: string | undefined;
};

export type EditorSessionState = EditorSnapshot & {
  history: EditorSnapshot[];
  future: EditorSnapshot[];
  cropDraft?: CropDraft | undefined;
  objectGesture?: ObjectGesture | undefined;
  beginCrop: (point: Point) => void;
  previewCrop: (point: Point) => void;
  commitCrop: (assetId: string, objectId: string) => void;
  beginObjectGesture: (objectId: string) => void;
  previewObjectTransform: (transform: Omit<ObjectTransformV1, "rotationDeg">) => void;
  commitObjectTransform: () => void;
  setDisplay: (objectId: string, display: DisplayTransformV1) => void;
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

const defaultDisplay: DisplayTransformV1 = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
};

const defaultTransform: ObjectTransformV1 = {
  xPt: 48,
  yPt: 48,
  widthPt: 240,
  heightPt: 180,
  rotationDeg: 0,
};

const snapshot = (state: EditorSnapshot): EditorSnapshot => ({
  document: structuredClone(state.document),
  selectedObjectId: state.selectedObjectId,
});

const withObject = (
  document: FigureDocumentV1,
  objectId: string,
  update: (object: ImageViewObjectV1) => ImageViewObjectV1,
): FigureDocumentV1 => ({
  ...document,
  objects: document.objects.map((object) => (object.id === objectId ? update(object) : object)),
});

const clampDisplay = (display: DisplayTransformV1): DisplayTransformV1 => ({
  brightness: Math.min(1, Math.max(-1, display.brightness)),
  contrast: Math.min(4, Math.max(0, display.contrast)),
  gamma: Math.min(10, Math.max(0.1, display.gamma)),
  invert: display.invert,
});

const pushHistory = (
  state: EditorSessionState,
): Pick<EditorSessionState, "history" | "future"> => ({
  history: [...state.history, snapshot(state)].slice(-100),
  future: [],
});

export function createEditorSession(initialDocument: FigureDocumentV1) {
  return createStore<EditorSessionState>()((set, get) => ({
    document: structuredClone(initialDocument),
    selectedObjectId: undefined,
    history: [],
    future: [],
    cropDraft: undefined,
    beginCrop: (point) => set({ cropDraft: { start: point, end: point } }),
    previewCrop: (point) => {
      const draft = get().cropDraft;
      if (draft) set({ cropDraft: { ...draft, end: point } });
    },
    commitCrop: (assetId, objectId) => {
      const state = get();
      if (!state.cropDraft) return;
      const viewport = toViewport(state.cropDraft);
      if (viewport.width === 0 || viewport.height === 0) {
        set({ cropDraft: undefined });
        return;
      }
      const artboardId = state.document.artboards[0]?.id;
      if (!artboardId) return;
      const object: ImageViewObjectV1 = {
        id: objectId,
        type: "image-view",
        artboardId,
        transform: { ...defaultTransform },
        zIndex: state.document.objects.length,
        locked: false,
        hidden: false,
        view: { sourceAssetId: assetId, viewport, display: { ...defaultDisplay } },
      };
      set({
        document: { ...state.document, objects: [...state.document.objects, object] },
        selectedObjectId: objectId,
        ...pushHistory(state),
        cropDraft: undefined,
      });
    },
    beginObjectGesture: (objectId) => {
      const object = get().document.objects.find((candidate) => candidate.id === objectId);
      if (object)
        set({
          selectedObjectId: objectId,
          objectGesture: { objectId, transform: object.transform },
        });
    },
    previewObjectTransform: (transform) => {
      const gesture = get().objectGesture;
      if (gesture)
        set({ objectGesture: { ...gesture, transform: { ...transform, rotationDeg: 0 } } });
    },
    commitObjectTransform: () => {
      const state = get();
      const gesture = state.objectGesture;
      if (!gesture) return;
      set({
        document: withObject(state.document, gesture.objectId, (object) => ({
          ...object,
          transform: gesture.transform,
        })),
        ...pushHistory(state),
        objectGesture: undefined,
      });
    },
    setDisplay: (objectId, display) => {
      const state = get();
      if (!state.document.objects.some((object) => object.id === objectId)) return;
      set({
        document: withObject(state.document, objectId, (object) => ({
          ...object,
          view: { ...object.view, display: clampDisplay(display) },
        })),
        ...pushHistory(state),
      });
    },
    undo: () => {
      const state = get();
      const previous = state.history.at(-1);
      if (!previous) return;
      set({
        ...snapshot(previous),
        history: state.history.slice(0, -1),
        future: [snapshot(state), ...state.future],
        cropDraft: undefined,
        objectGesture: undefined,
      });
    },
    redo: () => {
      const state = get();
      const next = state.future[0];
      if (!next) return;
      set({
        ...snapshot(next),
        history: [...state.history, snapshot(state)].slice(-100),
        future: state.future.slice(1),
        cropDraft: undefined,
        objectGesture: undefined,
      });
    },
  }));
}
