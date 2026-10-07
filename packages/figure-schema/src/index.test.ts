import { describe, expect, it } from "vitest";
import {
  ARTBOARD_SIZE_PRESETS,
  CURRENT_FIGURE_SCHEMA_VERSION,
  createDefaultFigureDocument,
  createDefaultFigureDocumentV1,
  decodeFigureDocument,
  decodeFigureDocumentV1,
  type FigureDocument,
  FigureDocumentDecodeError,
  type FigureObject,
  type ImageViewObjectV1,
  migrateFigureDocument,
  mmToPt,
  presetSizePt,
  serializeFigureDocument,
} from "./index.js";

const imageView = (overrides: Partial<ImageViewObjectV1> = {}): ImageViewObjectV1 => ({
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

const documentWith = (...objects: FigureObject[]): FigureDocument => ({
  ...createDefaultFigureDocument("artboard-1"),
  objects,
});

describe("figure document v1", () => {
  it("still decodes strictly as v1 and rejects out-of-bounds crops", () => {
    const document = createDefaultFigureDocumentV1("artboard-1");
    document.objects.push(imageView());
    expect(decodeFigureDocumentV1(document)).toEqual(document);

    document.objects[0] = imageView({
      view: { ...imageView().view, viewport: { x: 0.8, y: 0.2, width: 0.3, height: 0.5 } },
    });
    expect(() => decodeFigureDocumentV1(document)).toThrow(FigureDocumentDecodeError);
  });
});

describe("figure document migration", () => {
  it("opens every v1 document as v2 with the same objects and no groups", () => {
    const v1 = createDefaultFigureDocumentV1("artboard-1");
    v1.objects.push(imageView());

    expect(migrateFigureDocument(v1)).toEqual({ ...v1, schemaVersion: 2, groups: [] });
  });

  it("validates v1 rules before upgrading", () => {
    const v1 = createDefaultFigureDocumentV1("artboard-1");
    v1.objects.push(imageView({ artboardId: "missing" }));
    expect(() => migrateFigureDocument(v1)).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
  });

  it("passes current documents through unchanged", () => {
    const document = documentWith(imageView(), text());
    expect(migrateFigureDocument(document)).toEqual(document);
  });

  it("rejects future and malformed versions with typed codes", () => {
    expect(() => migrateFigureDocument({ schemaVersion: 3 })).toThrowError(
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
    expect(CURRENT_FIGURE_SCHEMA_VERSION).toBe(2);
    expect(() => decodeFigureDocument(createDefaultFigureDocumentV1("artboard-1"))).toThrow(
      FigureDocumentDecodeError,
    );
  });
});

describe("figure document v2", () => {
  it("creates a US Letter document with empty collections", () => {
    expect(serializeFigureDocument(createDefaultFigureDocument("artboard-1"))).toBe(
      '{"schemaVersion":2,"artboards":[{"id":"artboard-1","name":"Figure 1","widthPt":612,"heightPt":792,"backgroundHex":"#FFFFFF"}],"objects":[],"groups":[],"constraints":[],"styles":[]}',
    );
  });

  it("accepts text, lines, shapes, and brackets", () => {
    const document = documentWith(
      text(),
      {
        id: "line-1",
        type: "line",
        artboardId: "artboard-1",
        transform: { xPt: 0, yPt: 50, widthPt: 100, heightPt: 0, rotationDeg: 0 },
        zIndex: 2,
        locked: false,
        hidden: false,
        line: {
          direction: "down",
          heads: "end",
          stroke: { colorHex: "#FF0000", widthPt: 1, dashed: false },
        },
      },
      {
        id: "rect-1",
        type: "shape",
        artboardId: "artboard-1",
        transform: { xPt: 0, yPt: 0, widthPt: 10, heightPt: 10, rotationDeg: 0 },
        zIndex: 3,
        locked: true,
        hidden: false,
        shape: { kind: "ellipse", stroke: null, fillHex: "#00FF00" },
      },
      {
        id: "bracket-1",
        type: "shape",
        artboardId: "artboard-1",
        transform: { xPt: 0, yPt: 0, widthPt: 60, heightPt: 4, rotationDeg: 0 },
        zIndex: 4,
        locked: false,
        hidden: false,
        shape: {
          kind: "bracket",
          opening: "down",
          stroke: { colorHex: "#000000", widthPt: 0.75, dashed: false },
        },
      },
    );
    expect(decodeFigureDocument(document)).toEqual(document);
  });

  it("rejects empty text, zero-length lines, and unknown fields", () => {
    const emptyText = text();
    if (emptyText.type === "text") emptyText.text.content = "";
    expect(() => decodeFigureDocument(documentWith(emptyText))).toThrow(FigureDocumentDecodeError);

    expect(() =>
      decodeFigureDocument(
        documentWith({
          id: "line-1",
          type: "line",
          artboardId: "artboard-1",
          transform: { xPt: 5, yPt: 5, widthPt: 0, heightPt: 0, rotationDeg: 0 },
          zIndex: 0,
          locked: false,
          hidden: false,
          line: {
            direction: "up",
            heads: "none",
            stroke: { colorHex: "#000000", widthPt: 1, dashed: true },
          },
        }),
      ),
    ).toThrowError(/zero length/);

    expect(() =>
      decodeFigureDocument({ ...documentWith(text()), objects: [{ ...text(), extra: 1 }] }),
    ).toThrow(FigureDocumentDecodeError);
  });

  it("requires panel labels to target an object on the same artboard", () => {
    const labelled = documentWith(
      imageView(),
      text({ panelLabel: { targetObjectId: "view-1", auto: true } }),
    );
    expect(decodeFigureDocument(labelled)).toEqual(labelled);

    expect(() =>
      decodeFigureDocument(
        documentWith(text({ panelLabel: { targetObjectId: "missing", auto: true } })),
      ),
    ).toThrowError(/missing object/);

    const crossBoard = {
      ...documentWith(
        imageView(),
        text({ artboardId: "board-2", panelLabel: { targetObjectId: "view-1", auto: true } }),
      ),
    };
    crossBoard.artboards.push({
      id: "board-2",
      name: "Figure 2",
      widthPt: 100,
      heightPt: 100,
      backgroundHex: "#FFFFFF",
    });
    expect(() => decodeFigureDocument(crossBoard)).toThrowError(/target's artboard/);
  });

  it("validates group membership", () => {
    const base = documentWith(imageView(), text());
    expect(
      decodeFigureDocument({ ...base, groups: [{ id: "g1", objectIds: ["view-1", "text-1"] }] }),
    ).toMatchObject({ groups: [{ id: "g1" }] });

    for (const groups of [
      [{ id: "g1", objectIds: ["view-1", "missing"] }],
      [
        { id: "g1", objectIds: ["view-1", "text-1"] },
        { id: "g2", objectIds: ["text-1", "view-1"] },
      ],
      [{ id: "view-1", objectIds: ["view-1", "text-1"] }],
      [{ id: "g1", objectIds: ["view-1"] }],
    ])
      expect(() => decodeFigureDocument({ ...base, groups })).toThrow(FigureDocumentDecodeError);
  });
});

function preset(id: string) {
  const found = ARTBOARD_SIZE_PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
}

describe("artboard size presets", () => {
  it("converts journal widths to points", () => {
    const nature = preset("nature-single");
    expect(mmToPt(25.4)).toBe(72);
    expect(presetSizePt(nature, 792)).toEqual({ widthPt: mmToPt(89), heightPt: mmToPt(170) });
    expect(presetSizePt(nature, 200)).toEqual({ widthPt: mmToPt(89), heightPt: 200 });
  });

  it("uses fixed page sizes and unique IDs", () => {
    expect(presetSizePt(preset("a4"), 1)).toEqual({ widthPt: mmToPt(210), heightPt: mmToPt(297) });
    const ids = ARTBOARD_SIZE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
