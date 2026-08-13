import { describe, expect, it } from "vitest";
import {
  CURRENT_FIGURE_SCHEMA_VERSION,
  createDefaultFigureDocument,
  decodeFigureDocument,
  FigureDocumentDecodeError,
  migrateFigureDocument,
  serializeFigureDocument,
} from "./index.js";

describe("figure document v1", () => {
  it("creates a US Letter document with empty extensibility collections", () => {
    const document = createDefaultFigureDocument("artboard-1");

    expect(document).toEqual({
      schemaVersion: 1,
      artboards: [
        {
          id: "artboard-1",
          name: "Figure 1",
          widthPt: 612,
          heightPt: 792,
          backgroundHex: "#FFFFFF",
        },
      ],
      objects: [],
      groups: [],
      constraints: [],
      styles: [],
    });
  });

  it("accepts an image view whose normalized viewport touches source edges", () => {
    const document = createDefaultFigureDocument("artboard-1");
    document.objects.push({
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
    });

    expect(decodeFigureDocument(document)).toEqual(document);
  });

  it("rejects a crop that extends beyond the immutable source", () => {
    const document = createDefaultFigureDocument("artboard-1");
    document.objects.push({
      id: "view-1",
      type: "image-view",
      artboardId: "artboard-1",
      transform: { xPt: 36, yPt: 36, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      view: {
        sourceAssetId: "asset-1",
        viewport: { x: 0.8, y: 0.2, width: 0.3, height: 0.5 },
        display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
      },
    });

    expect(() => decodeFigureDocument(document)).toThrow(FigureDocumentDecodeError);
  });

  it("rejects future document versions with a typed code", () => {
    expect(() => decodeFigureDocument({ schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }),
    );
  });

  it("serializes the same document deterministically", () => {
    const document = createDefaultFigureDocument("artboard-1");

    expect(serializeFigureDocument(document)).toBe(
      '{"schemaVersion":1,"artboards":[{"id":"artboard-1","name":"Figure 1","widthPt":612,"heightPt":792,"backgroundHex":"#FFFFFF"}],"objects":[],"groups":[],"constraints":[],"styles":[]}',
    );
  });

  it("dispatches current-version documents through the migration boundary", () => {
    const document = createDefaultFigureDocument("artboard-1");
    expect(migrateFigureDocument(document)).toEqual(document);
  });

  it("rejects malformed version values at the migration boundary", () => {
    expect(() =>
      migrateFigureDocument({ ...createDefaultFigureDocument("artboard-1"), schemaVersion: 0 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(CURRENT_FIGURE_SCHEMA_VERSION).toBe(1);
  });
});
