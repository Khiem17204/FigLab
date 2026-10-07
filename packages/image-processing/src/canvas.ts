import { FIGURE_FONT_FAMILY } from "./fonts.js";
import type { PathCommand, StrokeStyle, VectorPrimitive, VectorSceneItem } from "./scene.js";

/** The subset of `CanvasRenderingContext2D` the vector renderer uses. */
export type Canvas2DLike = {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(radians: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textBaseline: string;
  fontKerning?: string;
};

export function canvasFont(primitive: Extract<VectorPrimitive, { type: "text" }>): string {
  return `${primitive.italic ? "italic " : ""}${primitive.bold ? "700" : "400"} ${primitive.fontSizePt}px "${FIGURE_FONT_FAMILY}"`;
}

/**
 * Draws vector scene items in artboard points. Callers set the transform from points to device
 * pixels first (for example `scale(pxPerPt, pxPerPt)`), and load the bundled font beforehand.
 */
export function drawVectorItems(
  context: Canvas2DLike,
  items: ReadonlyArray<VectorSceneItem>,
): void {
  for (const item of items) {
    context.save();
    if (item.rotation) {
      context.translate(item.rotation.cx, item.rotation.cy);
      context.rotate((item.rotation.deg * Math.PI) / 180);
      context.translate(-item.rotation.cx, -item.rotation.cy);
    }
    for (const primitive of item.primitives) drawPrimitive(context, primitive);
    context.restore();
  }
}

function drawPrimitive(context: Canvas2DLike, primitive: VectorPrimitive): void {
  if (primitive.type === "text") {
    context.font = canvasFont(primitive);
    if ("fontKerning" in context) context.fontKerning = "none";
    context.textBaseline = "alphabetic";
    context.fillStyle = primitive.colorHex;
    context.fillText(primitive.text, primitive.x, primitive.baselineY);
    return;
  }
  context.beginPath();
  if (primitive.type === "ellipse")
    context.ellipse(primitive.cx, primitive.cy, primitive.rx, primitive.ry, 0, 0, Math.PI * 2);
  else tracePath(context, primitive.commands);
  if (primitive.fillHex) {
    context.fillStyle = primitive.fillHex;
    context.fill();
  }
  if (primitive.stroke) applyStroke(context, primitive.stroke);
}

function tracePath(context: Canvas2DLike, commands: ReadonlyArray<PathCommand>): void {
  for (const command of commands) {
    if (command.op === "M") context.moveTo(command.x, command.y);
    else if (command.op === "L") context.lineTo(command.x, command.y);
    else context.closePath();
  }
}

function applyStroke(context: Canvas2DLike, stroke: StrokeStyle): void {
  context.strokeStyle = stroke.colorHex;
  context.lineWidth = stroke.widthPt;
  context.lineCap = "butt";
  context.lineJoin = "miter";
  context.miterLimit = 4;
  context.setLineDash(stroke.dash);
  context.stroke();
  context.setLineDash([]);
}
