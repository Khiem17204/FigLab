import {
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
  type LaneCellV3,
  type LutV3,
} from "@figlab/figure-schema";

type Command = (document: FigureDocument) => FigureDocument;

const panelById = (document: FigureDocument, id: string) => {
  const panel = document.objects.find((object) => object.id === id);
  if (!panel || (panel.type !== "image-view" && panel.type !== "composite"))
    throw new Error(`Object ${id} is not an image panel`);
  return panel;
};

const topZ = (document: FigureDocument, artboardId: string) =>
  Math.max(
    -1,
    ...document.objects
      .filter((object) => object.artboardId === artboardId)
      .map((object) => object.zIndex),
  );

const placeholderBox = { widthPt: 1, heightPt: 1, rotationDeg: 0 as const };

/** A white scale bar in the panel's lower-right corner; its width follows the calibration. */
export function addScaleBarCommand(input: {
  id: string;
  targetId: string;
  lengthUm: number;
  displayUnit?: "nm" | "µm" | "mm";
}): Command {
  return (document) => {
    const panel = panelById(document, input.targetId);
    const { xPt, yPt, widthPt, heightPt } = panel.transform;
    return decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        {
          id: input.id,
          type: "scale-bar",
          artboardId: panel.artboardId,
          zIndex: topZ(document, panel.artboardId) + 1,
          locked: false,
          hidden: false,
          transform: { xPt: xPt + widthPt * 0.62, yPt: yPt + heightPt - 14, ...placeholderBox },
          scaleBar: {
            targetObjectId: input.targetId,
            lengthUm: input.lengthUm,
            displayUnit: input.displayUnit ?? "µm",
            thicknessPt: 2,
            colorHex: "#FFFFFF",
            showLabel: true,
            fontSizePt: 7,
          },
        },
      ],
    });
  };
}

/** Molecular-weight ticks on the left of a blot panel. */
export function addMwLabelsCommand(input: { id: string; targetId: string }): Command {
  return (document) => {
    const panel = panelById(document, input.targetId);
    return decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        {
          id: input.id,
          type: "mw-labels",
          artboardId: panel.artboardId,
          zIndex: topZ(document, panel.artboardId) + 1,
          locked: false,
          hidden: false,
          transform: { xPt: panel.transform.xPt, yPt: panel.transform.yPt, ...placeholderBox },
          mwLabels: {
            targetObjectId: input.targetId,
            side: "left",
            fontSizePt: 7,
            tickLengthPt: 3,
            colorHex: "#000000",
            showUnit: true,
          },
        },
      ],
    });
  };
}

/** Parses one row of lane cells: `|`-separated, `*n` spans n lanes, a leading `_` underlines. */
export function parseLaneRow(text: string): LaneCellV3[] {
  return text.split("|").map((raw) => {
    let value = raw.trim();
    const underline = value.startsWith("_");
    if (underline) value = value.slice(1).trim();
    const span = /\*(\d+)$/.exec(value);
    if (span) value = value.slice(0, span.index).trim();
    return { text: value, span: Math.max(1, Number(span?.[1] ?? 1)), underline };
  });
}

export function formatLaneRow(cells: ReadonlyArray<LaneCellV3>): string {
  return cells
    .map(
      (cell) => `${cell.underline ? "_" : ""}${cell.text}${cell.span > 1 ? `*${cell.span}` : ""}`,
    )
    .join(" | ");
}

/** Condition labels above a blot panel: a spanning group row over per-lane +/− labels. */
export function addLaneTableCommand(input: {
  id: string;
  targetId: string;
  lanes: number;
}): Command {
  return (document) => {
    const panel = panelById(document, input.targetId);
    const lanes = Math.max(1, Math.min(48, Math.round(input.lanes)));
    return decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        {
          id: input.id,
          type: "lane-table",
          artboardId: panel.artboardId,
          zIndex: topZ(document, panel.artboardId) + 1,
          locked: false,
          hidden: false,
          transform: { xPt: panel.transform.xPt, yPt: panel.transform.yPt, ...placeholderBox },
          laneTable: {
            targetObjectId: input.targetId,
            lanes,
            laneCenters: null,
            placement: "above",
            rows: [
              { cells: [{ text: "Condition", span: lanes, underline: true }] },
              {
                cells: Array.from({ length: lanes }, (_, index) => ({
                  text: index % 2 === 0 ? "−" : "+",
                  span: 1,
                  underline: false,
                })),
              },
            ],
            fontSizePt: 7,
            colorHex: "#000000",
            gapPt: 3,
          },
        },
      ],
    });
  };
}

/**
 * Adds a magnified copy of the panel's central region to its right, linked by an outline on the
 * original panel. The copy is a new crop of the same original, so it is a provenance sibling.
 */
export function addZoomInsetCommand(input: {
  insetId: string;
  linkId: string;
  sourceId: string;
}): Command {
  return (document) => {
    const panel = panelById(document, input.sourceId);
    if (panel.type !== "image-view") throw new Error("Zoom insets start from an image view");
    const { viewport } = panel.view;
    const inset: ImageViewObjectV3 = {
      ...structuredClone(panel),
      id: input.insetId,
      zIndex: topZ(document, panel.artboardId) + 1,
      locked: false,
      transform: { ...panel.transform, xPt: panel.transform.xPt + panel.transform.widthPt + 8 },
      view: {
        ...structuredClone(panel.view),
        viewport: {
          x: viewport.x + viewport.width / 4,
          y: viewport.y + viewport.height / 4,
          width: viewport.width / 2,
          height: viewport.height / 2,
        },
      },
    };
    return decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        inset,
        {
          id: input.linkId,
          type: "zoom-link",
          artboardId: panel.artboardId,
          zIndex: inset.zIndex + 1,
          locked: false,
          hidden: false,
          transform: { xPt: panel.transform.xPt, yPt: panel.transform.yPt, ...placeholderBox },
          zoomLink: {
            sourceObjectId: panel.id,
            insetObjectId: input.insetId,
            stroke: { colorHex: "#FFFFFF", widthPt: 1, dashed: false },
            connectors: true,
          },
        },
      ],
    });
  };
}

export const CHANNEL_LUTS: readonly Exclude<LutV3, "none" | "gray">[] = [
  "red",
  "green",
  "blue",
  "magenta",
  "cyan",
  "yellow",
];

/** A LUT suggested by a channel's name (DAPI blue, GFP green, …), else by position. */
export function suggestedLut(label: string | undefined, index: number): Exclude<LutV3, "none"> {
  const name = (label ?? "").toLowerCase();
  if (/dapi|hoechst|bfp|405/.test(name)) return "blue";
  if (/gfp|fitc|alexa ?488|488|cy2/.test(name)) return "green";
  if (/rfp|mcherry|tritc|texas|cy3|568|594|555/.test(name)) return "red";
  if (/cy5|647|far.?red/.test(name)) return "magenta";
  return CHANNEL_LUTS[index % CHANNEL_LUTS.length] ?? "gray";
}

/**
 * Splits a panel into one panel per channel (planes of a multi-page original, or samples of an
 * RGB one), laid out in a row to its right, each in its own LUT, plus an additive merge.
 */
export function splitChannelsCommand(input: {
  sourceId: string;
  channels: { plane: number; channel: number | null; lut: Exclude<LutV3, "none">; id: string }[];
  mergeId?: string;
  gapPt?: number;
}): Command {
  return (document) => {
    const panel = panelById(document, input.sourceId);
    if (panel.type !== "image-view") throw new Error("Split channels from an image view");
    const gap = input.gapPt ?? 6;
    const { widthPt } = panel.transform;
    let z = topZ(document, panel.artboardId);
    const created: FigureObject[] = input.channels.map((channel, index) => {
      z += 1;
      return {
        ...structuredClone(panel),
        id: channel.id,
        zIndex: z,
        locked: false,
        transform: { ...panel.transform, xPt: panel.transform.xPt + (widthPt + gap) * (index + 1) },
        view: {
          ...structuredClone(panel.view),
          plane: channel.plane,
          channel: channel.channel,
          display: { ...IDENTITY_DISPLAY_V3, lut: channel.lut },
        },
      };
    });
    if (input.mergeId) {
      z += 1;
      created.push({
        id: input.mergeId,
        type: "composite",
        artboardId: panel.artboardId,
        zIndex: z,
        locked: false,
        hidden: false,
        transform: {
          ...panel.transform,
          xPt: panel.transform.xPt + (widthPt + gap) * (input.channels.length + 1),
        },
        composite: {
          viewport: panel.view.viewport,
          rotationDeg: panel.view.rotationDeg,
          flipX: panel.view.flipX,
          flipY: panel.view.flipY,
          channels: input.channels.map((channel) => ({
            sourceAssetId: panel.view.sourceAssetId,
            plane: channel.plane,
            channel: channel.channel,
            display: { ...IDENTITY_DISPLAY_V3, lut: channel.lut },
            visible: true,
          })),
        },
      });
    }
    return decodeFigureDocument({ ...document, objects: [...document.objects, ...created] });
  };
}

/**
 * Merges image views of same-sized originals into one composite placed after the last of them.
 * Each view contributes its plane, channel, and display (gray views become green, then red …).
 */
export function mergeViewsCommand(input: { id: string; viewIds: ReadonlyArray<string> }): Command {
  return (document) => {
    const views = input.viewIds
      .map((id) => document.objects.find((object) => object.id === id))
      .filter((object): object is ImageViewObjectV3 => object?.type === "image-view");
    const [first] = views;
    if (!first || views.length < 2) throw new Error("Select two or more image views to merge");
    const last = views.reduce(
      (right, view) => (view.transform.xPt > right.transform.xPt ? view : right),
      first,
    );
    return decodeFigureDocument({
      ...document,
      objects: [
        ...document.objects,
        {
          id: input.id,
          type: "composite",
          artboardId: first.artboardId,
          zIndex: topZ(document, first.artboardId) + 1,
          locked: false,
          hidden: false,
          transform: {
            ...first.transform,
            xPt: last.transform.xPt + last.transform.widthPt + 6,
            yPt: last.transform.yPt,
          },
          composite: {
            viewport: first.view.viewport,
            rotationDeg: first.view.rotationDeg,
            flipX: first.view.flipX,
            flipY: first.view.flipY,
            channels: views.map((view, index) => ({
              sourceAssetId: view.view.sourceAssetId,
              plane: view.view.plane,
              channel: view.view.channel,
              display: {
                ...view.view.display,
                lut:
                  view.view.display.lut === "none" || view.view.display.lut === "gray"
                    ? (CHANNEL_LUTS[index % CHANNEL_LUTS.length] ?? "gray")
                    : view.view.display.lut,
              },
              visible: true,
            })),
          },
        },
      ],
    });
  };
}

/** Copies one original's ladder markers to another of the same height (another exposure). */
export function copyMarkersCommand(fromAssetId: string, toAssetId: string): Command {
  return (document) => {
    const from = document.sources.find((source) => source.assetId === fromAssetId);
    const to = document.sources.find((source) => source.assetId === toAssetId);
    if (!from || !to) throw new Error("Both originals need source entries");
    if (from.heightPx !== to.heightPx)
      throw new Error("Markers can only be copied between originals of the same height");
    return decodeFigureDocument({
      ...document,
      sources: document.sources.map((source) =>
        source.assetId === toAssetId
          ? { ...source, markers: structuredClone(from.markers) }
          : source,
      ),
    });
  };
}
