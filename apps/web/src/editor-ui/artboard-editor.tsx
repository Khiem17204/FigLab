import type { ResizeAnchor } from "@figlab/editor-core";
import type { FigureDocumentV1, ImageViewObjectV1 } from "@figlab/figure-schema";
import { useEffect, useRef, useState } from "react";

import { type ArtboardScreenTransform, artboardScreenTransform } from "../editor/geometry";
import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { Point } from "../editor/session-store";
import { PixiArtboard } from "../pixi-artboard";
import { transformStyle } from "./dom-helpers";

export function ArtboardEditor({
  document,
  gesture,
  selectedId,
  rasterSources,
  onSelect,
  onMove,
  onResize,
  onCommit,
}: {
  document: FigureDocumentV1;
  gesture?: { objectId: string; transform: ImageViewObjectV1["transform"] };
  selectedId?: string;
  rasterSources: BrowserRasterRepository;
  onSelect: (id: string) => void;
  onMove: (id: string, delta: Point) => void;
  onResize: (id: string, delta: Point, anchor: ResizeAnchor) => void;
  onCommit: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const board = document.artboards[0];
  const [screenTransform, setScreenTransform] = useState<ArtboardScreenTransform>();
  useEffect(() => {
    const target = host.current;
    if (!target || !board) return;
    const update = () =>
      setScreenTransform(
        artboardScreenTransform(
          target.clientWidth,
          target.clientHeight,
          board.widthPt,
          board.heightPt,
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [board]);
  const starts = useRef(
    new Map<number, { x: number; y: number; id: string; resize?: ResizeAnchor }>(),
  );
  return (
    <div className="artboard-wrap" ref={host}>
      <PixiArtboard
        document={document}
        {...(gesture ? { preview: gesture } : {})}
        rasterSources={rasterSources}
        {...(screenTransform ? { screenTransform } : {})}
      />
      <div className="selection-layer">
        {document.objects.map((object) => {
          const transform =
            object.id === selectedId && gesture ? gesture.transform : object.transform;
          const begin = (event: React.PointerEvent, resize?: ResizeAnchor) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            starts.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
              id: object.id,
              ...(resize ? { resize } : {}),
            });
            onSelect(object.id);
          };
          const move = (event: React.PointerEvent) => {
            const start = starts.current.get(event.pointerId);
            if (!start) return;
            const screenDelta = { x: event.clientX - start.x, y: event.clientY - start.y };
            const delta = screenTransform?.screenDeltaToPoints(screenDelta) ?? screenDelta;
            if (start.resize) onResize(start.id, delta, start.resize);
            else onMove(start.id, delta);
          };
          const end = (event: React.PointerEvent) => {
            if (!starts.current.delete(event.pointerId)) return;
            onCommit();
          };
          return (
            <div
              className={`artboard-selection ${object.id === selectedId ? "selected" : ""}`}
              key={object.id}
              style={transformStyle(transform, screenTransform)}
            >
              <button
                aria-label={`Move ${object.id}`}
                className="move-handle"
                onPointerDown={begin}
                onPointerMove={move}
                onPointerUp={end}
                type="button"
              />
              {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((anchor) => (
                <button
                  aria-label={`Resize ${object.id} from ${anchor.replace("-", " ")}`}
                  className={`resize-handle ${anchor}`}
                  key={anchor}
                  onPointerDown={(event) => begin(event, anchor)}
                  onPointerMove={move}
                  onPointerUp={end}
                  type="button"
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
