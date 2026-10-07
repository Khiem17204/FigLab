/** The one family figures use, bundled so every renderer measures and draws the same glyphs. */
export const FIGURE_FONT_FAMILY = "Arimo";
export const FIGURE_FONT_FILES = {
  regular: "Arimo-Regular.ttf",
  bold: "Arimo-Bold.ttf",
  italic: "Arimo-Italic.ttf",
  boldItalic: "Arimo-BoldItalic.ttf",
} as const;

export type FontFaceKey = keyof typeof FIGURE_FONT_FILES;
export type FontFaceBytes = Record<FontFaceKey, Uint8Array>;

export function fontFaceKey(style: { bold: boolean; italic: boolean }): FontFaceKey {
  if (style.bold) return style.italic ? "boldItalic" : "bold";
  return style.italic ? "italic" : "regular";
}
