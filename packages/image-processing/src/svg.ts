import type { FigureDocument } from "@figlab/figure-schema";
import { bytesToBase64 } from "./encode.js";
import { renderPanelPng, sceneFor } from "./export.js";
import { FIGURE_FONT_FAMILY, type FontFaceBytes, type FontFaceKey, fontFaceKey } from "./fonts.js";
import { documentSourceSizes } from "./panel-render.js";
import type { RasterSourceResolver } from "./raster.js";
import type { PathCommand, StrokeStyle, TextMetrics, VectorPrimitive } from "./scene.js";

const number = (value: number) => Number(value.toFixed(3)).toString();
const escapeXml = (value: string) =>
  value.replace(/[<>&"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function svgPathData(commands: ReadonlyArray<PathCommand>): string {
  return commands
    .map((command) =>
      command.op === "Z" ? "Z" : `${command.op}${number(command.x)} ${number(command.y)}`,
    )
    .join(" ");
}

function paintAttributes(primitive: { stroke?: StrokeStyle; fillHex?: string }): string {
  const fill = `fill="${primitive.fillHex ?? "none"}"`;
  if (!primitive.stroke) return fill;
  const { colorHex, widthPt, dash } = primitive.stroke;
  return `${fill} stroke="${colorHex}" stroke-width="${number(widthPt)}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="4"${
    dash.length > 0 ? ` stroke-dasharray="${dash.map(number).join(" ")}"` : ""
  }`;
}

function primitiveSvg(primitive: VectorPrimitive): string {
  if (primitive.type === "path")
    return `<path d="${svgPathData(primitive.commands)}" ${paintAttributes(primitive)}/>`;
  if (primitive.type === "ellipse")
    return `<ellipse cx="${number(primitive.cx)}" cy="${number(primitive.cy)}" rx="${number(primitive.rx)}" ry="${number(primitive.ry)}" ${paintAttributes(primitive)}/>`;
  return `<text x="${number(primitive.x)}" y="${number(primitive.baselineY)}" font-family="${FIGURE_FONT_FAMILY}" font-size="${number(primitive.fontSizePt)}" font-weight="${primitive.bold ? 700 : 400}" font-style="${primitive.italic ? "italic" : "normal"}" fill="${primitive.colorHex}" xml:space="preserve">${escapeXml(primitive.text)}</text>`;
}

/**
 * Writes an artboard as a self-contained SVG sized in points. Image panels are embedded as
 * lossless PNGs rendered from original samples at `dpi`; text uses the embedded bundled font.
 */
export async function composeArtboardSvg(
  document: FigureDocument,
  artboardId: string,
  options: {
    dpi: number;
    resolver: RasterSourceResolver;
    metrics: TextMetrics;
    fonts: FontFaceBytes;
  },
): Promise<string> {
  const scene = sceneFor(document, artboardId, options.metrics);
  const sizes = documentSourceSizes(document, options.resolver);
  const body: string[] = [];
  const usedFaces = new Set<FontFaceKey>();
  for (const item of scene.items) {
    if (item.kind === "raster") {
      const { png } = await renderPanelPng(item.object, options.dpi, options.resolver, sizes);
      const { xPt, yPt, widthPt, heightPt } = item.object.transform;
      body.push(
        `<image data-object-id="${escapeXml(item.object.id)}" x="${number(xPt)}" y="${number(yPt)}" width="${number(widthPt)}" height="${number(heightPt)}" preserveAspectRatio="none" href="data:image/png;base64,${bytesToBase64(png)}"/>`,
      );
      continue;
    }
    for (const primitive of item.primitives)
      if (primitive.type === "text") usedFaces.add(fontFaceKey(primitive));
    const transform = item.rotation
      ? ` transform="rotate(${number(item.rotation.deg)} ${number(item.rotation.cx)} ${number(item.rotation.cy)})"`
      : "";
    body.push(
      `<g data-object-id="${escapeXml(item.objectId)}"${transform}>${item.primitives.map(primitiveSvg).join("")}</g>`,
    );
  }
  const fontFaces = [...usedFaces]
    .map((key) => {
      const bold = key === "bold" || key === "boldItalic";
      const italic = key === "italic" || key === "boldItalic";
      return `@font-face{font-family:"${FIGURE_FONT_FAMILY}";font-weight:${bold ? 700 : 400};font-style:${italic ? "italic" : "normal"};src:url(data:font/ttf;base64,${bytesToBase64(options.fonts[key])}) format("truetype");}`;
    })
    .join("");
  const style = `<style>${fontFaces}text{font-kerning:none;font-variant-ligatures:none;}</style>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${number(scene.widthPt)}pt" height="${number(scene.heightPt)}pt" viewBox="0 0 ${number(scene.widthPt)} ${number(scene.heightPt)}">`,
    style,
    `<rect width="${number(scene.widthPt)}" height="${number(scene.heightPt)}" fill="${scene.backgroundHex}"/>`,
    ...body,
    "</svg>",
  ].join("\n");
}
