import {
  boundsIntersect,
  createObjectCommand,
  type ObjectTransform,
  objectBounds,
  type ResizeAnchor,
  textBoxSize,
} from "@figlab/editor-core";
import type { FigureObject, TextStyleV2 } from "@figlab/figure-schema";
import type { TextMetrics } from "@figlab/image-processing";
import { FitIcon, IconButton, MinusIcon, PlusIcon, Toolbar } from "@figlab/ui";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { ArtboardScreenTransform } from "../editor/geometry";
import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState, EditorTool, Point } from "../editor/session-store";
import { isTextEntryTarget } from "../editor-ui/dom-helpers";
import { formatZoom, stageTransform, stepZoom, type ZoomLevel } from "../editor-ui/zoom";
import { PixiArtboard } from "../pixi-artboard";
import "./figure-tools.css";

export const DEFAULT_TEXT_STYLE: TextStyleV2 = {
  fontSizePt: 10,
  bold: false,
  italic: false,
  underline: false,
  colorHex: "#000000",
  align: "start",
  backgroundHex: null,
};
const DEFAULT_STROKE = { colorHex: "#000000", widthPt: 1, dashed: false };
const RESIZE_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

/** Builds the object a creation tool draws between two artboard points. */
export function objectForTool(
  tool: Exclude<EditorTool, "select">,
  start: Point,
  end: Point,
  base: { id: string; artboardId: string; zIndex: number },
  measure: TextMetrics["measure"],
): FigureObject {
  const common = { ...base, locked: false, hidden: false };
  const dragged = Math.abs(end.x - start.x) > 2 || Math.abs(end.y - start.y) > 2;
  if (tool === "text") {
    const size = textBoxSize("Text", DEFAULT_TEXT_STYLE, measure);
    return {
      ...common,
      type: "text",
      transform: { xPt: start.x, yPt: start.y, ...size, rotationDeg: 0 },
      text: { content: "Text", style: { ...DEFAULT_TEXT_STYLE } },
    };
  }
  if (tool === "line" || tool === "arrow") {
    const to = dragged ? end : { x: start.x + 60, y: start.y };
    const left = Math.min(start.x, to.x);
    const top = Math.min(start.y, to.y);
    // Lines always run left to right; a leftward arrow puts its head at the start.
    const rightward = to.x >= start.x;
    const [from, toward] = rightward ? [start, to] : [to, start];
    return {
      ...common,
      type: "line",
      transform: {
        xPt: left,
        yPt: top,
        widthPt: Math.abs(to.x - start.x),
        heightPt: Math.abs(to.y - start.y),
        rotationDeg: 0,
      },
      line: {
        direction: toward.y >= from.y ? "down" : "up",
        heads: tool === "line" ? "none" : rightward ? "end" : "start",
        stroke: { ...DEFAULT_STROKE },
      },
    };
  }
  const width = dragged ? Math.max(1, Math.abs(end.x - start.x)) : 60;
  const height = dragged ? Math.max(1, Math.abs(end.y - start.y)) : tool === "bracket" ? 6 : 40;
  const transform = {
    xPt: dragged ? Math.min(start.x, end.x) : start.x,
    yPt: dragged ? Math.min(start.y, end.y) : start.y,
    widthPt: width,
    heightPt: height,
    rotationDeg: 0,
  };
  if (tool === "bracket")
    return {
      ...common,
      type: "shape",
      transform,
      shape: { kind: "bracket", opening: "down", stroke: { ...DEFAULT_STROKE } },
    };
  return {
    ...common,
    type: "shape",
    transform,
    shape: { kind: tool, stroke: { ...DEFAULT_STROKE }, fillHex: null },
  };
}

function transformStyle(transform: ObjectTransform, screen?: ArtboardScreenTransform) {
  if (!screen) return {};
  return {
    left: `${screen.leftPx + transform.xPt * screen.scale}px`,
    top: `${screen.topPx + transform.yPt * screen.scale}px`,
    width: `${Math.max(6, transform.widthPt * screen.scale)}px`,
    height: `${Math.max(6, transform.heightPt * screen.scale)}px`,
    ...(transform.rotationDeg ? { transform: `rotate(${transform.rotationDeg}deg)` } : {}),
  };
}

type Drag =
  | { kind: "object"; pointerId: number; origin: Point; objectId: string; resize?: ResizeAnchor }
  | {
      kind: "marquee" | "create";
      pointerId: number;
      startPt: Point;
      currentPt: Point;
      additive: boolean;
    };

/**
 * The editable view of the active figure: Pixi draws it, and an accessible DOM layer handles
 * selection, moving, resizing, marquee selection, snapping guides, and drawing new objects.
 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

export function FigureCanvas({
  session,
  rasterSources,
  metrics,
  zoom = "fit",
  onZoomChange = () => undefined,
}: {
  session: StoreApi<EditorSessionState>;
  rasterSources: BrowserRasterRepository;
  metrics: TextMetrics;
  /** "fit" tracks the viewport; a number is CSS pixels per point (1 = actual size). */
  zoom?: ZoomLevel;
  onZoomChange?: (zoom: ZoomLevel) => void;
}) {
  const state = useStore(session);
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const board =
    state.document.artboards.find((artboard) => artboard.id === state.activeArtboardId) ??
    state.document.artboards[0];
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [drag, setDrag] = useState<Drag>();
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const update = () => setSize({ width: target.clientWidth, height: target.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const boardWidth = board?.widthPt;
  const boardHeight = board?.heightPt;
  const stage = useMemo(
    () =>
      size && boardWidth && boardHeight
        ? stageTransform(size.width, size.height, boardWidth, boardHeight, zoom)
        : undefined,
    [boardWidth, boardHeight, size, zoom],
  );
  const screen: ArtboardScreenTransform | undefined = stage;

  // Keep the point at the center of the viewport in place when the zoom changes.
  const previous = useRef<{ scale: number; width: number; height: number }>(undefined);
  useLayoutEffect(() => {
    const target = viewport.current;
    if (!target || !stage) return;
    const before = previous.current;
    previous.current = {
      scale: stage.scale,
      width: stage.stageWidthPx,
      height: stage.stageHeightPx,
    };
    if (!before || before.scale === stage.scale) return;
    const centerX = (target.scrollLeft + target.clientWidth / 2) / before.width;
    const centerY = (target.scrollTop + target.clientHeight / 2) / before.height;
    target.scrollLeft = centerX * stage.stageWidthPx - target.clientWidth / 2;
    target.scrollTop = centerY * stage.stageHeightPx - target.clientHeight / 2;
  }, [stage]);

  // Pinch, Ctrl/⌘ + wheel, and Mod+= / Mod+- / Mod+0 / Mod+1 change the zoom.
  const scaleRef = useRef(1);
  scaleRef.current = stage?.scale ?? 1;
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = scaleRef.current * Math.exp(-event.deltaY * 0.01);
      onZoomChange(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(3)))));
    };
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
    target.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [onZoomChange]);

  const toPoints = (event: { clientX: number; clientY: number }): Point => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || !screen) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left - screen.leftPx) / screen.scale,
      y: (event.clientY - rect.top - screen.topPx) / screen.scale,
    };
  };

  if (!board) return null;
  const gesture = state.objectGesture;
  const objects = state.document.objects
    .filter((object) => object.artboardId === board.id && !object.hidden)
    .sort((left, right) => left.zIndex - right.zIndex);
  const selected = new Set(state.selectedIds);

  const beginObject = (event: ReactPointerEvent, objectId: string, resize?: ResizeAnchor) => {
    event.stopPropagation();
    if (state.tool !== "select") session.getState().setTool("select");
    if (event.shiftKey && !resize) {
      session.getState().select([objectId], "toggle");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!selected.has(objectId)) session.getState().select([objectId]);
    session.getState().beginObjectGesture(objectId);
    setDrag({
      kind: "object",
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      objectId,
      ...(resize ? { resize } : {}),
    });
  };
  const moveObject = (event: ReactPointerEvent) => {
    if (drag?.kind !== "object" || drag.pointerId !== event.pointerId || !screen) return;
    const delta = screen.screenDeltaToPoints({
      x: event.clientX - drag.origin.x,
      y: event.clientY - drag.origin.y,
    });
    if (drag.resize) session.getState().previewObjectResize(delta, drag.resize);
    else session.getState().previewObjectDelta(delta);
  };
  const endObject = (event: ReactPointerEvent) => {
    if (drag?.kind !== "object" || drag.pointerId !== event.pointerId) return;
    setDrag(undefined);
    session.getState().commitObjectTransform();
  };

  const beginBackground = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPoints(event);
    setDrag({
      kind: state.tool === "select" ? "marquee" : "create",
      pointerId: event.pointerId,
      startPt: point,
      currentPt: point,
      additive: event.shiftKey,
    });
  };
  const moveBackground = (event: ReactPointerEvent) => {
    if (!drag || drag.kind === "object" || drag.pointerId !== event.pointerId) return;
    setDrag({ ...drag, currentPt: toPoints(event) });
  };
  const endBackground = (event: ReactPointerEvent) => {
    if (!drag || drag.kind === "object" || drag.pointerId !== event.pointerId) return;
    setDrag(undefined);
    const end = toPoints(event);
    if (drag.kind === "marquee") {
      const area = {
        left: Math.min(drag.startPt.x, end.x),
        top: Math.min(drag.startPt.y, end.y),
        right: Math.max(drag.startPt.x, end.x),
        bottom: Math.max(drag.startPt.y, end.y),
      };
      const tiny = area.right - area.left < 2 && area.bottom - area.top < 2;
      const hits = tiny
        ? []
        : objects
            .filter((object) => boundsIntersect(objectBounds(object), area))
            .map((object) => object.id);
      session.getState().select(hits, drag.additive ? "add" : "replace");
      return;
    }
    if (state.tool === "select") return;
    const id = `${state.tool}-${crypto.randomUUID()}`;
    const zIndex = Math.max(-1, ...objects.map((object) => object.zIndex)) + 1;
    session
      .getState()
      .apply(
        createObjectCommand(
          objectForTool(
            state.tool,
            drag.startPt,
            end,
            { id, artboardId: board.id, zIndex },
            metrics.measure,
          ),
        ),
        { selectedIds: [id] },
      );
    session.getState().setTool("select");
  };

  const pending = drag && drag.kind !== "object" ? drag : undefined;
  const singleSelected = state.selectedIds.length === 1 ? state.selectedIds[0] : undefined;
  const scale = stage?.scale ?? 1;
  return (
    <div className="artboard-wrap">
      <div className="artboard-viewport" ref={viewport}>
        <div
          className={`artboard-stage figure-canvas tool-${state.tool}`}
          onPointerDown={beginBackground}
          onPointerMove={moveBackground}
          onPointerUp={endBackground}
          ref={host}
          style={stage ? { width: stage.stageWidthPx, height: stage.stageHeightPx } : undefined}
        >
          {stage && (
            <div
              aria-hidden="true"
              className="artboard-paper"
              style={{
                left: stage.leftPx,
                top: stage.topPx,
                width: stage.widthPx,
                height: stage.heightPx,
              }}
            />
          )}
          <PixiArtboard
            artboardId={board.id}
            document={state.document}
            metrics={metrics}
            {...(gesture ? { previewTransforms: gesture.transforms } : {})}
            rasterSources={rasterSources}
            {...(screen ? { screenTransform: screen } : {})}
          />
          <div className="selection-layer">
            {objects.map((object) => {
              const transform = gesture?.transforms.get(object.id) ?? object.transform;
              const isSelected = selected.has(object.id);
              return (
                <div
                  className={`artboard-selection object-${object.type}${isSelected ? " selected" : ""}${object.locked ? " locked" : ""}`}
                  key={object.id}
                  style={transformStyle(transform, screen)}
                >
                  <button
                    aria-label={`Move ${object.id}`}
                    aria-pressed={isSelected}
                    className="move-handle"
                    onPointerDown={(event) => beginObject(event, object.id)}
                    onPointerMove={moveObject}
                    onPointerUp={endObject}
                    type="button"
                  />
                  {singleSelected === object.id &&
                    !object.locked &&
                    RESIZE_ANCHORS.map((anchor) => (
                      <button
                        aria-label={`Resize ${object.id} from ${anchor.replace("-", " ")}`}
                        className={`resize-handle ${anchor}`}
                        key={anchor}
                        onPointerDown={(event) => beginObject(event, object.id, anchor)}
                        onPointerMove={moveObject}
                        onPointerUp={endObject}
                        type="button"
                      />
                    ))}
                </div>
              );
            })}
          </div>
          {screen && (
            <svg aria-hidden="true" className="figure-overlay">
              {gesture?.guides.map((guide) =>
                guide.axis === "x" ? (
                  <line
                    className="snap-guide"
                    key={`x${guide.positionPt}`}
                    x1={screen.leftPx + guide.positionPt * screen.scale}
                    x2={screen.leftPx + guide.positionPt * screen.scale}
                    y1={screen.topPx + guide.fromPt * screen.scale}
                    y2={screen.topPx + guide.toPt * screen.scale}
                  />
                ) : (
                  <line
                    className="snap-guide"
                    key={`y${guide.positionPt}`}
                    x1={screen.leftPx + guide.fromPt * screen.scale}
                    x2={screen.leftPx + guide.toPt * screen.scale}
                    y1={screen.topPx + guide.positionPt * screen.scale}
                    y2={screen.topPx + guide.positionPt * screen.scale}
                  />
                ),
              )}
              {pending && (
                <rect
                  className={pending.kind === "marquee" ? "marquee" : "draft"}
                  height={Math.abs(pending.currentPt.y - pending.startPt.y) * screen.scale}
                  width={Math.abs(pending.currentPt.x - pending.startPt.x) * screen.scale}
                  x={
                    screen.leftPx + Math.min(pending.startPt.x, pending.currentPt.x) * screen.scale
                  }
                  y={screen.topPx + Math.min(pending.startPt.y, pending.currentPt.y) * screen.scale}
                />
              )}
            </svg>
          )}
        </div>
      </div>
      <p className="artboard-meta">
        {board.name} · {formatPoints(board.widthPt)} × {formatPoints(board.heightPt)} pt
      </p>
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
