import type { FigureDocument } from "@figlab/figure-schema";
import fontkit from "@pdf-lib/fontkit";
import {
  appendBezierCurve,
  closePath,
  concatTransformationMatrix,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  PDFDocument,
  type PDFFont,
  PDFNumber,
  PDFOperator,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setDashPattern,
  setFillingRgbColor,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import { renderPanelPng, sceneFor } from "./export.js";
import { type FontFaceBytes, type FontFaceKey, fontFaceKey } from "./fonts.js";
import { documentSourceSizes } from "./panel-render.js";
import type { RasterSourceResolver } from "./raster.js";
import type { StrokeStyle, TextMetrics, VectorPrimitive, VectorSceneItem } from "./scene.js";

const KAPPA = 0.5522847498;

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/**
 * Writes one artboard per page, sized in points. Vector items stay vector; text uses the
 * embedded bundled font; image panels are lossless PNGs rendered from original samples at `dpi`.
 */
export async function composeDocumentPdf(
  document: FigureDocument,
  artboardIds: ReadonlyArray<string>,
  options: {
    dpi: number;
    resolver: RasterSourceResolver;
    metrics: TextMetrics;
    fonts: FontFaceBytes;
    title?: string;
  },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setProducer("FigLab");
  pdf.setCreator("FigLab");
  if (options.title) pdf.setTitle(options.title);
  const sizes = documentSourceSizes(document, options.resolver);
  const fonts = new Map<FontFaceKey, PDFFont>();
  const fontFor = async (key: FontFaceKey) => {
    let font = fonts.get(key);
    if (!font) {
      font = await pdf.embedFont(options.fonts[key], {
        subset: true,
        features: { kern: false, liga: false },
      });
      fonts.set(key, font);
    }
    return font;
  };

  for (const artboardId of artboardIds) {
    const scene = sceneFor(document, artboardId, options.metrics);
    const page = pdf.addPage([scene.widthPt, scene.heightPt]);
    const height = scene.heightPt;
    const [r, g, b] = hexToRgb(scene.backgroundHex);
    page.drawRectangle({ x: 0, y: 0, width: scene.widthPt, height, color: rgb(r, g, b) });
    for (const item of scene.items) {
      if (item.kind === "raster") {
        const { png } = await renderPanelPng(item.object, options.dpi, options.resolver, sizes);
        const image = await pdf.embedPng(png);
        const { xPt, yPt, widthPt, heightPt } = item.object.transform;
        page.drawImage(image, {
          x: xPt,
          y: height - yPt - heightPt,
          width: widthPt,
          height: heightPt,
        });
        continue;
      }
      await drawVectorItem(page, height, item, fontFor);
    }
  }
  // Plain cross-reference tables (no object streams) for older readers and submission systems.
  return pdf.save({ useObjectStreams: false });
}

async function drawVectorItem(
  page: PDFPage,
  pageHeight: number,
  item: VectorSceneItem,
  fontFor: (key: FontFaceKey) => Promise<PDFFont>,
): Promise<void> {
  page.pushOperators(pushGraphicsState());
  if (item.rotation) {
    // Clockwise on screen is clockwise on the page: rotate by -deg in PDF's y-up space.
    const radians = (-item.rotation.deg * Math.PI) / 180;
    const cx = item.rotation.cx;
    const cy = pageHeight - item.rotation.cy;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    page.pushOperators(
      concatTransformationMatrix(
        cos,
        sin,
        -sin,
        cos,
        cx - cos * cx + sin * cy,
        cy - sin * cx - cos * cy,
      ),
    );
  }
  for (const primitive of item.primitives)
    await drawPrimitive(page, pageHeight, primitive, fontFor);
  page.pushOperators(popGraphicsState());
}

async function drawPrimitive(
  page: PDFPage,
  pageHeight: number,
  primitive: VectorPrimitive,
  fontFor: (key: FontFaceKey) => Promise<PDFFont>,
): Promise<void> {
  const y = (value: number) => pageHeight - value;
  if (primitive.type === "text") {
    const [r, g, b] = hexToRgb(primitive.colorHex);
    page.drawText(primitive.text, {
      x: primitive.x,
      y: y(primitive.baselineY),
      size: primitive.fontSizePt,
      font: await fontFor(fontFaceKey(primitive)),
      color: rgb(r, g, b),
    });
    return;
  }
  const operators: PDFOperator[] = [pushGraphicsState()];
  if (primitive.type === "path") {
    for (const command of primitive.commands)
      operators.push(
        command.op === "M"
          ? moveTo(command.x, y(command.y))
          : command.op === "L"
            ? lineTo(command.x, y(command.y))
            : closePath(),
      );
  } else {
    const { cx, rx, ry } = primitive;
    const cy = y(primitive.cy);
    const ox = rx * KAPPA;
    const oy = ry * KAPPA;
    operators.push(
      moveTo(cx + rx, cy),
      appendBezierCurve(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry),
      appendBezierCurve(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy),
      appendBezierCurve(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry),
      appendBezierCurve(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy),
      closePath(),
    );
  }
  if (primitive.fillHex) operators.push(setFillingRgbColor(...hexToRgb(primitive.fillHex)));
  if (primitive.stroke) operators.push(...strokeState(primitive.stroke));
  operators.push(
    primitive.fillHex && primitive.stroke ? fillAndStroke() : primitive.fillHex ? fill() : stroke(),
    popGraphicsState(),
  );
  page.pushOperators(...operators);
}

function strokeState(style: StrokeStyle): PDFOperator[] {
  return [
    setStrokingRgbColor(...hexToRgb(style.colorHex)),
    setLineWidth(style.widthPt),
    setLineCap(0),
    setLineJoin(0),
    // Match the canvas and SVG renderers' miter limit (pdf-lib has no helper for `M`).
    PDFOperator.of("M" as Parameters<typeof PDFOperator.of>[0], [PDFNumber.of(4)]),
    setDashPattern(style.dash, 0),
  ];
}
