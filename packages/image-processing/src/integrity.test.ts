import {
  createDefaultFigureDocument,
  type DisplayTransformV3,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
} from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  buildIntegrityReport,
  buildUncroppedSheet,
  cropsCsv,
  integrityReportHtml,
  type RasterSourceResolver,
} from "./index.js";

/** A 10 × 10 grayscale ramp whose last row is saturated. */
const resolver: RasterSourceResolver = {
  async describe() {
    return { widthPx: 10, heightPx: 10, bitDepth: 8, channels: 1 };
  },
  async getRegion(_assetId, rect) {
    const data = new Uint8Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y += 1)
      for (let x = 0; x < rect.width; x += 1)
        data[y * rect.width + x] = rect.y + y === 9 ? 255 : (rect.x + x) * 20;
    return {
      data,
      sourceRect: rect,
      widthPx: rect.width,
      heightPx: rect.height,
      bitDepth: 8,
      channels: 1,
      pyramidLevel: 0,
    };
  },
};
const sizes = async () => ({ widthPx: 10, heightPx: 10 });
const base = { artboardId: "board", locked: false, hidden: false };

function panel(
  id: string,
  viewport = { x: 0, y: 0, width: 1, height: 1 },
  display: Partial<DisplayTransformV3> = {},
  extra = {},
): FigureObject {
  return {
    ...base,
    id,
    type: "image-view",
    zIndex: 0,
    transform: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
    view: {
      sourceAssetId: "blot",
      plane: 0,
      channel: null,
      viewport,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      display: { ...IDENTITY_DISPLAY_V3, ...display },
      ...extra,
    },
  };
}

function label(target: string, content: string): FigureObject {
  return {
    ...base,
    id: `label-${target}`,
    type: "text",
    zIndex: 1,
    transform: { xPt: 0, yPt: 0, widthPt: 10, heightPt: 10, rotationDeg: 0 },
    text: {
      content,
      style: {
        fontSizePt: 10,
        bold: true,
        italic: false,
        underline: false,
        colorHex: "#000000",
        align: "start",
        backgroundHex: null,
      },
    },
    panelLabel: { targetObjectId: target, auto: true },
  };
}

const documentWith = (
  objects: FigureObject[],
  sources: FigureDocument["sources"] = [],
): FigureDocument => ({
  ...createDefaultFigureDocument("board"),
  sources,
  objects,
});

describe("integrity report", () => {
  it("records crops, classifies adjustments, and measures clipping and saturation", async () => {
    const document = documentWith([
      panel("a", undefined, { gamma: 1.5 }),
      panel("b", { x: 0, y: 0, width: 0.5, height: 0.5 }, { contrast: 3 }),
      label("a", "A"),
      label("b", "B"),
    ]);
    const report = await buildIntegrityReport({
      document,
      revision: 7,
      projectName: "Blots",
      resolver,
      sizes,
      assets: new Map([["blot", { filename: "blot.tif", checksumSha256: "c".repeat(64) }]]),
      now: new Date("2026-10-06T00:00:00Z"),
    });
    const [a, b] = report.panels;
    expect(a?.label).toBe("A");
    expect(a?.readings[0]).toMatchObject({
      filename: "blot.tif",
      cropPx: { x: 0, y: 0, width: 10, height: 10 },
      resampling: "nearest",
    });
    expect(a?.readings[0]?.stats.sourceSaturated).toBeCloseTo(0.1);
    expect(a?.findings.map((finding) => finding.code)).toEqual(["gamma", "source-saturation"]);
    expect(b?.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ["brightness-contrast", "disclose"],
      ["display-clipping", "warn"],
    ]);
    expect(report.findings.map((finding) => finding.code)).toEqual(["overlapping-crops"]);
    expect(report.legendText).toContain("non-linear gamma adjustment was applied to panel A");
    expect(report.legendText).toContain("whole of panel B");
    expect(cropsCsv(report).split("\n")[1]).toMatch(/^Figure 1,A,a,blot\.tif,c{64},0,,0,0,10,10,/);
    expect(integrityReportHtml(report)).toContain("Panel A");
  });

  it("explains zoom insets, flags duplicate originals, and discloses manual calibration", async () => {
    const source = {
      assetId: "blot",
      widthPx: 10,
      heightPx: 10,
      calibration: { umPerPxX: 0.3, umPerPxY: 0.3, origin: "manual" as const },
      markers: [],
    };
    const inset = panel("inset", { x: 0, y: 0, width: 0.5, height: 0.5 });
    const link: FigureObject = {
      ...base,
      id: "zoom",
      type: "zoom-link",
      zIndex: 2,
      transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      zoomLink: {
        sourceObjectId: "a",
        insetObjectId: "inset",
        stroke: { colorHex: "#FFFFFF", widthPt: 1, dashed: false },
        connectors: false,
      },
    };
    const bar: FigureObject = {
      ...base,
      id: "bar",
      type: "scale-bar",
      zIndex: 3,
      transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      scaleBar: {
        targetObjectId: "a",
        lengthUm: 1,
        displayUnit: "µm",
        thicknessPt: 1,
        colorHex: "#FFFFFF",
        showLabel: false,
        fontSizePt: 6,
      },
    };
    const copy = panel("copy", undefined, {}, { sourceAssetId: "blot-again" });
    const document = decodeFigureDocument(
      documentWith(
        [panel("a"), inset, link, bar, copy],
        [source, { ...source, assetId: "blot-again", calibration: null }],
      ),
    );
    const report = await buildIntegrityReport({
      document,
      revision: 1,
      projectName: "Blots",
      resolver,
      sizes,
      assets: new Map([
        ["blot", { filename: "blot.tif", checksumSha256: "d".repeat(64) }],
        ["blot-again", { filename: "blot (1).tif", checksumSha256: "d".repeat(64) }],
      ]),
    });
    expect(report.findings.map((finding) => finding.code).sort()).toEqual([
      "duplicate-originals",
      "manual-calibration",
    ]);
  });

  it("discloses rotation and flips", async () => {
    const report = await buildIntegrityReport({
      document: documentWith(
        [
          panel(
            "r",
            { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
            {},
            { rotationDeg: 10, flipX: true },
          ),
        ],
        [{ assetId: "blot", widthPx: 10, heightPx: 10, calibration: null, markers: [] }],
      ),
      revision: 1,
      projectName: "Blots",
      resolver,
      sizes,
    });
    expect(report.panels[0]?.readings[0]?.resampling).toBe("bilinear");
    expect(report.panels[0]?.findings.map((finding) => finding.code)).toContain("rotation");
    expect(report.panels[0]?.findings.map((finding) => finding.code)).toContain("flip");
    expect(report.legendText).toContain("rotated to straighten lanes");
  });
});

describe("screener checks", () => {
  const lanes = (target: string): FigureObject => ({
    ...base,
    id: `lanes-${target}`,
    type: "lane-table",
    zIndex: 3,
    transform: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 10, rotationDeg: 0 },
    laneTable: {
      targetObjectId: target,
      lanes: 2,
      laneCenters: null,
      placement: "above",
      rows: [{ cells: [{ text: "A", span: 2, underline: false }] }],
      fontSizePt: 7,
      colorHex: "#000000",
      gapPt: 2,
    },
  });
  const report = (objects: FigureObject[], markers: { yPx: number; kDa: number }[] = []) =>
    buildIntegrityReport({
      document: decodeFigureDocument(
        documentWith(objects, [
          { assetId: "blot", widthPx: 10, heightPx: 10, calibration: null, markers },
        ]),
      ),
      revision: 1,
      projectName: "Blots",
      resolver,
      sizes,
    });
  const withInfo = (object: FigureObject, sampleInfo: Record<string, unknown>) =>
    ({ ...object, sampleInfo }) as FigureObject;

  it("asks for a loading control when blot panels have none", async () => {
    const target = withInfo(panel("p"), { target: "p-ERK" });
    expect((await report([target, lanes("p")])).findings.map((finding) => finding.code)).toEqual([
      "missing-loading-control",
    ]);
    const actin = withInfo(panel("c"), { target: "β-actin" });
    const codes = async (objects: FigureObject[]) =>
      (await report(objects)).findings.map((finding) => finding.code);
    expect(await codes([target, lanes("p"), actin, lanes("c")])).not.toContain(
      "missing-loading-control",
    );
    const marked = withInfo(panel("c"), { target: "Ponceau S", loadingControl: true });
    expect(await codes([target, lanes("p"), marked])).not.toContain("missing-loading-control");
    // Panels without lane or MW labels are not blots.
    expect((await report([panel("micro")])).findings).toEqual([]);
  });

  it("checks the expected band size against the crop's ladder range", async () => {
    const ladder = [
      { yPx: 2, kDa: 100 },
      { yPx: 8, kDa: 10 },
    ];
    // Rows 4–6 span about 21–46 kDa on this ladder.
    const crop = { x: 0, y: 0.4, width: 1, height: 0.2 };
    const codes = async (expectedKDa: number, marks = ladder) =>
      (await report([withInfo(panel("p", crop), { expectedKDa })], marks)).panels[0]?.findings.map(
        (finding) => finding.code,
      );
    expect(await codes(70)).toContain("unexpected-mw");
    expect(await codes(30)).not.toContain("unexpected-mw");
    expect(await codes(30, [])).toContain("unchecked-mw");
  });
});

describe("uncropped originals sheet", () => {
  it("outlines every crop on its original with valid, renderable objects", async () => {
    const sources = [
      {
        assetId: "blot",
        widthPx: 10,
        heightPx: 10,
        calibration: null,
        markers: [{ yPx: 5, kDa: 55 }],
      },
    ];
    const document = documentWith(
      [
        panel("a", { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, {}, { rotationDeg: 15 }),
        label("a", "A"),
      ],
      sources,
    );
    const sheet = decodeFigureDocument(
      await buildUncroppedSheet(document, sizes, new Map([["blot", { filename: "blot.tif" }]])),
    );
    expect(sheet.artboards.map((board) => board.name)).toEqual(["blot.tif"]);
    expect(sheet.objects.filter((object) => object.type === "line")).toHaveLength(5);
    expect(
      sheet.objects
        .filter((object) => object.type === "text")
        .map((object) => object.type === "text" && object.text.content),
    ).toEqual(["Uncropped original: blot.tif", "A", "55"]);
    const original = sheet.objects.find((object) => object.type === "image-view");
    expect(original?.type === "image-view" && original.view.viewport).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});
