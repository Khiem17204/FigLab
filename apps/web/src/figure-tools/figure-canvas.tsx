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
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { type ArtboardScreenTransform, artboardScreenTransform } from "../editor/geometry";
import type { BrowserRasterRepository } from "../editor/raster-sources";
import type { EditorSessionState, EditorTool, Point } from "../editor/session-store";
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
export function FigureCanvas({
  session,
  rasterSources,
  metrics,
}: {
  session: StoreApi<EditorSessionState>;
  rasterSources: BrowserRasterRepository;
  metrics: TextMetrics;
}) {
  const state = useStore(session);
  const host = useRef<HTMLDivElement>(null);
  const board =
    state.document.artboards.find((artboard) => artboard.id === state.activeArtboardId) ??
    state.document.artboards[0];
  const [screen, setScreen] = useState<ArtboardScreenTransform>();
  const [drag, setDrag] = useState<Drag>();
  useEffect(() => {
    const target = host.current;
    if (!target || !board) return;
    const update = () =>
      setScreen(
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
  return (
    <div
      className={`artboard-wrap figure-canvas tool-${state.tool}`}
      onPointerDown={beginBackground}
      onPointerMove={moveBackground}
      onPointerUp={endBackground}
      ref={host}
    >
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
              x={screen.leftPx + Math.min(pending.startPt.x, pending.currentPt.x) * screen.scale}
              y={screen.topPx + Math.min(pending.startPt.y, pending.currentPt.y) * screen.scale}
            />
          )}
        </svg>
      )}
    </div>
  );
}
