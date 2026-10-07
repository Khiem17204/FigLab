import {
  createDefaultFigureDocument,
  type FigureDocument,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
} from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  addLaneTableCommand,
  addMwLabelsCommand,
  addScaleBarCommand,
  addZoomInsetCommand,
  copyMarkersCommand,
  formatLaneRow,
  mergeViewsCommand,
  parseLaneRow,
  splitChannelsCommand,
  suggestedLut,
} from "./index.js";

function view(id: string, assetId = "a", xPt = 10): ImageViewObjectV3 {
  return {
    id,
    type: "image-view",
    artboardId: "board",
    transform: { xPt, yPt: 100, widthPt: 100, heightPt: 50, rotationDeg: 0 },
    zIndex: 0,
    locked: false,
    hidden: false,
    view: {
      sourceAssetId: assetId,
      plane: 0,
      channel: null,
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      display: { ...IDENTITY_DISPLAY_V3 },
    },
  };
}

const source = (assetId: string, extra = {}) => ({
  assetId,
  widthPx: 200,
  heightPx: 100,
  calibration: { umPerPxX: 0.5, umPerPxY: 0.5, origin: "metadata" as const },
  markers: [{ yPx: 40, kDa: 70 }],
  ...extra,
});

const documentWith = (...views: ImageViewObjectV3[]): FigureDocument => ({
  ...createDefaultFigureDocument("board"),
  sources: [source("a"), source("b"), source("c", { heightPx: 80, markers: [] })],
  objects: views,
});

describe("blot and microscopy commands", () => {
  it("adds scale bars, MW labels, and lane tables attached to a panel", () => {
    let document = documentWith(view("p"));
    document = addScaleBarCommand({ id: "bar", targetId: "p", lengthUm: 20 })(document);
    document = addMwLabelsCommand({ id: "mw", targetId: "p" })(document);
    document = addLaneTableCommand({ id: "lanes", targetId: "p", lanes: 4 })(document);
    expect(document.objects.map((object) => object.type)).toEqual([
      "image-view",
      "scale-bar",
      "mw-labels",
      "lane-table",
    ]);
    const lanes = document.objects.find((object) => object.type === "lane-table");
    expect(
      lanes?.type === "lane-table" && lanes.laneTable.rows.map((row) => formatLaneRow(row.cells)),
    ).toEqual(["_Condition*4", "− | + | − | +"]);
  });

  it("parses and formats lane rows", () => {
    expect(parseLaneRow(" _HeLa*2 | HEK*2 ")).toEqual([
      { text: "HeLa", span: 2, underline: true },
      { text: "HEK", span: 2, underline: false },
    ]);
    expect(formatLaneRow(parseLaneRow("_DMSO*3 | 10 µM"))).toBe("_DMSO*3 | 10 µM");
  });

  it("makes a linked zoom inset of the central region", () => {
    const document = addZoomInsetCommand({ insetId: "inset", linkId: "link", sourceId: "p" })(
      documentWith(view("p")),
    );
    const inset = document.objects.find((object) => object.id === "inset");
    expect(inset?.type === "image-view" && inset.view.viewport).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
    expect(inset?.transform.xPt).toBe(118);
    expect(document.objects.at(-1)).toMatchObject({
      type: "zoom-link",
      zoomLink: { sourceObjectId: "p", insetObjectId: "inset" },
    });
  });

  it("splits channels into a row with LUTs and an additive merge", () => {
    const document = splitChannelsCommand({
      sourceId: "p",
      channels: [0, 1, 2].map((channel) => ({
        plane: 0,
        channel,
        lut: suggestedLut(undefined, channel),
        id: `ch${channel}`,
      })),
      mergeId: "merge",
    })(documentWith(view("p")));
    expect(document.objects.map((object) => [object.id, object.transform.xPt])).toEqual([
      ["p", 10],
      ["ch0", 116],
      ["ch1", 222],
      ["ch2", 328],
      ["merge", 434],
    ]);
    const merge = document.objects.at(-1);
    expect(
      merge?.type === "composite" &&
        merge.composite.channels.map((channel) => [channel.channel, channel.display.lut]),
    ).toEqual([
      [0, "red"],
      [1, "green"],
      [2, "blue"],
    ]);
    expect(suggestedLut("C2 DAPI", 1)).toBe("blue");
  });

  it("merges same-sized views and refuses different sizes", () => {
    const merged = mergeViewsCommand({ id: "m", viewIds: ["x", "y"] })(
      documentWith(view("x", "a"), view("y", "b", 200)),
    );
    expect(merged.objects.at(-1)).toMatchObject({ type: "composite", transform: { xPt: 306 } });
    expect(() =>
      mergeViewsCommand({ id: "m", viewIds: ["x", "z"] })(
        documentWith(view("x", "a"), view("z", "c")),
      ),
    ).toThrowError(/different sizes/);
  });

  it("copies ladder markers between exposures of the same height", () => {
    const document = copyMarkersCommand(
      "a",
      "b",
    )({
      ...documentWith(),
      sources: [source("a"), source("b", { markers: [] })],
    });
    expect(document.sources[1]?.markers).toEqual([{ yPx: 40, kDa: 70 }]);
    expect(() => copyMarkersCommand("a", "c")(documentWith())).toThrowError(/same height/);
  });
});
