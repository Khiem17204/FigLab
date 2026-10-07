import type { FigureDocument, ImageViewObjectV1 } from "@figlab/figure-schema";
import { BufferImageSource, Container, Graphics, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";

import { artboardScreenTransform } from "./editor/geometry";
import { buildPixiArtboardScene } from "./pixi-artboard";

const makeObject = (id: string, sourceAssetId: string, zIndex: number): ImageViewObjectV1 => ({
  id,
  type: "image-view",
  artboardId: "board",
  transform: { xPt: 0, yPt: 0, widthPt: 10, heightPt: 10, rotationDeg: 0 },
  zIndex,
  locked: false,
  hidden: false,
  view: {
    sourceAssetId,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    display: { brightness: 0, contrast: 1, gamma: 1, invert: false },
  },
});

const makeDocument = (objects: ImageViewObjectV1[]): FigureDocument => ({
  schemaVersion: 2,
  artboards: [
    { id: "board", name: "Figure 1", widthPt: 10, heightPt: 10, backgroundHex: "#FFFFFF" },
  ],
  objects,
  groups: [],
  constraints: [],
  styles: [],
});

const textureFromRgba = (rgba: [number, number, number, number]) =>
  new Texture({
    source: new BufferImageSource({
      resource: new Uint8Array(rgba),
      width: 1,
      height: 1,
    }),
  });

describe("Pixi artboard scene", () => {
  it("keeps a transparent top view as a direct sprite so the lower view remains visible", async () => {
    const lower = makeObject("lower", "opaque-green", 0);
    const top = makeObject("top", "transparent-red", 1);
    const textures = new Map([
      ["opaque-green", textureFromRgba([0, 255, 0, 255])],
      ["transparent-red", textureFromRgba([255, 0, 0, 0])],
    ]);
    const stage = new Container();

    await buildPixiArtboardScene({
      stage,
      document: makeDocument([lower, top]),
      screenTransform: artboardScreenTransform(10, 10, 10, 10),
      loadTexture: async (object) => {
        const texture = textures.get(object.view.sourceAssetId);
        if (!texture) throw new Error("Missing test texture");
        return texture;
      },
    });

    expect(stage.children[0]).toBeInstanceOf(Graphics);
    const rasterLayer = stage.children[1] as Container;
    expect(rasterLayer.children).toHaveLength(2);
    expect(rasterLayer.children.every((child) => child instanceof Sprite)).toBe(true);
    expect(rasterLayer.children.map((child) => child.label)).toEqual(["lower", "top"]);
    expect((rasterLayer.children[1] as Sprite).texture.source.resource).toEqual(
      new Uint8Array([255, 0, 0, 0]),
    );
  });

  it("adds views in stable zIndex order", async () => {
    const stage = new Container();
    const texture = textureFromRgba([0, 0, 0, 255]);

    await buildPixiArtboardScene({
      stage,
      document: makeDocument([
        makeObject("top", "top", 5),
        makeObject("tie-first", "tie-first", 2),
        makeObject("bottom", "bottom", -1),
        makeObject("tie-second", "tie-second", 2),
      ]),
      screenTransform: artboardScreenTransform(10, 10, 10, 10),
      loadTexture: async () => texture,
    });

    const rasterLayer = stage.children[1] as Container;
    expect(rasterLayer.sortableChildren).toBe(true);
    expect(rasterLayer.children.map((child) => [child.label, child.zIndex])).toEqual([
      ["bottom", -1],
      ["tie-first", 2],
      ["tie-second", 2],
      ["top", 5],
    ]);
  });
});
