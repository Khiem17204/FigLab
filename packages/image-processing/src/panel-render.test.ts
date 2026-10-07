import {
  createDefaultFigureDocument,
  type DisplayTransformV3,
  type FigureDocument,
  type FigureObject,
  IDENTITY_DISPLAY_V3,
  type ImageViewObjectV3,
} from "@figlab/figure-schema";
import { describe, expect, it } from "vitest";
import {
  applyDisplayV3,
  buildArtboardScene,
  cropSourceRect,
  laneBoundaries,
  panelToSourcePx,
  type RasterRegion,
  type RasterSourceResolver,
  renderPanelRgba,
  type SourcePixelRect,
  scaleBarLabel,
  sourcePxToPanel,
  syncDerivedTransforms,
  type TextMetrics,
} from "./index.js";

const metrics: TextMetrics = {
  measure: (text, style) => text.length * style.fontSizePt * 0.5,
  ascentEm: 0.9,
  descentEm: 0.2,
  underlinePositionEm: 0.1,
  underlineThicknessEm: 0.07,
};

/** Sources keyed by asset ID; each is one plane per entry of `planes`. */
function resolverFor(
  sources: Record<string, { width: number; height: number; channels: 1 | 3; planes: number[][] }>,
  reads: string[] = [],
): RasterSourceResolver {
  return {
    async describe(assetId) {
      const source = sources[assetId];
      if (!source) throw new Error(`no ${assetId}`);
      return {
        widthPx: source.width,
        heightPx: source.height,
        bitDepth: 8,
        channels: source.channels,
      };
    },
    async getRegion(assetId, rect: SourcePixelRect, _level, plane = 0): Promise<RasterRegion> {
      reads.push(`${assetId}:${plane}:${rect.x},${rect.y},${rect.width},${rect.height}`);
      const source = sources[assetId];
      if (!source) throw new Error(`no ${assetId}`);
      const data = new Uint8Array(rect.width * rect.height * source.channels);
      const samples = source.planes[plane] ?? [];
      for (let y = 0; y < rect.height; y += 1)
        for (let x = 0; x < rect.width; x += 1)
          for (let c = 0; c < source.channels; c += 1)
            data[(y * rect.width + x) * source.channels + c] =
              samples[((rect.y + y) * source.width + rect.x + x) * source.channels + c] ?? 0;
      return {
        data,
        sourceRect: rect,
        widthPx: rect.width,
        heightPx: rect.height,
        bitDepth: 8,
        channels: source.channels,
        pyramidLevel: 0,
      };
    },
  };
}

const display = (overrides: Partial<DisplayTransformV3> = {}): DisplayTransformV3 => ({
  ...IDENTITY_DISPLAY_V3,
  ...overrides,
});

function view(
  overrides: Partial<ImageViewObjectV3["view"]> = {},
  transform = { xPt: 0, yPt: 0, widthPt: 2, heightPt: 1 },
): ImageViewObjectV3 {
  return {
    id: "view",
    type: "image-view",
    artboardId: "board",
    transform: { ...transform, rotationDeg: 0 },
    zIndex: 0,
    locked: false,
    hidden: false,
    view: {
      sourceAssetId: "asset",
      plane: 0,
      channel: null,
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      display: display(),
      ...overrides,
    },
  };
}

const sizes = async () => ({ widthPx: 2, heightPx: 1 });
const pixels = (rgba: Uint8Array) =>
  Array.from({ length: rgba.length / 4 }, (_, index) => [
    ...rgba.subarray(index * 4, index * 4 + 4),
  ]);

describe("display v3", () => {
  it("maps levels before the v1 pipeline and reproduces v1 with identity levels", () => {
    expect(applyDisplayV3(0.5, display({ levels: { black: 0.25, white: 0.75 } }))).toBe(0.5);
    expect(applyDisplayV3(0.1, display({ levels: { black: 0.25, white: 0.75 } }))).toBe(0);
    expect(applyDisplayV3(0.25, display({ gamma: 2 }))).toBeCloseTo(0.5);
    expect(applyDisplayV3(0.3, display({ levels: { black: 0.5, white: 0.5 } }))).toBe(0);
  });
});

describe("panel rendering", () => {
  const grey = resolverFor({
    asset: {
      width: 2,
      height: 1,
      channels: 1,
      planes: [
        [0, 255],
        [255, 0],
      ],
    },
  });

  it("flips, selects planes, and colors with a LUT", async () => {
    expect(pixels(await renderPanelRgba(view({ flipX: true }), 2, 1, grey, sizes))).toEqual([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    expect(
      pixels(
        await renderPanelRgba(
          view({ plane: 1, display: display({ lut: "green" }) }),
          2,
          1,
          grey,
          sizes,
        ),
      ),
    ).toEqual([
      [0, 255, 0, 255],
      [0, 0, 0, 255],
    ]);
  });

  it("reads one channel of an RGB source, or its luminance under a LUT", async () => {
    const rgb = resolverFor({
      asset: { width: 2, height: 1, channels: 3, planes: [[10, 200, 30, 255, 0, 0]] },
    });
    expect(pixels(await renderPanelRgba(view({ channel: 1 }), 2, 1, rgb, sizes))[0]).toEqual([
      200, 200, 200, 255,
    ]);
    const luminance = pixels(
      await renderPanelRgba(view({ display: display({ lut: "red" }) }), 2, 1, rgb, sizes),
    );
    expect(luminance[1]).toEqual([Math.round(0.2126 * 255), 0, 0, 255]);
    await expect(renderPanelRgba(view({ channel: 3 }), 2, 1, rgb, sizes)).rejects.toThrow(
      /Channel 3/,
    );
  });

  it("rotates crops with bilinear sampling around their center", async () => {
    const source = resolverFor({
      asset: { width: 2, height: 2, channels: 1, planes: [[0, 100, 200, 255]] },
    });
    const square = async () => ({ widthPx: 2, heightPx: 2 });
    const rotated = view({ rotationDeg: 90 });
    // The crop turns 90° clockwise on the source, so the panel shows the source turned 90°
    // counter-clockwise: its top-left is the source's top-right.
    expect(
      pixels(await renderPanelRgba(rotated, 2, 2, source, square)).map(([value]) => value),
    ).toEqual([100, 255, 0, 200]);
    expect(cropSourceRect(rotated.view, { widthPx: 2, heightPx: 2 })).toEqual({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
  });

  it("adds composite channels and clamps", async () => {
    const two = resolverFor({
      a: { width: 2, height: 1, channels: 1, planes: [[255, 0]] },
      b: { width: 2, height: 1, channels: 1, planes: [[255, 128]] },
    });
    const composite: Extract<FigureObject, { type: "composite" }> = {
      id: "merge",
      type: "composite",
      artboardId: "board",
      transform: { xPt: 0, yPt: 0, widthPt: 2, heightPt: 1, rotationDeg: 0 },
      zIndex: 0,
      locked: false,
      hidden: false,
      composite: {
        viewport: { x: 0, y: 0, width: 1, height: 1 },
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        channels: [
          {
            sourceAssetId: "a",
            plane: 0,
            channel: null,
            display: display({ lut: "red" }),
            visible: true,
          },
          {
            sourceAssetId: "b",
            plane: 0,
            channel: null,
            display: display({ lut: "yellow" }),
            visible: true,
          },
          {
            sourceAssetId: "a",
            plane: 0,
            channel: null,
            display: display({ lut: "blue" }),
            visible: false,
          },
        ],
      },
    };
    expect(pixels(await renderPanelRgba(composite, 2, 1, two, sizes))).toEqual([
      [255, 255, 0, 255],
      [128, 128, 0, 255],
    ]);
  });

  it("maps source points to panel points and back through rotation and flips", () => {
    const crop = {
      viewport: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
      rotationDeg: 33,
      flipX: true,
      flipY: false,
    };
    const size = { widthPx: 640, heightPx: 480 };
    const point = panelToSourcePx(crop, size, 0.2, 0.7);
    const back = sourcePxToPanel(crop, size, point.x, point.y);
    expect(back.s).toBeCloseTo(0.2);
    expect(back.t).toBeCloseTo(0.7);
  });
});

describe("derived annotations", () => {
  const calibrated = {
    assetId: "asset",
    widthPx: 1000,
    heightPx: 500,
    calibration: { umPerPxX: 0.5, umPerPxY: 0.5, origin: "metadata" as const },
    markers: [
      { yPx: 100, kDa: 70 },
      { yPx: 400, kDa: 35 },
      { yPx: 490, kDa: 15 },
    ],
  };
  // The panel shows source x 0–500, y 0–450 at 200 × 180 pt: 0.4 pt per pixel.
  const panel = view(
    { viewport: { x: 0, y: 0, width: 0.5, height: 0.9 } },
    { xPt: 100, yPt: 100, widthPt: 200, heightPt: 180 },
  );
  const base = { artboardId: "board", zIndex: 1, locked: false, hidden: false };
  const documentWith = (...objects: FigureObject[]): FigureDocument => ({
    ...createDefaultFigureDocument("board"),
    sources: [calibrated],
    objects: [panel, ...objects],
  });
  const vectorOf = (document: FigureDocument, id: string) => {
    const item = buildArtboardScene(document, "board", metrics).items.find(
      (candidate) => candidate.kind === "vector" && candidate.objectId === id,
    );
    if (item?.kind !== "vector") throw new Error(`no vector ${id}`);
    return item;
  };

  it("derives scale bar length from calibration and panel scale", () => {
    const bar: FigureObject = {
      ...base,
      id: "bar",
      type: "scale-bar",
      transform: { xPt: 250, yPt: 260, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      scaleBar: {
        targetObjectId: "view",
        lengthUm: 50,
        displayUnit: "µm",
        thicknessPt: 2,
        colorHex: "#FFFFFF",
        showLabel: true,
        fontSizePt: 6,
      },
    };
    const item = vectorOf(documentWith(bar), "bar");
    const [rect, label] = item.primitives;
    // 50 µm / 0.5 µm/px = 100 px × 0.4 pt/px = 40 pt.
    expect(rect?.type === "path" && rect.commands[1]).toEqual({ op: "L", x: 290, y: 260 });
    expect(label?.type === "text" && label.text).toBe("50 µm");
    expect(scaleBarLabel(0.25, "nm")).toBe("250 nm");
    const synced = syncDerivedTransforms(documentWith(bar), metrics);
    // The stored box covers the bar and its centered label, which is wider than the bar here.
    expect(
      synced.objects.find((object) => object.id === "bar")?.transform.widthPt,
    ).toBeGreaterThanOrEqual(40);
  });

  it("labels only the ladder bands inside the crop", () => {
    const mw: FigureObject = {
      ...base,
      id: "mw",
      type: "mw-labels",
      transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      mwLabels: {
        targetObjectId: "view",
        side: "left",
        fontSizePt: 6,
        tickLengthPt: 3,
        colorHex: "#000000",
        showUnit: false,
      },
    };
    const texts = vectorOf(documentWith(mw), "mw").primitives.filter(
      (primitive) => primitive.type === "text",
    );
    expect(texts.map((primitive) => primitive.type === "text" && primitive.text)).toEqual([
      "70",
      "35",
    ]);
    const tick = vectorOf(documentWith(mw), "mw").primitives[0];
    // y = 100 + (100 / 450) × 180 = 140.
    expect(tick?.type === "path" && tick.commands[0]).toEqual({ op: "M", x: 97, y: 139.75 });
  });

  it("outlines an inset's crop on its source panel", () => {
    const inset = view(
      { viewport: { x: 0.1, y: 0.2, width: 0.1, height: 0.2 } },
      { xPt: 320, yPt: 100, widthPt: 50, heightPt: 50 },
    );
    const link: FigureObject = {
      ...base,
      id: "zoom",
      type: "zoom-link",
      transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      zoomLink: {
        sourceObjectId: "view",
        insetObjectId: "inset",
        stroke: { colorHex: "#FFFFFF", widthPt: 1, dashed: false },
        connectors: true,
      },
    };
    const document = documentWith({ ...inset, id: "inset" }, link);
    const [outline, upper] = vectorOf(document, "zoom").primitives;
    // Inset crop x 100–200 px, y 100–200 px → panel x 140–180 pt, y 140–180 pt.
    expect(outline?.type === "path" && outline.commands.slice(0, 3)).toEqual([
      { op: "M", x: 140, y: expect.closeTo(140, 6) },
      { op: "L", x: 180, y: expect.closeTo(140, 6) },
      { op: "L", x: 180, y: expect.closeTo(180, 6) },
    ]);
    expect(upper?.type === "path" && upper.commands).toEqual([
      { op: "M", x: 180, y: expect.closeTo(140, 6) },
      { op: "L", x: 320, y: 100 },
    ]);
  });

  it("centers lane cells over their lanes and stacks rows above the panel", () => {
    expect(laneBoundaries(4, null)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(laneBoundaries(2, [0.2, 0.6]).map((value) => Number(value.toFixed(9)))).toEqual([
      0, 0.4, 0.8,
    ]);
    const table: FigureObject = {
      ...base,
      id: "lanes",
      type: "lane-table",
      transform: { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, rotationDeg: 0 },
      laneTable: {
        targetObjectId: "view",
        lanes: 4,
        laneCenters: null,
        placement: "above",
        rows: [
          {
            cells: [
              { text: "HeLa", span: 2, underline: true },
              { text: "HEK", span: 2, underline: true },
            ],
          },
          { cells: ["+", "−", "+", "−"].map((text) => ({ text, span: 1, underline: false })) },
        ],
        fontSizePt: 10,
        colorHex: "#000000",
        gapPt: 2,
      },
    };
    const primitives = vectorOf(documentWith(table), "lanes").primitives;
    const texts = primitives.filter((primitive) => primitive.type === "text");
    // HeLa spans lanes 1–2 (x 100–200), centered at 150; "+" in lane 1 is centered at 125.
    expect(
      texts[0]?.type === "text" &&
        texts[0].x + metrics.measure("HeLa", { fontSizePt: 10 } as never) / 2,
    ).toBe(150);
    expect(texts[2]?.type === "text" && texts[2].x + 2.5).toBe(125);
    const last = texts.at(-1);
    expect(last?.type === "text" && last.baselineY).toBeLessThan(100);
    expect(primitives.filter((primitive) => primitive.type === "path")).toHaveLength(2);
  });
});
