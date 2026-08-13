import type { FigureDocumentV1 } from "@figlab/figure-schema";
import { Application, Graphics } from "pixi.js";
import { useEffect, useRef } from "react";

export function PixiArtboard({ document }: { document: FigureDocumentV1 }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const target = host.current;
    if (!target) return;
    const app = new Application();
    void app.init({ background: "#ffffff", resizeTo: target, antialias: true }).then(() => {
      if (disposed || !host.current) return;
      host.current.replaceChildren(app.canvas);
      const board = document.artboards[0];
      if (!board) return;
      const scale = Math.min(
        app.screen.width / board.widthPt,
        app.screen.height / board.heightPt,
        1,
      );
      const artboard = new Graphics()
        .rect(0, 0, board.widthPt * scale, board.heightPt * scale)
        .fill({ color: board.backgroundHex })
        .stroke({ color: "#94a3b8", width: 1 });
      artboard.x = Math.max(0, (app.screen.width - board.widthPt * scale) / 2);
      artboard.y = Math.max(0, (app.screen.height - board.heightPt * scale) / 2);
      app.stage.addChild(artboard);
      for (const object of document.objects) {
        const raster = new Graphics()
          .rect(0, 0, object.transform.widthPt * scale, object.transform.heightPt * scale)
          .fill({ color: 0xcbd5e1, alpha: object.hidden ? 0 : 0.7 });
        raster.x = artboard.x + object.transform.xPt * scale;
        raster.y = artboard.y + object.transform.yPt * scale;
        app.stage.addChild(raster);
      }
    });
    return () => {
      disposed = true;
      app.destroy(true, { children: true, texture: false });
    };
  }, [document]);

  return <div aria-label="Pixi raster artboard" className="pixi-artboard" ref={host} role="img" />;
}
