import type { ObjectTransform } from "@figlab/editor-core";
import type { FigureDocument, FigureObject, ImagePanelObject } from "@figlab/figure-schema";
import {
  buildArtboardScene,
  documentSourceSizes,
  type TextMetrics,
  type VectorSceneItem,
} from "@figlab/image-processing";
import { Application, Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { useEffect, useRef } from "react";
import { type ArtboardScreenTransform, artboardScreenTransform } from "./editor/geometry";
import type { BrowserRasterRepository } from "./editor/raster-sources";
import { FALLBACK_TEXT_METRICS } from "./figure-tools/fonts";
import { renderVectorItemCanvas } from "./figure-tools/rasterize";

export type PreviewTransforms = ReadonlyMap<string, ObjectTransform>;

/** Applies in-progress gesture transforms to a copy of the document, for preview only. */
export function withPreviewTransforms(
  document: FigureDocument,
  preview: PreviewTransforms | undefined,
): FigureDocument {
  if (!preview || preview.size === 0) return document;
  return {
    ...document,
    objects: document.objects.map((object) => {
      const transform = preview.get(object.id);
      return transform ? ({ ...object, transform } as FigureObject) : object;
    }),
  };
}

export type VectorTexture = {
  texture: Texture;
  leftPt: number;
  topPt: number;
  widthPt: number;
  heightPt: number;
};

export async function buildPixiArtboardScene({
  stage,
  document,
  artboardId = document.artboards[0]?.id,
  screenTransform,
  previewTransforms,
  metrics = FALLBACK_TEXT_METRICS,
  loadTexture,
  loadVectorTexture,
  isDisposed = () => false,
}: {
  stage: Container;
  document: FigureDocument;
  artboardId?: string | undefined;
  screenTransform: ArtboardScreenTransform;
  previewTransforms?: PreviewTransforms;
  metrics?: TextMetrics;
  loadTexture: (object: ImagePanelObject) => Promise<Texture | undefined>;
  loadVectorTexture?: (item: VectorSceneItem, scale: number) => VectorTexture | undefined;
  isDisposed?: () => boolean;
}) {
  const board = document.artboards.find((candidate) => candidate.id === artboardId);
  if (!board) return;
  const { scale, leftPx: left, topPx: top } = screenTransform;
  const artboard = new Graphics()
    .rect(0, 0, board.widthPt * scale, board.heightPt * scale)
    .fill({ color: board.backgroundHex })
    .stroke({ color: "#94a3b8", width: 1 });
  artboard.position.set(left, top);
  stage.addChild(artboard);

  const layer = new Container({ sortableChildren: true });
  stage.addChild(layer);
  const previewed = withPreviewTransforms(document, previewTransforms);
  const zIndexOf = new Map(previewed.objects.map((object) => [object.id, object.zIndex]));
  // The scene already orders items; zIndex keeps Pixi's sort stable with that order.
  for (const item of buildArtboardScene(previewed, board.id, metrics).items) {
    if (item.kind === "raster") {
      const sourceTexture = await loadTexture(item.object);
      if (isDisposed()) return;
      if (!sourceTexture) continue;
      const sprite = new Sprite(sourceTexture);
      const { transform } = item.object;
      sprite.label = item.object.id;
      sprite.zIndex = item.object.zIndex;
      sprite.position.set(left + transform.xPt * scale, top + transform.yPt * scale);
      sprite.width = transform.widthPt * scale;
      sprite.height = transform.heightPt * scale;
      layer.addChild(sprite);
      continue;
    }
    const vector = loadVectorTexture?.(item, scale);
    if (!vector) continue;
    const sprite = new Sprite(vector.texture);
    sprite.label = item.objectId;
    sprite.zIndex = zIndexOf.get(item.objectId) ?? 0;
    sprite.position.set(left + vector.leftPt * scale, top + vector.topPt * scale);
    sprite.width = vector.widthPt * scale;
    sprite.height = vector.heightPt * scale;
    layer.addChild(sprite);
  }
}

export function PixiArtboard({
  document,
  artboardId,
  previewTransforms,
  metrics,
  rasterSources,
  screenTransform,
}: {
  document: FigureDocument;
  artboardId?: string;
  previewTransforms?: PreviewTransforms;
  metrics?: TextMetrics;
  rasterSources: BrowserRasterRepository;
  screenTransform?: ArtboardScreenTransform;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let initialized = false;
    const target = host.current;
    if (!target) return;
    const app = new Application();
    const vectorTextures: Texture[] = [];
    // Transparent so the themed canvas color and the paper shadow behind it show through.
    void app.init({ backgroundAlpha: 0, resizeTo: target, antialias: true }).then(async () => {
      initialized = true;
      if (disposed || !host.current) {
        app.destroy(true, { children: true, texture: false });
        return;
      }
      host.current.replaceChildren(app.canvas);
      const board =
        document.artboards.find((candidate) => candidate.id === artboardId) ??
        document.artboards[0];
      if (!board) return;
      const screen =
        screenTransform ??
        artboardScreenTransform(app.screen.width, app.screen.height, board.widthPt, board.heightPt);
      await buildPixiArtboardScene({
        stage: app.stage,
        document,
        artboardId: board.id,
        screenTransform: screen,
        ...(previewTransforms ? { previewTransforms } : {}),
        ...(metrics ? { metrics } : {}),
        isDisposed: () => disposed,
        loadTexture: async (object) => {
          const assets =
            object.type === "image-view"
              ? [object.view.sourceAssetId]
              : object.composite.channels.map((channel) => channel.sourceAssetId);
          if (!assets.every((assetId) => rasterSources.has(assetId))) return undefined;
          const previewUrl = await rasterSources.getPanelPreviewUrl(
            object,
            documentSourceSizes(document, rasterSources),
          );
          // Preview URLs are extension-less blob: URLs, so name the texture parser explicitly;
          // without it Pixi cannot pick a loader and the panel silently renders empty.
          return Assets.load<Texture>({ src: previewUrl, parser: "texture" });
        },
        loadVectorTexture: (item, scale) => {
          const rendered = renderVectorItemCanvas(item, scale * (window.devicePixelRatio || 1));
          if (!rendered) return undefined;
          const texture = Texture.from(rendered.canvas);
          vectorTextures.push(texture);
          return { texture, ...rendered.bounds };
        },
      });
    });
    return () => {
      disposed = true;
      if (initialized) app.destroy(true, { children: true, texture: false });
      for (const texture of vectorTextures) texture.destroy(true);
    };
  }, [artboardId, document, metrics, previewTransforms, rasterSources, screenTransform]);
  return <div aria-label="Pixi raster artboard" className="pixi-artboard" ref={host} role="img" />;
}
