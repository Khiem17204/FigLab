import { approximateTextMeasure } from "@figlab/editor-core";
import {
  FIGURE_FONT_FAMILY,
  type FontFaceBytes,
  type FontFaceKey,
  type TextMetrics,
} from "@figlab/image-processing";
import boldUrl from "@figlab/image-processing/fonts/Arimo-Bold.ttf?url";
import boldItalicUrl from "@figlab/image-processing/fonts/Arimo-BoldItalic.ttf?url";
import italicUrl from "@figlab/image-processing/fonts/Arimo-Italic.ttf?url";
import regularUrl from "@figlab/image-processing/fonts/Arimo-Regular.ttf?url";
import { useEffect, useState } from "react";

const FONT_URLS: Record<FontFaceKey, string> = {
  regular: regularUrl,
  bold: boldUrl,
  italic: italicUrl,
  boldItalic: boldItalicUrl,
};

/** Arimo's metrics with a rough width estimate, used only until the font files load. */
export const FALLBACK_TEXT_METRICS: TextMetrics = {
  measure: approximateTextMeasure,
  ascentEm: 0.905,
  descentEm: 0.212,
  underlinePositionEm: 0.106,
  underlineThicknessEm: 0.073,
};

export type FigureFonts = { faces: FontFaceBytes; metrics: TextMetrics };

let loading: Promise<FigureFonts> | undefined;

/**
 * Fetches the bundled font files once, registers them for canvas drawing, and builds exact
 * metrics. fontkit loads lazily from the vector entry, so it stays out of the main bundle.
 */
export function loadFigureFonts(): Promise<FigureFonts> {
  loading ??= (async () => {
    const entries = await Promise.all(
      (Object.entries(FONT_URLS) as [FontFaceKey, string][]).map(async ([key, url]) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load the figure font (${response.status})`);
        return [key, new Uint8Array(await response.arrayBuffer())] as const;
      }),
    );
    const faces = Object.fromEntries(entries) as FontFaceBytes;
    if (typeof FontFace !== "undefined" && typeof document !== "undefined")
      await Promise.all(
        entries.map(async ([key, bytes]) => {
          const face = new FontFace(FIGURE_FONT_FAMILY, bytes.slice().buffer, {
            weight: key === "bold" || key === "boldItalic" ? "700" : "400",
            style: key === "italic" || key === "boldItalic" ? "italic" : "normal",
          });
          document.fonts.add(await face.load());
        }),
      );
    const { createFontMetrics } = await import("@figlab/image-processing/vector");
    return { faces, metrics: createFontMetrics(faces) };
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/** The loaded figure fonts, or undefined while they load (or if loading failed). */
export function useFigureFonts(): FigureFonts | undefined {
  const [fonts, setFonts] = useState<FigureFonts>();
  useEffect(() => {
    let active = true;
    loadFigureFonts().then(
      (loaded) => {
        if (active) setFonts(loaded);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  return fonts;
}
