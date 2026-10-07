import {
  addArtboardCommand,
  groupObjectsCommand,
  MAX_HISTORY_SNAPSHOTS,
  moveObjectsCommand,
  setObjectFlagsCommand,
} from "@figlab/editor-core";
import { createDefaultFigureDocument } from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";

import { createEditorSession } from "./session-store";

describe("editor session crop commands", () => {
  it("clamps a drag crop and commits one image view to the default artboard", () => {
    const session = createEditorSession(createDefaultFigureDocument("artboard-1"));

    session.getState().beginCrop({ x: 0.8, y: 0.9 });
    session.getState().previewCrop({ x: 1.2, y: 1.3 });
    session.getState().commitCrop("asset-1", "view-1");

    const state = session.getState();
    expect(state.document.objects).toEqual([
      expect.objectContaining({
        id: "view-1",
        artboardId: "artboard-1",
        view: expect.objectContaining({
          sourceAssetId: "asset-1",
          viewport: { x: 0.8, y: 0.9, width: 0.2, height: 0.1 },
        }),
      }),
    ]);
    expect(state.history).toHaveLength(1);
    expect(state.cropDraft).toBeUndefined();
  });

  it("keeps pointer movement ephemeral and records only the pointer-up transform", () => {
    const session = createEditorSession(createDefaultFigureDocument("artboard-1"));
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset-1", "view-1");

    session.getState().beginObjectGesture("view-1");
    session.getState().previewObjectTransform({ xPt: 99, yPt: 82, widthPt: 320, heightPt: 240 });
    expect(session.getState().document.objects[0]?.transform.xPt).toBe(48);
    expect(session.getState().history).toHaveLength(1);

    session.getState().commitObjectTransform();
    expect(session.getState().document.objects[0]?.transform).toEqual({
      xPt: 99,
      yPt: 82,
      widthPt: 320,
      heightPt: 240,
      rotationDeg: 0,
    });
    expect(session.getState().history).toHaveLength(2);
  });

  it("previews movement from the gesture origin instead of accumulating pointer events", () => {
    const session = sessionWithView();
    session.getState().setSnapThreshold(0);
    session.getState().beginObjectGesture("view-1");

    session.getState().previewObjectDelta({ x: 20, y: 10 });
    session.getState().previewObjectDelta({ x: 20, y: 10 });

    expect(session.getState().objectGesture?.transform).toMatchObject({ xPt: 68, yPt: 58 });
    expect(session.getState().document.objects[0]?.transform).toMatchObject({ xPt: 48, yPt: 48 });
  });

  it("previews a proportional corner resize and commits one history entry", () => {
    const session = sessionWithView();
    session.getState().beginObjectGesture("view-1");
    session.getState().previewObjectResize({ x: 80, y: 60 }, "bottom-right");

    expect(session.getState().objectGesture?.transform).toEqual({
      xPt: 48,
      yPt: 48,
      widthPt: 320,
      heightPt: 240,
      rotationDeg: 0,
    });
    session.getState().commitObjectTransform();
    expect(session.getState().history).toHaveLength(2);
  });

  it("inherits the core history maximum", () => {
    const session = sessionWithView();
    for (let index = 0; index <= MAX_HISTORY_SNAPSHOTS; index += 1) {
      session.getState().setDisplay("view-1", {
        brightness: (index % 2) * 0.1,
        contrast: 1,
        gamma: 1,
        invert: false,
      });
    }
    expect(session.getState().history).toHaveLength(MAX_HISTORY_SNAPSHOTS);
  });

  it("clamps display controls and restores the preceding command with undo", () => {
    const session = createEditorSession(createDefaultFigureDocument("artboard-1"));
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset-1", "view-1");

    session
      .getState()
      .setDisplay("view-1", { brightness: 7, contrast: -1, gamma: 99, invert: true });
    expect(imageViewAt(session, 0)?.view.display).toEqual({
      brightness: 1,
      contrast: 0,
      gamma: 10,
      invert: true,
    });

    session.getState().undo();
    expect(imageViewAt(session, 0)?.view.display).toEqual({
      brightness: 0,
      contrast: 1,
      gamma: 1,
      invert: false,
    });
    session.getState().redo();
    expect(imageViewAt(session, 0)?.view.display.invert).toBe(true);
  });

  it("deletes the selected panel as an undoable document command", () => {
    const session = sessionWithView();
    session.getState().selectObject("view-1");

    session.getState().deleteSelectedObject();

    expect(session.getState().document.objects).toEqual([]);
    expect(session.getState().selectedObjectId).toBeUndefined();
    session.getState().undo();
    expect(session.getState().document.objects.map((object) => object.id)).toEqual(["view-1"]);
  });
});

describe("editor session selection and figures", () => {
  it("sizes a new panel to the crop's aspect ratio in source pixels", () => {
    const session = createEditorSession(createDefaultFigureDocument("artboard-1"));
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.25 });
    session.getState().commitCrop("asset-1", "view-1", { widthPx: 1000, heightPx: 400 });
    // 500 × 100 source pixels → 240 × 48 pt, no stretching.
    expect(session.getState().document.objects[0]?.transform).toMatchObject({
      widthPt: 240,
      heightPt: 48,
    });
  });

  it("moves a multi-selection with its groups and snaps to the artboard edge", () => {
    const session = sessionWithView();
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset-1", "view-2");
    session.getState().apply(moveObjectsCommand(["view-2"], 300, 300));
    session.getState().apply(groupObjectsCommand("group-1", ["view-1", "view-2"]));
    session.getState().select(["view-1"]);

    session.getState().beginObjectGesture("view-1");
    session.getState().previewObjectDelta({ x: -46, y: 0 });
    const gesture = session.getState().objectGesture;
    expect(gesture?.transforms.get("view-1")?.xPt).toBe(0);
    expect(gesture?.transforms.get("view-2")?.xPt).toBe(300);
    expect(gesture?.guides[0]).toMatchObject({ axis: "x", positionPt: 0 });
    session.getState().commitObjectTransform();
    expect(session.getState().document.objects.map((object) => object.transform.xPt)).toEqual([
      0, 300,
    ]);
    expect(session.getState().history).toHaveLength(5);
  });

  it("toggles selection, applies commands with selection, and restores both on undo", () => {
    const session = sessionWithView();
    session.getState().select(["view-1"]);
    session.getState().select(["view-1"], "toggle");
    expect(session.getState().selectedIds).toEqual([]);
    session.getState().apply(
      addArtboardCommand({
        id: "artboard-2",
        name: "Figure 2",
        widthPt: 300,
        heightPt: 200,
        backgroundHex: "#FFFFFF",
      }),
      { activeArtboardId: "artboard-2" },
    );
    expect(session.getState().activeArtboardId).toBe("artboard-2");
    session.getState().undo();
    expect(session.getState().activeArtboardId).toBe("artboard-1");
    expect(session.getState().document.artboards).toHaveLength(1);
    session.getState().apply((document) => document);
    expect(session.getState().future).toHaveLength(1);
  });

  it("keeps locked objects in place and out of deletion", () => {
    const session = sessionWithView();
    session.getState().apply(setObjectFlagsCommand(["view-1"], { locked: true }));
    session.getState().select(["view-1"]);
    session.getState().beginObjectGesture("view-1");
    expect(session.getState().objectGesture).toBeUndefined();
    session.getState().deleteSelectedObject();
    expect(session.getState().document.objects).toHaveLength(1);
  });

  it("creates new panels on the active artboard", () => {
    const session = sessionWithView();
    session.getState().apply(
      addArtboardCommand({
        id: "artboard-2",
        name: "Figure 2",
        widthPt: 300,
        heightPt: 200,
        backgroundHex: "#FFFFFF",
      }),
      { activeArtboardId: "artboard-2" },
    );
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset-1", "view-2");
    expect(session.getState().document.objects.at(-1)).toMatchObject({
      artboardId: "artboard-2",
      zIndex: 0,
    });
  });
});

function sessionWithView() {
  const session = createEditorSession(createDefaultFigureDocument("artboard-1"));
  session.getState().beginCrop({ x: 0, y: 0 });
  session.getState().previewCrop({ x: 0.5, y: 0.5 });
  session.getState().commitCrop("asset-1", "view-1");
  return session;
}

function imageViewAt(session: ReturnType<typeof createEditorSession>, index: number) {
  const object = session.getState().document.objects[index];
  return object?.type === "image-view" ? object : undefined;
}
