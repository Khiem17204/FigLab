import {
  attachedTargetIds,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
  isImagePanel,
} from "@figlab/figure-schema";
import { pruneGroups } from "./arrange.js";

/** Placeholder frames drawn where a template's image panels were. */
export const TEMPLATE_PLACEHOLDER_STROKE = { colorHex: "#9AA3B2", widthPt: 0.5, dashed: true };

/**
 * A reusable layout made from a figure, holding no image references: each image panel becomes
 * a dashed placeholder frame with the same id and box (so groups and order survive), panel
 * labels become plain text, annotations that need an image (scale bars, lane tables, MW labels,
 * zoom outlines) are dropped, and the source registry is emptied.
 */
export function templateDocument(document: FigureDocument): FigureDocument {
  const panels = new Set(document.objects.filter(isImagePanel).map((object) => object.id));
  const objects: FigureObject[] = [];
  for (const object of document.objects) {
    if (isImagePanel(object)) {
      objects.push({
        id: object.id,
        type: "shape",
        artboardId: object.artboardId,
        transform: { ...object.transform },
        zIndex: object.zIndex,
        locked: object.locked,
        hidden: object.hidden,
        shape: { kind: "rect", stroke: { ...TEMPLATE_PLACEHOLDER_STROKE }, fillHex: null },
      });
      continue;
    }
    if (object.type === "text" && object.panelLabel) {
      const { panelLabel: _detached, ...plain } = object;
      objects.push(plain);
      continue;
    }
    if (attachedTargetIds(object).some((id) => panels.has(id))) continue;
    objects.push(structuredClone(object));
  }
  const kept = new Set(objects.map((object) => object.id));
  const removed = new Set(
    document.objects.map((object) => object.id).filter((id) => !kept.has(id)),
  );
  return decodeFigureDocument({
    ...structuredClone(document),
    sources: [],
    objects,
    groups: pruneGroups(document.groups, removed),
  });
}
