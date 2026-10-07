import {
  createDefaultFigureDocument,
  type FigureDocument,
  type FigureObject,
} from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  addArtboardCommand,
  addPanelLabelsCommand,
  alignObjectsCommand,
  arrangementUnits,
  artboardBounds,
  deleteObjectsCommand,
  distributeObjectsCommand,
  duplicateArtboardCommand,
  duplicateObjects,
  groupObjectsCommand,
  moveArtboardCommand,
  moveObjectsCommand,
  objectBounds,
  panelLabelText,
  readingOrder,
  relabelPanelsCommand,
  removeArtboardCommand,
  reorderObjectsCommand,
  setObjectFlagsCommand,
  snapMove,
  ungroupObjectsCommand,
  updateArtboardCommand,
  updateObjectCommand,
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

function view(id: string, xPt: number, yPt: number, size = 100, zIndex = 0): FigureObject {
  return {
    id,
    type: "image-view",
    artboardId: "board",
    transform: { xPt, yPt, widthPt: size, heightPt: size, rotationDeg: 0 },
    zIndex,
    locked: false,
    hidden: false,
    view: {
      sourceAssetId: "asset",
      ...reading,
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      display,
    },
  };
}

function documentWith(...objects: FigureObject[]): FigureDocument {
  return { ...createDefaultFigureDocument("board"), objects };
}

const positions = (document: FigureDocument) =>
  Object.fromEntries(
    document.objects.map((object) => [object.id, [object.transform.xPt, object.transform.yPt]]),
  );

const ids = (prefix = "new") => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};

describe("bounds and snapping", () => {
  it("covers a rotated box with its axis-aligned bounds", () => {
    const bounds = objectBounds({
      ...(view("a", 0, 0) as Extract<FigureObject, { type: "image-view" }>),
      type: "text",
      transform: { xPt: 0, yPt: 0, widthPt: 20, heightPt: 10, rotationDeg: 90 },
      text: {
        content: "x",
        style: {
          fontSizePt: 8,
          bold: false,
          italic: false,
          underline: false,
          colorHex: "#000000",
          align: "start",
          backgroundHex: null,
        },
      },
    } as unknown as FigureObject);
    expect(bounds.left).toBeCloseTo(5);
    expect(bounds.right).toBeCloseTo(15);
    expect(bounds.top).toBeCloseTo(-5);
    expect(bounds.bottom).toBeCloseTo(15);
  });

  it("snaps the closest edge or center on each axis within the threshold", () => {
    const moving = { left: 103, top: 47, right: 153, bottom: 97 };
    const result = snapMove(
      moving,
      [{ left: 0, top: 0, right: 100, bottom: 50 }],
      artboardBounds({ widthPt: 612, heightPt: 792 }),
      4,
    );
    expect(result.dxPt).toBe(-3);
    expect(result.dyPt).toBe(3);
    expect(result.guides).toEqual([
      { axis: "x", positionPt: 100, fromPt: 0, toPt: 100 },
      { axis: "y", positionPt: 50, fromPt: 0, toPt: 150 },
    ]);
    expect(snapMove(moving, [], { left: 0, top: 0, right: 600, bottom: 600 }, 2)).toEqual({
      dxPt: 0,
      dyPt: 0,
      guides: [],
    });
  });
});

describe("arrange commands", () => {
  it("aligns units to the selection or a reference, moving groups and labels together", () => {
    let document = documentWith(view("a", 10, 50), view("b", 50, 200), view("c", 90, 400));
    document = groupObjectsCommand("g", ["b", "c"])(document);
    document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a"], newId: ids() })(
      document,
    );
    const label = document.objects.find((object) => object.type === "text");
    expect(label?.transform.xPt).toBe(10);

    const left = alignObjectsCommand(["a", "b"], "left")(document);
    expect(positions(left)).toMatchObject({ a: [10, 50], b: [10, 200], c: [50, 400] });

    const right = alignObjectsCommand(
      ["a"],
      "right",
      artboardBounds({ widthPt: 612, heightPt: 792 }),
    )(document);
    expect(positions(right).a).toEqual([512, 50]);
    expect(right.objects.find((object) => object.type === "text")?.transform.xPt).toBe(512);
  });

  it("ignores locked objects and does nothing for a single unit without a reference", () => {
    const document = setObjectFlagsCommand(["b"], { locked: true })(
      documentWith(view("a", 10, 10), view("b", 50, 50)),
    );
    expect(alignObjectsCommand(["a", "b"], "top")(document)).toEqual(document);
    expect(
      moveObjectsCommand(["a", "b"], 5, 5)(document).objects.map((o) => o.transform.xPt),
    ).toEqual([15, 50]);
  });

  it("distributes equal gaps between units, keeping the outer ones fixed", () => {
    const document = documentWith(view("a", 0, 0, 10), view("b", 15, 0, 20), view("c", 90, 0, 10));
    const spaced = distributeObjectsCommand(["c", "a", "b"], "horizontal")(document);
    expect(positions(spaced)).toEqual({ a: [0, 0], b: [40, 0], c: [90, 0] });
    expect(distributeObjectsCommand(["a", "b"], "horizontal")(document)).toEqual(document);
  });

  it("reorders the stack and renumbers z-indexes compactly", () => {
    const document = documentWith(
      view("a", 0, 0, 10, 0),
      view("b", 0, 0, 10, 5),
      view("c", 0, 0, 10, 9),
    );
    const z = (value: FigureDocument) =>
      Object.fromEntries(value.objects.map((object) => [object.id, object.zIndex]));
    expect(z(reorderObjectsCommand(["a"], "front")(document))).toEqual({ a: 2, b: 0, c: 1 });
    expect(z(reorderObjectsCommand(["c"], "back")(document))).toEqual({ a: 1, b: 2, c: 0 });
    expect(z(reorderObjectsCommand(["a"], "forward")(document))).toEqual({ a: 1, b: 0, c: 2 });
    expect(z(reorderObjectsCommand(["c", "b"], "backward")(document))).toEqual({
      a: 2,
      b: 0,
      c: 1,
    });
  });

  it("groups, absorbs touched groups, and ungroups", () => {
    let document = documentWith(view("a", 0, 0), view("b", 0, 0), view("c", 0, 0));
    document = groupObjectsCommand("g1", ["a", "b"])(document);
    document = groupObjectsCommand("g2", ["b", "c"])(document);
    expect(document.groups).toEqual([{ id: "g2", objectIds: ["a", "b", "c"] }]);
    expect(arrangementUnits(document, ["a"])).toHaveLength(1);
    expect(ungroupObjectsCommand(["c"])(document).groups).toEqual([]);
  });

  it("deletes labels with their target and dissolves undersized groups", () => {
    let document = groupObjectsCommand("g", ["a", "b"])(
      documentWith(view("a", 0, 50), view("b", 0, 50)),
    );
    document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a"], newId: ids() })(
      document,
    );
    const deleted = deleteObjectsCommand(["a"])(document);
    expect(deleted.objects.map((object) => object.id)).toEqual(["b"]);
    expect(deleted.groups).toEqual([]);
  });

  it("duplicates with fresh IDs above the stack, remapping groups and labels", () => {
    let document = groupObjectsCommand("g", ["a", "b"])(
      documentWith(view("a", 0, 50, 10, 0), view("b", 20, 50, 10, 1), view("c", 40, 50, 10, 2)),
    );
    document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a"], newId: ids() })(
      document,
    );
    const { document: copied, idMap } = duplicateObjects(document, ["a"], ids("copy"));
    expect([...idMap.keys()].sort()).toEqual(["a", "b", "new-1"]);
    const copies = copied.objects.filter((object) => object.id.startsWith("copy-"));
    expect(copies.map((object) => object.zIndex)).toEqual([4, 5, 6]);
    const before = positions(document);
    for (const [from, to] of idMap) {
      const [x = 0, y = 0] = before[from] ?? [];
      expect(positions(copied)[to]).toEqual([x + 10, y + 10]);
    }
    const copiedLabel = copies.find((object) => object.type === "text");
    expect(copiedLabel?.type === "text" && copiedLabel.panelLabel?.targetObjectId).toBe(
      idMap.get("a"),
    );
    expect(copied.groups).toHaveLength(2);
    const firstCopy = copies.find((object) => object.type === "image-view");
    expect(firstCopy?.type === "image-view" && firstCopy.view.sourceAssetId).toBe("asset");
  });

  it("rejects updates that change an object's identity", () => {
    const document = documentWith(view("a", 0, 0));
    expect(() =>
      updateObjectCommand("a", (object) => ({ ...object, id: "z" }))(document),
    ).toThrowError(/cannot change/);
  });
});

describe("panel labels", () => {
  it("letters in sequence including double letters", () => {
    expect([0, 25, 26, 27].map((index) => panelLabelText(index, "upper"))).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
    ]);
    expect(panelLabelText(1, "lower")).toBe("b");
    expect(panelLabelText(1, "number")).toBe("2");
  });

  it("orders panels in rows, top to bottom and left to right", () => {
    const objects = [
      view("bottom-left", 0, 210, 100),
      view("top-right", 220, 5, 100),
      view("top-left", 0, 0, 100),
      view("bottom-right", 150, 200, 100),
    ];
    expect(readingOrder(objects)).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
  });

  it("re-letters auto labels after panels move and keeps manual text", () => {
    let document = documentWith(view("a", 0, 100), view("b", 200, 100));
    document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a", "b"], newId: ids() })(
      document,
    );
    const labelOf = (value: FigureDocument, target: string) =>
      value.objects.find(
        (object) => object.type === "text" && object.panelLabel?.targetObjectId === target,
      );
    const contentOf = (value: FigureDocument, target: string) => {
      const label = labelOf(value, target);
      return label?.type === "text" ? label.text.content : undefined;
    };
    expect([contentOf(document, "a"), contentOf(document, "b")]).toEqual(["A", "B"]);

    const swapped = relabelPanelsCommand(
      "board",
      "lower",
    )(moveObjectsCommand(["a"], 400, 0)(document));
    expect([contentOf(swapped, "a"), contentOf(swapped, "b")]).toEqual(["b", "a"]);

    const manualId = labelOf(document, "a")?.id as string;
    const manual = updateObjectCommand(manualId, (object) =>
      object.type === "text"
        ? {
            ...object,
            text: { ...object.text, content: "A'" },
            panelLabel: { targetObjectId: "a", auto: false },
          }
        : object,
    )(document);
    expect(contentOf(relabelPanelsCommand("board", "upper")(manual), "a")).toBe("A'");
  });

  it("places labels inside the corner when there is no room above", () => {
    const document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a"], newId: ids() })(
      documentWith(view("a", 20, 0)),
    );
    const label = document.objects.find((object) => object.type === "text");
    expect(label?.transform.yPt).toBeGreaterThan(0);
    expect(label?.transform.xPt).toBeGreaterThan(20);
  });
});

describe("artboard commands", () => {
  const second = {
    id: "board-2",
    name: "Figure 2",
    widthPt: 300,
    heightPt: 200,
    backgroundHex: "#FFFFFF",
  };

  it("adds, updates, moves, and removes artboards, keeping at least one", () => {
    let document = addArtboardCommand(second)(documentWith(view("a", 0, 0)));
    document = updateArtboardCommand("board-2", { name: "Blots", widthPt: 252 })(document);
    expect(document.artboards.map((board) => [board.name, board.widthPt])).toEqual([
      ["Figure 1", 612],
      ["Blots", 252],
    ]);
    document = moveArtboardCommand("board-2", 0)(document);
    expect(document.artboards.map((board) => board.id)).toEqual(["board-2", "board"]);
    document = removeArtboardCommand("board")(document);
    expect(document.artboards.map((board) => board.id)).toEqual(["board-2"]);
    expect(document.objects).toEqual([]);
    expect(removeArtboardCommand("board-2")(document)).toEqual(document);
  });

  it("duplicates an artboard with its objects, groups, labels, and locks", () => {
    let document = groupObjectsCommand("g", ["a", "b"])(
      documentWith(view("a", 0, 50, 10, 0), view("b", 20, 50, 10, 1)),
    );
    document = addPanelLabelsCommand({ artboardId: "board", targetIds: ["a"], newId: ids() })(
      document,
    );
    document = setObjectFlagsCommand(["b"], { locked: true })(document);
    const copied = duplicateArtboardCommand(
      "board",
      { id: "copy", name: "Figure 1 copy" },
      ids("copy"),
    )(document);
    const onCopy = copied.objects.filter((object) => object.artboardId === "copy");
    expect(copied.artboards.map((board) => board.id)).toEqual(["board", "copy"]);
    expect(onCopy).toHaveLength(3);
    expect(onCopy.map((object) => object.zIndex).sort()).toEqual([0, 1, 2]);
    expect(onCopy.filter((object) => object.locked)).toHaveLength(1);
    expect(copied.groups).toHaveLength(2);
    expect(positions(copied)).toMatchObject(positions(document));
  });
});

describe("attached annotations", () => {
  const calibrated = (document: FigureDocument): FigureDocument => ({
    ...document,
    sources: [
      {
        assetId: "asset",
        widthPx: 100,
        heightPx: 100,
        calibration: { umPerPxX: 1, umPerPxY: 1, origin: "manual" },
        markers: [],
      },
    ],
  });
  const bar = (target: string): FigureObject => ({
    id: `bar-${target}`,
    type: "scale-bar",
    artboardId: "board",
    transform: { xPt: 10, yPt: 90, widthPt: 20, heightPt: 2, rotationDeg: 0 },
    zIndex: 5,
    locked: false,
    hidden: false,
    scaleBar: {
      targetObjectId: target,
      lengthUm: 10,
      displayUnit: "µm",
      thicknessPt: 2,
      colorHex: "#FFFFFF",
      showLabel: false,
      fontSizePt: 6,
    },
  });
  const zoom: FigureObject = {
    id: "zoom",
    type: "zoom-link",
    artboardId: "board",
    transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
    zIndex: 6,
    locked: false,
    hidden: false,
    zoomLink: {
      sourceObjectId: "a",
      insetObjectId: "b",
      stroke: { colorHex: "#FFFFFF", widthPt: 1, dashed: false },
      connectors: false,
    },
  };

  it("deletes scale bars and zoom links with their panels", () => {
    const document = calibrated(documentWith(view("a", 0, 0), view("b", 200, 0), bar("a"), zoom));
    expect(deleteObjectsCommand(["b"])(document).objects.map((object) => object.id)).toEqual([
      "a",
      "bar-a",
    ]);
    expect(deleteObjectsCommand(["a"])(document).objects.map((object) => object.id)).toEqual(["b"]);
  });

  it("moves attached annotations with their panel", () => {
    const document = calibrated(documentWith(view("a", 0, 0), bar("a")));
    expect(positions(moveObjectsCommand(["a"], 5, 7)(document))["bar-a"]).toEqual([15, 97]);
  });

  it("remaps copies onto copied panels and drops orphaned annotations", () => {
    const document = calibrated(documentWith(view("a", 0, 0), view("b", 200, 0), bar("a"), zoom));
    const both = duplicateObjects(document, ["a", "b"], ids("copy"));
    const copiedBar = both.document.objects.find(
      (object) => object.type === "scale-bar" && object.id !== "bar-a",
    );
    expect(copiedBar?.type === "scale-bar" && copiedBar.scaleBar.targetObjectId).toBe(
      both.idMap.get("a"),
    );
    expect(both.document.objects.filter((object) => object.type === "zoom-link")).toHaveLength(2);
    const barOnly = duplicateObjects(document, ["bar-a"], ids("solo"));
    expect(barOnly.document.objects).toHaveLength(document.objects.length);
  });
});
