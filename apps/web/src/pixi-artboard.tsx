import { normalizedToPixelRect } from "@figlab/editor-core";
import type { FigureDocumentV1, ImageViewObjectV1, ObjectTransformV1 } from "@figlab/figure-schema";
import { Application, Assets, Container, Graphics, Sprite, type Texture } from "pixi.js";
import { useEffect, useRef } from "react";
import { type ArtboardScreenTransform, artboardScreenTransform } from "./editor/geometry";
import type { BrowserRasterRepository } from "./editor/raster-sources";

export async function buildPixiArtboardScene({
  stage,
  document,
  screenTransform,
  preview,
  loadTexture,
  isDisposed = () => false,
}: {
  stage: Container;
  document: FigureDocumentV1;
  screenTransform: ArtboardScreenTransform;
  preview?: { objectId: string; transform: ObjectTransformV1 };
  loadTexture: (object: ImageViewObjectV1) => Promise<Texture | undefined>;
  isDisposed?: () => boolean;
}) {
  const board = document.artboards[0];
  if (!board) return;
  const { scale, leftPx: left, topPx: top } = screenTransform;
  const artboard = new Graphics()
    .rect(0, 0, board.widthPt * scale, board.heightPt * scale)
    .fill({ color: board.backgroundHex })
    .stroke({ color: "#94a3b8", width: 1 });
  artboard.position.set(left, top);
  stage.addChild(artboard);

  const rasterLayer = new Container({ sortableChildren: true });
  stage.addChild(rasterLayer);
  const objects = document.objects
    .filter((object) => !object.hidden)
    .map((object, documentIndex) => ({ documentIndex, object }))
    .sort(
      (leftObject, rightObject) =>
        leftObject.object.zIndex - rightObject.object.zIndex ||
        leftObject.documentIndex - rightObject.documentIndex,
    );
  for (const { object } of objects) {
    const sourceTexture = await loadTexture(object);
    if (isDisposed()) return;
    if (!sourceTexture) continue;
    const sprite = new Sprite(sourceTexture);
    const transform = preview?.objectId === object.id ? preview.transform : object.transform;
    sprite.label = object.id;
    sprite.zIndex = object.zIndex;
    sprite.position.set(left + transform.xPt * scale, top + transform.yPt * scale);
    sprite.width = transform.widthPt * scale;
    sprite.height = transform.heightPt * scale;
    rasterLayer.addChild(sprite);
  }
}

export function PixiArtboard({
  document,
  preview,
  rasterSources,
  screenTransform,
}: {
  document: FigureDocumentV1;
  preview?: { objectId: string; transform: ObjectTransformV1 };
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
    void app.init({ background: "#cbd5e1", resizeTo: target, antialias: true }).then(async () => {
      initialized = true;
      if (disposed || !host.current) {
        app.destroy(true, { children: true, texture: false });
        return;
      }
      host.current.replaceChildren(app.canvas);
      const board = document.artboards[0];
      if (!board) return;
      const screen =
        screenTransform ??
        artboardScreenTransform(app.screen.width, app.screen.height, board.widthPt, board.heightPt);
      await buildPixiArtboardScene({
        stage: app.stage,
        document,
        screenTransform: screen,
        ...(preview ? { preview } : {}),
        isDisposed: () => disposed,
        loadTexture: async (object) => {
          if (!rasterSources.has(object.view.sourceAssetId)) return undefined;
          const source = await rasterSources.describe(object.view.sourceAssetId);
          const previewUrl = await rasterSources.getDisplayPreviewUrl(
            object.view.sourceAssetId,
            normalizedToPixelRect(object.view.viewport, source.widthPx, source.heightPx),
            object.view.display,
          );
          return Assets.load<Texture>(previewUrl);
        },
      });
    });
    return () => {
      disposed = true;
      if (initialized) app.destroy(true, { children: true, texture: false });
    };
  }, [document, preview, rasterSources, screenTransform]);
  return <div aria-label="Pixi raster artboard" className="pixi-artboard" ref={host} role="img" />;
}
