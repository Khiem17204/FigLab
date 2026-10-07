import {
  type Canvas2DLike,
  drawVectorItems,
  type VectorRasterizer,
  type VectorSceneItem,
} from "@figlab/image-processing";

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(widthPx: number, heightPx: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(widthPx, heightPx);
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  return canvas;
}

function context2d(canvas: AnyCanvas) {
  const context = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) throw new Error("This browser cannot draw text and shapes for export");
  return context;
}

/** Rasterizes vector items for export with the shared canvas renderer (fonts must be loaded). */
export const rasterizeVectorItems: VectorRasterizer = async (items, region, pxPerPt) => {
  const canvas = createCanvas(region.widthPx, region.heightPx);
  const context = context2d(canvas);
  context.setTransform(pxPerPt.x, 0, 0, pxPerPt.y, -region.leftPx, -region.topPx);
  drawVectorItems(context as unknown as Canvas2DLike, items);
  // getImageData returns non-premultiplied RGBA, as the CPU compositor expects.
  const { data } = context.getImageData(0, 0, region.widthPx, region.heightPx);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

/** Draws one vector item at screen scale for the editor preview. */
export function renderVectorItemCanvas(
  item: VectorSceneItem,
  pxPerPt: number,
):
  | {
      canvas: AnyCanvas;
      bounds: { leftPt: number; topPt: number; widthPt: number; heightPt: number };
    }
  | undefined {
  const leftPt = Math.floor(item.bounds.left);
  const topPt = Math.floor(item.bounds.top);
  const widthPt = Math.ceil(item.bounds.right) - leftPt;
  const heightPt = Math.ceil(item.bounds.bottom) - topPt;
  const widthPx = Math.ceil(widthPt * pxPerPt);
  const heightPx = Math.ceil(heightPt * pxPerPt);
  if (widthPx < 1 || heightPx < 1 || widthPx * heightPx > 16_000_000) return undefined;
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") return undefined;
  const canvas = createCanvas(widthPx, heightPx);
  const context = context2d(canvas);
  context.setTransform(pxPerPt, 0, 0, pxPerPt, -leftPt * pxPerPt, -topPt * pxPerPt);
  drawVectorItems(context as unknown as Canvas2DLike, [item]);
  return { canvas, bounds: { leftPt, topPt, widthPt, heightPt } };
}
