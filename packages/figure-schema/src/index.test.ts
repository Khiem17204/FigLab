import { describe, expect, it } from "vitest";
import {
  ARTBOARD_SIZE_PRESETS,
  CURRENT_FIGURE_SCHEMA_VERSION,
  createDefaultFigureDocument,
  createDefaultFigureDocumentV1,
  createDefaultFigureDocumentV2,
  cropCornersPx,
  decodeFigureDocument,
  decodeFigureDocumentV1,
  decodeFigureDocumentV2,
  type FigureDocument,
  FigureDocumentDecodeError,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV1,
  type ImageViewObjectV3,
  migrateFigureDocument,
  mmToPt,
  presetSizePt,
  serializeFigureDocument,
} from "./index.js";

const v1View = (overrides: Partial<ImageViewObjectV1> = {}): ImageViewObjectV1 => ({
  id: "view-1",
  type: "image-view",
  artboardId: "artboard-1",
  transform: { xPt: 36, yPt: 36, widthPt: 540, heightPt: 120, rotationDeg: 0 },
  zIndex: 0,
  locked: false,
  hidden: false,
  view: {
    sourceAssetId: "asset-1",
    viewport: { x: 0.25, y: 0.5, width: 0.75, height: 0.5 },
    display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
  },
  ...overrides,
});

const view = (
  overrides: Partial<ImageViewObjectV3> = {},
  viewOverrides: Partial<ImageViewObjectV3["view"]> = {},
): ImageViewObjectV3 => ({
  ...v1View(),
  view: {
    sourceAssetId: "asset-1",
    plane: 0,
    channel: null,
    viewport: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    display: { ...IDENTITY_DISPLAY_V3 },
    ...viewOverrides,
  },
  ...overrides,
});

const text = (overrides: Partial<Extract<FigureObject, { type: "text" }>> = {}): FigureObject => ({
  id: "text-1",
  type: "text",
  artboardId: "artboard-1",
  transform: { xPt: 10, yPt: 10, widthPt: 40, heightPt: 12, rotationDeg: -45 },
  zIndex: 1,
  locked: false,
  hidden: false,
  text: {
    content: "HeLa\nHEK293 α",
    style: {
      fontSizePt: 8,
      bold: true,
      italic: false,
      underline: true,
      colorHex: "#000000",
      align: "middle",
      backgroundHex: null,
    },
  },
  ...overrides,
});

const source = (assetId = "asset-1", extra: Partial<FigureDocument["sources"][number]> = {}) => ({
  assetId,
  widthPx: 400,
  heightPx: 200,
  calibration: null,
  markers: [],
  ...extra,
});

const documentWith = (
  objects: FigureObject[],
  extra: Partial<FigureDocument> = {},
): FigureDocument => ({ ...createDefaultFigureDocument("artboard-1"), objects, ...extra });

const base = { artboardId: "artboard-1", zIndex: 5, locked: false, hidden: false };
const box = { xPt: 0, yPt: 0, widthPt: 10, heightPt: 10, rotationDeg: 0 as const };
const stroke = { colorHex: "#FFFFFF", widthPt: 1, dashed: false };

describe("frozen versions", () => {
  it("decodes v1 strictly and rejects out-of-bounds crops", () => {
    const document = createDefaultFigureDocumentV1("artboard-1");
    document.objects.push(v1View());
    expect(decodeFigureDocumentV1(document)).toEqual(document);
    document.objects[0] = v1View({
      view: { ...v1View().view, viewport: { x: 0.8, y: 0.2, width: 0.3, height: 0.5 } },
    });
    expect(() => decodeFigureDocumentV1(document)).toThrow(FigureDocumentDecodeError);
  });

  it("decodes v2 strictly, including its group rules", () => {
    const document = {
      ...createDefaultFigureDocumentV2("artboard-1"),
      objects: [v1View(), text()],
    };
    expect(decodeFigureDocumentV2(document)).toEqual(document);
    expect(() =>
      decodeFigureDocumentV2({ ...document, groups: [{ id: "g", objectIds: ["view-1"] }] }),
    ).toThrow(FigureDocumentDecodeError);
  });
});

describe("figure document migration", () => {
  it("opens v1 and v2 documents as v3 with identity display settings", () => {
    const v1 = createDefaultFigureDocumentV1("artboard-1");
    v1.objects.push(v1View());
    const migrated = migrateFigureDocument(v1);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.sources).toEqual([]);
    expect(migrated.groups).toEqual([]);
    expect(migrated.objects[0]).toEqual({
      ...v1View(),
      view: {
        sourceAssetId: "asset-1",
        plane: 0,
        channel: null,
        viewport: v1View().view.viewport,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        display: {
          levels: { black: 0, white: 1 },
          brightness: 0,
          contrast: 1,
          gamma: 1,
          invert: false,
          lut: "none",
        },
      },
    });
    const v2 = { ...createDefaultFigureDocumentV2("artboard-1"), objects: [v1View(), text()] };
    expect(migrateFigureDocument(v2).objects[1]).toEqual(text());
  });

  it("validates each stored version's rules before upgrading", () => {
    const v1 = createDefaultFigureDocumentV1("artboard-1");
    v1.objects.push(v1View({ artboardId: "missing" }));
    expect(() => migrateFigureDocument(v1)).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
  });

  it("passes current documents through unchanged", () => {
    const document = documentWith([view(), text()], { sources: [source()] });
    expect(migrateFigureDocument(document)).toEqual(document);
  });

  it("rejects future and malformed versions with typed codes", () => {
    expect(() => migrateFigureDocument({ schemaVersion: 4 })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }),
    );
    expect(() =>
      migrateFigureDocument({ ...createDefaultFigureDocument("artboard-1"), schemaVersion: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(() => migrateFigureDocument(null)).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
  });

  it("keeps decodeFigureDocument strict to the current version", () => {
    expect(CURRENT_FIGURE_SCHEMA_VERSION).toBe(3);
    expect(() => decodeFigureDocument(createDefaultFigureDocumentV2("artboard-1"))).toThrow(
      FigureDocumentDecodeError,
    );
  });
});

describe("figure document v3", () => {
  it("creates a US Letter document with empty collections", () => {
    expect(serializeFigureDocument(createDefaultFigureDocument("artboard-1"))).toBe(
      '{"schemaVersion":3,"artboards":[{"id":"artboard-1","name":"Figure 1","widthPt":612,"heightPt":792,"backgroundHex":"#FFFFFF"}],"sources":[],"objects":[],"groups":[],"constraints":[],"styles":[]}',
    );
  });

  it("checks rotated crops against the recorded source size", () => {
    // A 200 × 50 px crop centered at (200, 125) in a 400 × 200 px source fits at 30°.
    const rotated = view({}, { rotationDeg: 30 });
    expect(decodeFigureDocument(documentWith([rotated], { sources: [source()] }))).toBeDefined();
    expect(() => decodeFigureDocument(documentWith([rotated]))).toThrowError(/source entry/);
    const tooBig = view({}, { rotationDeg: 45, viewport: { x: 0, y: 0, width: 1, height: 0.5 } });
    expect(() =>
      decodeFigureDocument(documentWith([tooBig], { sources: [source()] })),
    ).toThrowError(/rotated crop outside/);
    const corners = cropCornersPx(
      { viewport: { x: 0, y: 0, width: 1, height: 1 }, rotationDeg: 90 },
      { widthPx: 4, heightPx: 2 },
    );
    expect(corners.map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([
      [3, -1],
      [3, 3],
      [1, 3],
      [1, -1],
    ]);
  });

  it("merges composites only from same-sized, recorded sources", () => {
    const channel = (assetId: string) => ({
      sourceAssetId: assetId,
      plane: 0,
      channel: null,
      display: { ...IDENTITY_DISPLAY_V3, lut: "green" as const },
      visible: true,
    });
    const composite = (assets: string[]): FigureObject => ({
      ...base,
      id: "merge",
      type: "composite",
      transform: box,
      composite: {
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        channels: assets.map(channel),
      },
    });
    const sources = [source("a"), source("b"), source("c", { widthPx: 300 })];
    expect(decodeFigureDocument(documentWith([composite(["a", "b"])], { sources }))).toBeDefined();
    expect(() =>
      decodeFigureDocument(documentWith([composite(["a", "c"])], { sources })),
    ).toThrowError(/different sizes/);
    expect(() =>
      decodeFigureDocument(documentWith([composite(["a", "z"])], { sources })),
    ).toThrowError(/source entry/);
  });

  it("requires calibration for scale bars and attaches them to image panels", () => {
    const scaleBar: Extract<FigureObject, { type: "scale-bar" }> = {
      ...base,
      id: "bar",
      type: "scale-bar",
      transform: box,
      scaleBar: {
        targetObjectId: "view-1",
        lengthUm: 50,
        displayUnit: "µm",
        thicknessPt: 2,
        colorHex: "#FFFFFF",
        showLabel: true,
        fontSizePt: 8,
      },
    };
    const calibrated = source("asset-1", {
      calibration: { umPerPxX: 0.2, umPerPxY: 0.2, origin: "metadata" },
    });
    expect(
      decodeFigureDocument(documentWith([view(), scaleBar], { sources: [calibrated] })),
    ).toBeDefined();
    expect(() =>
      decodeFigureDocument(documentWith([view(), scaleBar], { sources: [source()] })),
    ).toThrowError(/calibrated source/);
    const onText = { ...scaleBar, scaleBar: { ...scaleBar.scaleBar, targetObjectId: "text-1" } };
    expect(() =>
      decodeFigureDocument(documentWith([view(), onText, text()], { sources: [calibrated] })),
    ).toThrowError(/image panel/);
  });

  it("requires marked sources for MW labels and one source for zoom links", () => {
    const mw: FigureObject = {
      ...base,
      id: "mw",
      type: "mw-labels",
      transform: box,
      mwLabels: {
        targetObjectId: "view-1",
        side: "left",
        fontSizePt: 7,
        tickLengthPt: 3,
        colorHex: "#000000",
        showUnit: true,
      },
    };
    expect(() => decodeFigureDocument(documentWith([view(), mw]))).toThrowError(/source entry/);
    const marked = (yPx: number) => source("asset-1", { markers: [{ yPx, kDa: 70 }] });
    expect(
      decodeFigureDocument(documentWith([view(), mw], { sources: [marked(50)] })),
    ).toBeDefined();
    expect(() =>
      decodeFigureDocument(documentWith([view(), mw], { sources: [marked(500)] })),
    ).toThrowError(/outside/);

    const zoom: FigureObject = {
      ...base,
      id: "zoom",
      type: "zoom-link",
      transform: box,
      zoomLink: { sourceObjectId: "view-1", insetObjectId: "view-2", stroke, connectors: true },
    };
    const inset = view({ id: "view-2" });
    expect(
      decodeFigureDocument(documentWith([view(), inset, zoom], { sources: [source()] })),
    ).toBeDefined();
    const elsewhere = view({ id: "view-2" }, { sourceAssetId: "asset-2" });
    expect(() =>
      decodeFigureDocument(
        documentWith([view(), elsewhere, zoom], { sources: [source(), source("asset-2")] }),
      ),
    ).toThrowError(/same source/);
  });

  it("keeps lane-table rows within their lanes", () => {
    const table = (
      cells: { text: string; span: number; underline: boolean }[],
      centers: number[] | null = null,
    ): FigureObject => ({
      ...base,
      id: "lanes",
      type: "lane-table",
      transform: box,
      laneTable: {
        targetObjectId: "view-1",
        lanes: 4,
        laneCenters: centers,
        placement: "above",
        rows: [{ cells }],
        fontSizePt: 7,
        colorHex: "#000000",
        gapPt: 2,
      },
    });
    const ok = [
      { text: "HeLa", span: 2, underline: true },
      { text: "HEK293", span: 2, underline: true },
    ];
    expect(decodeFigureDocument(documentWith([view(), table(ok)]))).toBeDefined();
    expect(() =>
      decodeFigureDocument(
        documentWith([view(), table([{ text: "x", span: 5, underline: false }])]),
      ),
    ).toThrowError(/wider than its lanes/);
    expect(() => decodeFigureDocument(documentWith([view(), table(ok, [0.1, 0.9])]))).toThrowError(
      /one center per lane/,
    );
  });

  it("accepts text, lines, and brackets from v2", () => {
    const document = documentWith([
      text(),
      {
        ...base,
        id: "line-1",
        type: "line",
        transform: { xPt: 0, yPt: 50, widthPt: 100, heightPt: 0, rotationDeg: 0 },
        line: { direction: "down", heads: "end", stroke },
      },
      {
        ...base,
        id: "bracket-1",
        type: "shape",
        transform: { xPt: 0, yPt: 0, widthPt: 60, heightPt: 4, rotationDeg: 0 },
        shape: { kind: "bracket", opening: "down", stroke },
      },
    ]);
    expect(decodeFigureDocument(document)).toEqual(document);
  });

  it("rejects duplicate sources, labels on missing targets, and bad groups", () => {
    expect(() =>
      decodeFigureDocument(documentWith([], { sources: [source(), source()] })),
    ).toThrowError(/unique per asset/);
    expect(() =>
      decodeFigureDocument(
        documentWith([text({ panelLabel: { targetObjectId: "missing", auto: true } })]),
      ),
    ).toThrowError(/missing object/);
    for (const groups of [
      [{ id: "g1", objectIds: ["view-1", "missing"] }],
      [{ id: "g1", objectIds: ["view-1"] }],
      [{ id: "view-1", objectIds: ["view-1", "text-1"] }],
    ])
      expect(() => decodeFigureDocument(documentWith([view(), text()], { groups }))).toThrow(
        FigureDocumentDecodeError,
      );
  });
});

function preset(id: string) {
  const found = ARTBOARD_SIZE_PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
}

describe("artboard size presets", () => {
  it("converts journal widths to points", () => {
    expect(mmToPt(25.4)).toBe(72);
    expect(presetSizePt(preset("nature-single"), 792)).toEqual({
      widthPt: mmToPt(89),
      heightPt: mmToPt(170),
    });
    expect(presetSizePt(preset("nature-single"), 200)).toEqual({
      widthPt: mmToPt(89),
      heightPt: 200,
    });
  });

  it("uses fixed page sizes and unique IDs", () => {
    expect(presetSizePt(preset("a4"), 1)).toEqual({ widthPt: mmToPt(210), heightPt: mmToPt(297) });
    const ids = ARTBOARD_SIZE_PRESETS.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
