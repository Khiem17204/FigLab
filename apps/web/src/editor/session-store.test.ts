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

  it("clamps display controls and restores the preceding command with undo", () => {
    const session = createEditorSession(createDefaultFigureDocument("artboard-1"));
    session.getState().beginCrop({ x: 0, y: 0 });
    session.getState().previewCrop({ x: 0.5, y: 0.5 });
    session.getState().commitCrop("asset-1", "view-1");

    session
      .getState()
      .setDisplay("view-1", { brightness: 7, contrast: -1, gamma: 99, invert: true });
    expect(session.getState().document.objects[0]?.view.display).toEqual({
      brightness: 1,
      contrast: 0,
      gamma: 10,
      invert: true,
    });

    session.getState().undo();
    expect(session.getState().document.objects[0]?.view.display).toEqual({
      brightness: 0,
      contrast: 1,
      gamma: 1,
      invert: false,
    });
    session.getState().redo();
    expect(session.getState().document.objects[0]?.view.display.invert).toBe(true);
  });
});
