import {
  addArtboardCommand,
  approximateTextMeasure,
  groupObjectsCommand,
} from "@figlab/editor-core";
import { createDefaultFigureDocument, type FigureObject, mmToPt } from "@figlab/figure-schema";
import type { RasterSourceResolver } from "@figlab/image-processing";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { createEditorSession } from "../editor/session-store";
import { exportFigures, plannedExport, slug } from "./export-figure";
import { objectForTool } from "./figure-canvas";
import { matchingPresetId, nextFigureName } from "./figures-bar";
import { FALLBACK_TEXT_METRICS } from "./fonts";
import { describeAuditEvent } from "./history-panel";
import { handleFigureShortcut } from "./keyboard";
import { replaceSymbolShortcuts, SYMBOL_SHORTCUTS } from "./text-input";

vi.mock("./figure-tools.css", () => ({}));

const base = { id: "new", artboardId: "board", zIndex: 3 };

describe("drawing tools", () => {
  it("draws a leftward arrow as a left-to-right line with its head at the start", () => {
    const arrow = objectForTool(
      "arrow",
      { x: 100, y: 50 },
      { x: 40, y: 80 },
      base,
      approximateTextMeasure,
    );
    expect(arrow).toMatchObject({
      type: "line",
      transform: { xPt: 40, yPt: 50, widthPt: 60, heightPt: 30 },
      line: { direction: "up", heads: "start" },
    });
  });

  it("uses default sizes for a click and sizes text from its content", () => {
    expect(
      objectForTool("bracket", { x: 5, y: 5 }, { x: 5, y: 5 }, base, approximateTextMeasure),
    ).toMatchObject({
      transform: { xPt: 5, yPt: 5, widthPt: 60, heightPt: 6 },
      shape: { kind: "bracket", opening: "down" },
    });
    const text = objectForTool("text", { x: 1, y: 2 }, { x: 1, y: 2 }, base, () => 20);
    expect(text).toMatchObject({ type: "text", transform: { widthPt: 20, heightPt: 12 } });
  });
});

describe("text input", () => {
  it("replaces a shortcut as soon as its name is complete", () => {
    expect(replaceSymbolShortcuts("TNF\\alpha 10 \\muM \\pm 2\\deg")).toBe("TNFα 10 μM ± 2°");
    expect(replaceSymbolShortcuts("\\Delta\\beta")).toBe("Δβ");
    expect(replaceSymbolShortcuts("\\nope \\de")).toBe("\\nope \\de");
  });

  it("keeps every shortcut typeable: no name is a prefix of another", () => {
    const names = Object.keys(SYMBOL_SHORTCUTS);
    for (const name of names)
      expect(names.filter((other) => other !== name && other.startsWith(name))).toEqual([]);
  });
});

describe("figures bar helpers", () => {
  it("recognizes preset sizes and names new figures uniquely", () => {
    expect(matchingPresetId({ widthPt: 612, heightPt: 792 })).toBe("us-letter");
    expect(matchingPresetId({ widthPt: mmToPt(89), heightPt: 300 })).toBe("nature-single");
    expect(matchingPresetId({ widthPt: 100, heightPt: 100 })).toBe("custom");
    expect(nextFigureName([{ name: "Figure 1" }, { name: "Figure 3" }])).toBe("Figure 4");
    expect(nextFigureName([{ name: "Figure 2" }])).toBe("Figure 3");
  });
});

describe("history descriptions", () => {
  it("summarizes display changes and exports", () => {
    expect(
      describeAuditEvent({
        action: "DISPLAY_CHANGED",
        details: { before: { gamma: 1, invert: false }, after: { gamma: 1.5, invert: false } },
      }),
    ).toBe("Display adjusted: gamma 1 → 1.5");
    expect(
      describeAuditEvent({
        action: "EXPORT_CREATED",
        details: { format: "tiff", dpi: 600, revision: 4 },
      }),
    ).toBe("Exported: TIFF at 600 dpi, revision 4");
  });
});

describe("keyboard shortcuts", () => {
  const sessionWithShapes = () => {
    const document = createDefaultFigureDocument("board");
    const shape = (id: string, xPt: number): FigureObject => ({
      id,
      type: "shape",
      artboardId: "board",
      transform: { xPt, yPt: 10, widthPt: 10, heightPt: 10, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      shape: { kind: "rect", stroke: null, fillHex: "#000000" },
    });
    document.objects = [shape("a", 10), shape("b", 40)];
    return createEditorSession(document);
  };
  const key = (value: string, extra: Partial<KeyboardEvent> = {}) => ({
    key: value,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...extra,
  });

  it("selects all, nudges, duplicates, groups, and clears", () => {
    const session = sessionWithShapes();
    expect(handleFigureShortcut(key("ArrowLeft"), session)).toBe(false);
    handleFigureShortcut(key("a", { metaKey: true }), session);
    expect(session.getState().selectedIds).toEqual(["a", "b"]);
    handleFigureShortcut(key("ArrowRight", { shiftKey: true }), session);
    expect(session.getState().document.objects.map((object) => object.transform.xPt)).toEqual([
      20, 50,
    ]);
    handleFigureShortcut(key("g", { ctrlKey: true }), session);
    expect(session.getState().document.groups).toHaveLength(1);
    handleFigureShortcut(key("d", { metaKey: true }), session);
    expect(session.getState().document.objects).toHaveLength(4);
    expect(session.getState().selectedIds).not.toContain("a");
    handleFigureShortcut(key("Escape"), session);
    expect(session.getState().selectedIds).toEqual([]);
  });
});

describe("export orchestration", () => {
  const resolver: RasterSourceResolver = {
    async describe() {
      return { widthPx: 1, heightPx: 1, bitDepth: 8, channels: 3 };
    },
    async getRegion(_asset, sourceRect) {
      return {
        data: new Uint8Array([255, 0, 0]),
        sourceRect,
        widthPx: 1,
        heightPx: 1,
        bitDepth: 8,
        channels: 3,
        pyramidLevel: 0,
      };
    },
  };
  const document = (() => {
    let value = createDefaultFigureDocument("board");
    value.artboards[0] = {
      ...(value.artboards[0] as (typeof value.artboards)[number]),
      widthPt: 72,
      heightPt: 36,
    };
    value = addArtboardCommand({
      id: "board-2",
      name: "Figure 2: Blots",
      widthPt: 36,
      heightPt: 36,
      backgroundHex: "#FFFFFF",
    })(value);
    return groupObjectsCommand("g", [])(value);
  })();
  const fonts = { faces: {} as never, metrics: FALLBACK_TEXT_METRICS };

  it("plans pixel sizes from DPI for one or all figures", () => {
    expect(
      plannedExport({ document, scope: "figure", activeArtboardId: "board", dpi: 300 }).map(
        ({ widthPx, heightPx }) => [widthPx, heightPx],
      ),
    ).toEqual([[300, 150]]);
    expect(
      plannedExport({ document, scope: "all", activeArtboardId: "board", dpi: 150 }),
    ).toHaveLength(2);
    expect(slug("Figure 2: Blots")).toBe("figure-2-blots");
  });

  it("records every figure and zips several files", async () => {
    const records: unknown[] = [];
    const downloads: { blob: Blob; name: string }[] = [];
    const result = await exportFigures(
      {
        format: "png",
        dpi: 72,
        scope: "all",
        document,
        revision: 7,
        activeArtboardId: "board",
        projectName: "Cell Atlas",
      },
      {
        resolver,
        fonts,
        rasterize: async (_items, region) => new Uint8Array(region.widthPx * region.heightPx * 4),
        record: async (metadata) => {
          records.push(metadata);
        },
        download: (blob, name) => downloads.push({ blob, name }),
      },
    );
    expect(result).toEqual({ filename: "cell-atlas-figures-72dpi-png.zip", figures: 2 });
    expect(records).toEqual([
      expect.objectContaining({
        format: "png",
        artboardId: "board",
        dpi: 72,
        revision: 7,
        widthPx: 72,
        heightPx: 36,
      }),
      expect.objectContaining({ artboardId: "board-2", widthPx: 36, heightPx: 36 }),
    ]);
    const files = unzipSync(
      new Uint8Array(await (downloads[0] as { blob: Blob }).blob.arrayBuffer()),
    );
    expect(Object.keys(files)).toEqual([
      "cell-atlas-figure-1-72dpi.png",
      "cell-atlas-figure-2-blots-72dpi.png",
    ]);
  });

  it("writes one PDF for all figures and records each page with the file's checksum", async () => {
    const records: { artboardId?: string; checksumSha256: string }[] = [];
    const composePdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    await exportFigures(
      {
        format: "pdf",
        dpi: 300,
        scope: "all",
        document,
        revision: 2,
        activeArtboardId: "board",
        projectName: "Atlas",
      },
      {
        resolver,
        fonts,
        rasterize: async () => new Uint8Array(),
        record: async (metadata) => {
          records.push(metadata);
        },
        download: () => undefined,
        composePdf,
      },
    );
    expect(composePdf).toHaveBeenCalledWith(
      document,
      ["board", "board-2"],
      expect.objectContaining({ dpi: 300, title: "Atlas" }),
    );
    expect(records.map((record) => record.artboardId)).toEqual(["board", "board-2"]);
    expect(new Set(records.map((record) => record.checksumSha256)).size).toBe(1);
  });
});
