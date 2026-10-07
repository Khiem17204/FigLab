import {
  createDefaultFigureDocument,
  type FigureDocument,
  type ImageViewObjectV3,
  isImageView,
} from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  commitCommand,
  createImageViewCommand,
  createSessionState,
  deleteObjectsCommand,
  MAX_HISTORY_SNAPSHOTS,
  normalizedToPixelRect,
  proportionallyResizeTransform,
  redo,
  selectImageProvenance,
  setDisplayCommand,
  setObjectTransformsCommand,
  setViewportCommand,
  undo,
} from "./index.js";

const display = {
  levels: { black: 0, white: 1 },
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  lut: "none" as const,
};
const reading = { plane: 0, channel: null, rotationDeg: 0, flipX: false, flipY: false };
const viewport = { x: 0.25, y: 0.5, width: 0.75, height: 0.5 };

describe("editor core commands", () => {
  it("creates an immutable image view and applies later viewport and display changes", () => {
    const original = createDefaultFigureDocument("board");
    const created = createImageViewCommand({
      id: "view-a",
      artboardId: "board",
      sourceAssetId: "asset-a",
      viewport,
      display,
      transform: { xPt: 10, yPt: 20, widthPt: 300, heightPt: 200, rotationDeg: 0 },
      zIndex: 1,
    })(original);
    const changed = setDisplayCommand("view-a", { ...display, invert: true })(
      setViewportCommand("view-a", { x: 0, y: 0, width: 0.5, height: 0.5 })(created),
    );

    expect(original.objects).toEqual([]);
    const createdView = created.objects[0];
    const changedView = changed.objects[0];
    if (!createdView || !isImageView(createdView) || !changedView || !isImageView(changedView))
      throw new Error("expected image views");
    expect(createdView.view.viewport).toEqual(viewport);
    expect(changedView.view).toEqual({
      sourceAssetId: "asset-a",
      ...reading,
      viewport: { x: 0, y: 0, width: 0.5, height: 0.5 },
      display: { ...display, invert: true },
    });
  });

  it("sets batched transforms and deletes objects without mutating its input", () => {
    const document = documentWithTwoViews();
    const transformed = setObjectTransformsCommand([
      ["view-a", { xPt: 9, yPt: 8, widthPt: 70, heightPt: 40, rotationDeg: 0 }],
      ["view-b", { xPt: 7, yPt: 6, widthPt: 50, heightPt: 25, rotationDeg: 0 }],
    ])(document);
    const deleted = deleteObjectsCommand(["view-a"])(transformed);

    expect(document.objects.map((object) => object.transform.xPt)).toEqual([0, 10]);
    expect(transformed.objects.map((object) => object.transform.xPt)).toEqual([9, 7]);
    expect(deleted.objects.map((object) => object.id)).toEqual(["view-b"]);
  });

  it("floors crop origins and ceils crop edges when converting to source pixels", () => {
    expect(
      normalizedToPixelRect({ x: 0.101, y: 0.201, width: 0.499, height: 0.499 }, 101, 101),
    ).toEqual({
      x: 10,
      y: 20,
      width: 51,
      height: 51,
    });
    expect(normalizedToPixelRect({ x: 0.25, y: 0.5, width: 0.75, height: 0.5 }, 400, 200)).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 100,
    });
  });

  it("resizes proportionally from a fixed anchor", () => {
    expect(
      proportionallyResizeTransform(
        { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 },
        200,
        "top-left",
      ),
    ).toEqual({ xPt: 10, yPt: 20, widthPt: 200, heightPt: 100, rotationDeg: 0 });
    expect(
      proportionallyResizeTransform(
        { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 },
        200,
        "bottom-right",
      ),
    ).toEqual({ xPt: -90, yPt: -30, widthPt: 200, heightPt: 100, rotationDeg: 0 });
  });

  it("caps undo history at one hundred snapshots and clears redo after a new gesture", () => {
    let state = createSessionState(createDefaultFigureDocument("board"));
    for (let index = 0; index < MAX_HISTORY_SNAPSHOTS + 1; index += 1) {
      state = commitCommand(state, setObjectTransformsCommand([]));
    }
    const undone = undo(state);
    const recommitted = commitCommand(undone, setObjectTransformsCommand([]));

    expect(state.undoStack).toHaveLength(MAX_HISTORY_SNAPSHOTS);
    expect(undone.redoStack).toHaveLength(1);
    expect(recommitted.redoStack).toHaveLength(0);
    expect(redo(recommitted)).toEqual(recommitted);
  });

  it("reports the asset, source view, display, and siblings for image provenance", () => {
    const provenance = selectImageProvenance(documentWithTwoViews(), "view-a");

    expect(provenance).toEqual({
      assetId: "asset-a",
      viewport: { x: 0, y: 0, width: 0.5, height: 0.5 },
      rotationDeg: 0,
      display,
      siblingImageViewIds: ["view-b"],
    });
  });
});

function documentWithTwoViews(): FigureDocument {
  return {
    ...createDefaultFigureDocument("board"),
    objects: [imageView("view-a", "asset-a", 0), imageView("view-b", "asset-a", 10)],
  };
}

function imageView(id: string, sourceAssetId: string, xPt: number): ImageViewObjectV3 {
  return {
    id,
    type: "image-view",
    artboardId: "board",
    transform: { xPt, yPt: 0, widthPt: 100, heightPt: 50, rotationDeg: 0 },
    zIndex: 0,
    locked: false,
    hidden: false,
    view: {
      sourceAssetId,
      ...reading,
      viewport: { x: 0, y: 0, width: 0.5, height: 0.5 },
      display,
    },
  };
}
