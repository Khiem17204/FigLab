import type { TextStyleV2 } from "@figlab/figure-schema";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { type FontFaceBytes, type FontFaceKey, fontFaceKey } from "./fonts.js";
import type { TextMetrics } from "./scene.js";

/**
 * Text metrics from the bundled font files. Widths sum glyph advances without kerning or
 * ligatures; every renderer disables both so drawn lines match the measured layout.
 */
export function createFontMetrics(faces: FontFaceBytes): TextMetrics {
  const fonts = Object.fromEntries(
    Object.entries(faces).map(([key, bytes]) => [key, fontkit.create(bytes)]),
  ) as Record<FontFaceKey, Font>;
  const regular = fonts.regular;
  const em = regular.unitsPerEm;
  return {
    measure(text: string, style: TextStyleV2): number {
      const font = fonts[fontFaceKey(style)];
      const advance = font
        .glyphsForString(text)
        .reduce((total, glyph) => total + glyph.advanceWidth, 0);
      return (advance / font.unitsPerEm) * style.fontSizePt;
    },
    ascentEm: regular.ascent / em,
    descentEm: Math.abs(regular.descent) / em,
    underlinePositionEm: Math.abs(regular.underlinePosition) / em,
    underlineThicknessEm: regular.underlineThickness / em,
  };
}
