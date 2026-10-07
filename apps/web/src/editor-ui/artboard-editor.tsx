import type { ResizeAnchor } from "@figlab/editor-core";
import type { FigureDocumentV1, ImageViewObjectV1 } from "@figlab/figure-schema";
import { FitIcon, IconButton, MinusIcon, PlusIcon, Toolbar } from "@figlab/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { Point } from "../editor/session-store";
import { PixiArtboard } from "../pixi-artboard";
import { isTextEntryTarget, transformStyle } from "./dom-helpers";
import { formatZoom, stageTransform, stepZoom, type ZoomLevel } from "./zoom";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

export function ArtboardEditor({
  document,
  gesture,
  selectedId,
  rasterSources,
  zoom,
  onZoomChange,
  onSelect,
  onMove,
  onResize,
  onCommit,
}: {
  document: FigureDocumentV1;
  gesture?: { objectId: string; transform: ImageViewObjectV1["transform"] };
  selectedId?: string;
  rasterSources: BrowserRasterRepository;
  zoom: ZoomLevel;
  onZoomChange: (zoom: ZoomLevel) => void;
  onSelect: (id: string) => void;
  onMove: (id: string, delta: Point) => void;
  onResize: (id: string, delta: Point, anchor: ResizeAnchor) => void;
  onCommit: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const board = document.artboards[0];
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const update = () => setSize({ width: target.clientWidth, height: target.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const screenTransform = useMemo(
    () =>
      size && board
        ? stageTransform(size.width, size.height, board.widthPt, board.heightPt, zoom)
        : undefined,
    [board, size, zoom],
  );

  // Keep the point at the center of the viewport in place when the zoom changes.
  const previous = useRef<{ scale: number; width: number; height: number }>(undefined);
  useLayoutEffect(() => {
    const target = viewport.current;
    if (!target || !screenTransform) return;
    const before = previous.current;
    previous.current = {
      scale: screenTransform.scale,
      width: screenTransform.stageWidthPx,
      height: screenTransform.stageHeightPx,
    };
    if (!before || before.scale === screenTransform.scale) return;
    const centerX = (target.scrollLeft + target.clientWidth / 2) / before.width;
    const centerY = (target.scrollTop + target.clientHeight / 2) / before.height;
    target.scrollLeft = centerX * screenTransform.stageWidthPx - target.clientWidth / 2;
    target.scrollTop = centerY * screenTransform.stageHeightPx - target.clientHeight / 2;
  }, [screenTransform]);

  // Pinch and Ctrl/⌘ + wheel zoom; needs a non-passive listener to stop page zoom.
  const scaleRef = useRef(1);
  scaleRef.current = screenTransform?.scale ?? 1;
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = scaleRef.current * Math.exp(-event.deltaY * 0.01);
      onZoomChange(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(3)))));
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [onZoomChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || isTextEntryTarget(event.target)) return;
      const current = scaleRef.current;
      if (event.key === "=" || event.key === "+") onZoomChange(stepZoom(current, 1));
      else if (event.key === "-") onZoomChange(stepZoom(current, -1));
      else if (event.key === "0") onZoomChange("fit");
      else if (event.key === "1") onZoomChange(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onZoomChange]);

  const starts = useRef(
    new Map<number, { x: number; y: number; id: string; resize?: ResizeAnchor }>(),
  );
  const scale = screenTransform?.scale ?? 1;
  return (
    <div className="artboard-wrap">
      <div className="artboard-viewport" ref={viewport}>
        <div
          className="artboard-stage"
          style={
            screenTransform
              ? { width: screenTransform.stageWidthPx, height: screenTransform.stageHeightPx }
              : undefined
          }
        >
          {screenTransform && (
            <div
              aria-hidden="true"
              className="artboard-paper"
              style={{
                left: screenTransform.leftPx,
                top: screenTransform.topPx,
                width: screenTransform.widthPx,
                height: screenTransform.heightPx,
              }}
            />
          )}
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
                  {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map(
                    (anchor) => (
                      <button
                        aria-label={`Resize ${object.id} from ${anchor.replace("-", " ")}`}
                        className={`resize-handle ${anchor}`}
                        key={anchor}
                        onPointerDown={(event) => begin(event, anchor)}
                        onPointerMove={move}
                        onPointerUp={end}
                        type="button"
                      />
                    ),
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {board && (
        <p className="artboard-meta">
          {board.name} · {formatPoints(board.widthPt)} × {formatPoints(board.heightPt)} pt
        </p>
      )}
      <Toolbar className="zoom-controls" label="Zoom">
        <IconButton
          disabled={scale <= MIN_ZOOM + 0.001}
          icon={<MinusIcon size={16} />}
          label="Zoom out"
          onClick={() => onZoomChange(stepZoom(scale, -1))}
          shortcut="Mod+-"
          size="sm"
          tooltipSide="top"
        />
        <button
          aria-label={`Zoom ${formatZoom(scale)}, show actual size`}
          className="zoom-value"
          onClick={() => onZoomChange(1)}
          title="Actual size (100% = 72 dpi)"
          type="button"
        >
          {formatZoom(scale)}
        </button>
        <IconButton
          disabled={scale >= MAX_ZOOM - 0.001}
          icon={<PlusIcon size={16} />}
          label="Zoom in"
          onClick={() => onZoomChange(stepZoom(scale, 1))}
          shortcut="Mod+="
          size="sm"
          tooltipSide="top"
        />
        <span aria-hidden="true" className="zoom-divider" />
        <IconButton
          aria-pressed={zoom === "fit"}
          icon={<FitIcon size={16} />}
          label="Fit to screen"
          onClick={() => onZoomChange("fit")}
          shortcut="Mod+0"
          size="sm"
          tooltipAlign="end"
          tooltipSide="top"
        />
      </Toolbar>
    </div>
  );
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
