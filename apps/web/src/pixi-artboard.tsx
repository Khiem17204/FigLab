import { normalizedToPixelRect } from "@figlab/editor-core";
import type { FigureDocumentV1, ObjectTransformV1 } from "@figlab/figure-schema";
import { Application, Assets, Graphics, Sprite, type Texture } from "pixi.js";
import { useEffect, useRef } from "react";

import type { BrowserRasterRepository } from "./editor/raster-sources";

export function PixiArtboard({
  document,
  preview,
  rasterSources,
}: {
  document: FigureDocumentV1;
  preview?: { objectId: string; transform: ObjectTransformV1 };
  rasterSources: BrowserRasterRepository;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    const target = host.current;
    if (!target) return;
    const app = new Application();
    void app.init({ background: "#cbd5e1", resizeTo: target, antialias: true }).then(async () => {
      if (disposed || !host.current) return;
      host.current.replaceChildren(app.canvas);
      const board = document.artboards[0];
      if (!board) return;
      const scale = Math.min(
        app.screen.width / board.widthPt,
        app.screen.height / board.heightPt,
        1,
      );
      const left = Math.max(0, (app.screen.width - board.widthPt * scale) / 2);
      const top = Math.max(0, (app.screen.height - board.heightPt * scale) / 2);
      const artboard = new Graphics()
        .rect(0, 0, board.widthPt * scale, board.heightPt * scale)
        .fill({ color: board.backgroundHex })
        .stroke({ color: "#94a3b8", width: 1 });
      artboard.position.set(left, top);
      app.stage.addChild(artboard);
      for (const object of document.objects.filter((item) => !item.hidden)) {
        if (!rasterSources.has(object.view.sourceAssetId)) continue;
        const source = await rasterSources.describe(object.view.sourceAssetId);
        const previewUrl = await rasterSources.getDisplayPreviewUrl(
          object.view.sourceAssetId,
          normalizedToPixelRect(object.view.viewport, source.widthPx, source.heightPx),
          object.view.display,
        );
        const sourceTexture = await Assets.load<Texture>(previewUrl);
        if (disposed) return;
        const sprite = new Sprite(sourceTexture);
        const transform = preview?.objectId === object.id ? preview.transform : object.transform;
        const frame = new Graphics()
          .rect(0, 0, transform.widthPt * scale, transform.heightPt * scale)
          .fill({ color: 0xffffff });
        frame.position.set(left + transform.xPt * scale, top + transform.yPt * scale);
        frame.addChild(sprite);
        sprite.width = transform.widthPt * scale;
        sprite.height = transform.heightPt * scale;
        app.stage.addChild(frame);
      }
    });
    return () => {
      disposed = true;
      app.destroy(true, { children: true, texture: false });
    };
  }, [document, preview, rasterSources]);
  return <div aria-label="Pixi raster artboard" className="pixi-artboard" ref={host} role="img" />;
}
