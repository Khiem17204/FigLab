import {
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  TEXT_LINE_HEIGHT_EM,
  type TextStyleV2,
} from "@figlab/figure-schema";
import { objectBounds } from "./bounds.js";

type Command = (document: FigureDocument) => FigureDocument;

export type LabelSequence = "upper" | "lower" | "number";
/** Measures a single line of text in points for a given style. */
export type TextMeasure = (text: string, style: TextStyleV2) => number;

export const DEFAULT_PANEL_LABEL_STYLE: TextStyleV2 = {
  fontSizePt: 12,
  bold: true,
  italic: false,
  underline: false,
  colorHex: "#000000",
  align: "start",
  backgroundHex: null,
};

/** Rough Arial-like advance used when no font measurement is available. */
export const approximateTextMeasure: TextMeasure = (text, style) =>
  text.length * style.fontSizePt * 0.6;

/** A, B, …, Z, AA, AB, … (or lowercase, or 1, 2, 3 …) for a zero-based position. */
export function panelLabelText(index: number, sequence: LabelSequence): string {
  if (sequence === "number") return String(index + 1);
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return sequence === "lower" ? label.toLowerCase() : label;
}

/**
 * Orders objects the way a reader scans a figure: rows from top to bottom, left to right in a
 * row. Two objects share a row when their vertical extents overlap by at least half the shorter.
 */
export function readingOrder(objects: ReadonlyArray<FigureObject>): string[] {
  const items = objects
    .map((object) => ({ id: object.id, bounds: objectBounds(object) }))
    .sort(
      (left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left,
    );
  const rows: { top: number; bottom: number; items: typeof items }[] = [];
  for (const item of items) {
    const height = item.bounds.bottom - item.bounds.top;
    const row = rows.find((candidate) => {
      const overlap =
        Math.min(candidate.bottom, item.bounds.bottom) - Math.max(candidate.top, item.bounds.top);
      const shorter = Math.min(candidate.bottom - candidate.top, height);
      return overlap >= shorter / 2;
    });
    if (row) {
      row.items.push(item);
      row.top = Math.min(row.top, item.bounds.top);
      row.bottom = Math.max(row.bottom, item.bounds.bottom);
    } else rows.push({ top: item.bounds.top, bottom: item.bounds.bottom, items: [item] });
  }
  return rows
    .sort((left, right) => left.top - right.top)
    .flatMap((row) =>
      row.items.sort((left, right) => left.bounds.left - right.bounds.left).map((item) => item.id),
    );
}

export function textBoxSize(
  content: string,
  style: TextStyleV2,
  measure: TextMeasure = approximateTextMeasure,
): { widthPt: number; heightPt: number } {
  const lines = content.split("\n");
  return {
    widthPt: Math.max(1, ...lines.map((line) => measure(line, style))),
    heightPt: lines.length * style.fontSizePt * TEXT_LINE_HEIGHT_EM,
  };
}

/**
 * Re-letters every panel label on an artboard in the reading order of the panels they label.
 * Auto labels take the letter for their position; manual labels keep their text.
 */
export function relabelPanelsCommand(
  artboardId: string,
  sequence: LabelSequence,
  measure: TextMeasure = approximateTextMeasure,
): Command {
  return (document) => {
    const byId = new Map(document.objects.map((object) => [object.id, object]));
    const labels = document.objects.filter(
      (object): object is Extract<FigureObject, { type: "text" }> =>
        object.type === "text" &&
        object.artboardId === artboardId &&
        object.panelLabel !== undefined,
    );
    const targets = labels.map((label) => byId.get(label.panelLabel?.targetObjectId ?? ""));
    const order = readingOrder(targets.filter((target) => target !== undefined));
    const position = new Map(order.map((id, index) => [id, index]));
    const content = new Map<string, string>();
    for (const label of labels) {
      if (!label.panelLabel?.auto) continue;
      const index = position.get(label.panelLabel.targetObjectId);
      if (index !== undefined) content.set(label.id, panelLabelText(index, sequence));
    }
    return decodeFigureDocument({
      ...document,
      objects: document.objects.map((object) => {
        const text = content.get(object.id);
        if (text === undefined || object.type !== "text" || object.text.content === text)
          return object;
        const size = textBoxSize(text, object.text.style, measure);
        return {
          ...object,
          transform: { ...object.transform, ...size },
          text: { ...object.text, content: text },
        };
      }),
    });
  };
}

/**
 * Adds an auto label above the top-left corner of each target that has none (inside the corner
 * when there is no room above), then re-letters the artboard.
 */
export function addPanelLabelsCommand(options: {
  artboardId: string;
  targetIds: ReadonlyArray<string>;
  newId: () => string;
  sequence?: LabelSequence;
  style?: TextStyleV2;
  measure?: TextMeasure;
}): Command {
  const style = options.style ?? DEFAULT_PANEL_LABEL_STYLE;
  const measure = options.measure ?? approximateTextMeasure;
  return (document) => {
    const labelled = new Set(
      document.objects.flatMap((object) =>
        object.type === "text" && object.panelLabel ? [object.panelLabel.targetObjectId] : [],
      ),
    );
    const topZ = Math.max(
      -1,
      ...document.objects
        .filter((object) => object.artboardId === options.artboardId)
        .map((object) => object.zIndex),
    );
    const targets = document.objects.filter(
      (object) =>
        options.targetIds.includes(object.id) &&
        object.artboardId === options.artboardId &&
        !labelled.has(object.id) &&
        !(object.type === "text" && object.panelLabel),
    );
    const labels: FigureObject[] = targets.map((target, index) => {
      const bounds = objectBounds(target);
      const size = textBoxSize("A", style, measure);
      const gap = style.fontSizePt * 0.15;
      const above = bounds.top - size.heightPt - gap;
      return {
        id: options.newId(),
        type: "text",
        artboardId: options.artboardId,
        transform: {
          xPt: above >= 0 ? bounds.left : bounds.left + gap,
          yPt: above >= 0 ? above : bounds.top + gap,
          ...size,
          rotationDeg: 0,
        },
        zIndex: topZ + 1 + index,
        locked: false,
        hidden: false,
        text: { content: "A", style },
        panelLabel: { targetObjectId: target.id, auto: true },
      };
    });
    return relabelPanelsCommand(
      options.artboardId,
      options.sequence ?? "upper",
      measure,
    )(decodeFigureDocument({ ...document, objects: [...document.objects, ...labels] }));
  };
}
