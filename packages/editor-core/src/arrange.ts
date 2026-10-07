import {
  attachedTargetIds,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
} from "@figlab/figure-schema";
import { type Bounds, objectBounds, unionBounds } from "./bounds.js";

type Command = (document: FigureDocument) => FigureDocument;

export function pruneGroups(
  groups: FigureDocument["groups"],
  removed: ReadonlySet<string>,
): FigureDocument["groups"] {
  return groups
    .map((group) => ({ ...group, objectIds: group.objectIds.filter((id) => !removed.has(id)) }))
    .filter((group) => group.objectIds.length >= 2);
}

/** Something that moves as one: a group, or a lone object, plus panel labels attached to it. */
export type ArrangementUnit = { objectIds: string[]; bounds: Bounds };

/**
 * Expands a selection to whole groups and to the panel labels attached to selected objects.
 * Locked objects are dropped: they cannot be moved, aligned, or reordered.
 */
export function expandSelection(document: FigureDocument, ids: Iterable<string>): string[] {
  const selected = new Set(ids);
  for (const group of document.groups)
    if (group.objectIds.some((id) => selected.has(id)))
      for (const id of group.objectIds) selected.add(id);
  // Attached objects follow their targets; zoom links follow when either panel moves.
  for (const object of document.objects)
    if (attachedTargetIds(object).some((target) => selected.has(target))) selected.add(object.id);
  return document.objects
    .filter((object) => selected.has(object.id) && !object.locked)
    .map((object) => object.id);
}

export function arrangementUnits(
  document: FigureDocument,
  ids: Iterable<string>,
): ArrangementUnit[] {
  const expanded = new Set(expandSelection(document, ids));
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const unitOf = new Map<string, string[]>();
  const units: string[][] = [];
  for (const group of document.groups) {
    const members = group.objectIds.filter((id) => expanded.has(id));
    if (members.length === 0) continue;
    units.push(members);
    for (const id of members) unitOf.set(id, members);
  }
  for (const object of document.objects) {
    if (!expanded.has(object.id) || unitOf.has(object.id)) continue;
    if (attachedTargetIds(object).some((target) => expanded.has(target))) continue;
    const unit = [object.id];
    units.push(unit);
    unitOf.set(object.id, unit);
  }
  // Attached objects ride with their target's unit; they never define its bounds.
  const labels: [string, string[]][] = [];
  for (const object of document.objects) {
    const targetId = attachedTargetIds(object).find((target) => unitOf.has(target));
    if (!expanded.has(object.id) || targetId === undefined) continue;
    const targetUnit = unitOf.get(targetId);
    if (targetUnit && targetUnit !== unitOf.get(object.id) && !targetUnit.includes(object.id))
      labels.push([object.id, targetUnit]);
  }
  const unitBounds = units.map(
    (unit) => unionBounds(unit.map((id) => objectBounds(byId.get(id) as FigureObject))) as Bounds,
  );
  for (const [labelId, unit] of labels) unit.push(labelId);
  return units.map((objectIds, index) => ({ objectIds, bounds: unitBounds[index] as Bounds }));
}

function translate(object: FigureObject, dxPt: number, dyPt: number): FigureObject {
  if (dxPt === 0 && dyPt === 0) return object;
  return {
    ...object,
    transform: {
      ...object.transform,
      xPt: object.transform.xPt + dxPt,
      yPt: object.transform.yPt + dyPt,
    },
  } as FigureObject;
}

function applyDeltas(document: FigureDocument, deltas: Map<string, [number, number]>) {
  return decodeFigureDocument({
    ...document,
    objects: document.objects.map((object) => {
      const delta = deltas.get(object.id);
      return delta ? translate(object, delta[0], delta[1]) : object;
    }),
  });
}

/** Moves the selection (with its groups and attached labels) by a delta in points. */
export function moveObjectsCommand(
  ids: ReadonlyArray<string>,
  dxPt: number,
  dyPt: number,
): Command {
  return (document) =>
    applyDeltas(
      document,
      new Map(expandSelection(document, ids).map((id) => [id, [dxPt, dyPt] as [number, number]])),
    );
}

export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Aligns units to the selection's bounds, or to `reference` (for example the artboard). */
export function alignObjectsCommand(
  ids: ReadonlyArray<string>,
  edge: AlignEdge,
  reference?: Bounds,
): Command {
  return (document) => {
    const units = arrangementUnits(document, ids);
    const target = reference ?? unionBounds(units.map((unit) => unit.bounds));
    if (target === undefined || (reference === undefined && units.length < 2)) return document;
    const deltas = new Map<string, [number, number]>();
    for (const unit of units) {
      const { left, right, top, bottom } = unit.bounds;
      const dx =
        edge === "left"
          ? target.left - left
          : edge === "right"
            ? target.right - right
            : edge === "center"
              ? (target.left + target.right) / 2 - (left + right) / 2
              : 0;
      const dy =
        edge === "top"
          ? target.top - top
          : edge === "bottom"
            ? target.bottom - bottom
            : edge === "middle"
              ? (target.top + target.bottom) / 2 - (top + bottom) / 2
              : 0;
      for (const id of unit.objectIds) deltas.set(id, [dx, dy]);
    }
    return applyDeltas(document, deltas);
  };
}

/** Spaces three or more units so the gaps between neighbours are equal; the outer two stay. */
export function distributeObjectsCommand(
  ids: ReadonlyArray<string>,
  axis: "horizontal" | "vertical",
): Command {
  return (document) => {
    const units = arrangementUnits(document, ids);
    if (units.length < 3) return document;
    const start = (bounds: Bounds) => (axis === "horizontal" ? bounds.left : bounds.top);
    const size = (bounds: Bounds) =>
      axis === "horizontal" ? bounds.right - bounds.left : bounds.bottom - bounds.top;
    const ordered = [...units].sort((left, right) => start(left.bounds) - start(right.bounds));
    const first = (ordered[0] as ArrangementUnit).bounds;
    const last = (ordered.at(-1) as ArrangementUnit).bounds;
    const span = start(last) + size(last) - start(first);
    const gap =
      (span - ordered.reduce((total, unit) => total + size(unit.bounds), 0)) / (ordered.length - 1);
    const deltas = new Map<string, [number, number]>();
    let cursor = start(first);
    for (const unit of ordered) {
      const delta = cursor - start(unit.bounds);
      for (const id of unit.objectIds)
        deltas.set(id, axis === "horizontal" ? [delta, 0] : [0, delta]);
      cursor += size(unit.bounds) + gap;
    }
    return applyDeltas(document, deltas);
  };
}

export type ReorderDirection = "front" | "back" | "forward" | "backward";

/**
 * Changes stacking order on the selection's artboards, then renumbers each affected artboard's
 * `zIndex` values to 0…n-1 so they stay compact.
 */
export function reorderObjectsCommand(
  ids: ReadonlyArray<string>,
  direction: ReorderDirection,
): Command {
  return (document) => {
    const selected = new Set(expandSelection(document, ids));
    if (selected.size === 0) return document;
    const artboards = new Set(
      document.objects
        .filter((object) => selected.has(object.id))
        .map((object) => object.artboardId),
    );
    const zIndexes = new Map<string, number>();
    for (const artboardId of artboards) {
      const stack = document.objects
        .map((object, index) => ({ object, index }))
        .filter(({ object }) => object.artboardId === artboardId)
        .sort((left, right) => left.object.zIndex - right.object.zIndex || left.index - right.index)
        .map(({ object }) => object.id);
      const isSelected = (id: string) => selected.has(id);
      let next: string[];
      if (direction === "front")
        next = [...stack.filter((id) => !isSelected(id)), ...stack.filter(isSelected)];
      else if (direction === "back")
        next = [...stack.filter(isSelected), ...stack.filter((id) => !isSelected(id))];
      else {
        next = [...stack];
        const step = direction === "forward" ? 1 : -1;
        const order = direction === "forward" ? [...next.keys()].reverse() : [...next.keys()];
        for (const index of order) {
          const current = next[index];
          const other = next[index + step];
          if (current === undefined || other === undefined) continue;
          if (isSelected(current) && !isSelected(other)) {
            next[index] = other;
            next[index + step] = current;
          }
        }
      }
      for (const [zIndex, id] of next.entries()) zIndexes.set(id, zIndex);
    }
    return decodeFigureDocument({
      ...document,
      objects: document.objects.map((object) => {
        const zIndex = zIndexes.get(object.id);
        return zIndex === undefined || zIndex === object.zIndex ? object : { ...object, zIndex };
      }),
    });
  };
}

/** Sets `locked` and/or `hidden`. Unlike other arrange commands, this reaches locked objects. */
export function setObjectFlagsCommand(
  ids: ReadonlyArray<string>,
  flags: { locked?: boolean; hidden?: boolean },
): Command {
  const targets = new Set(ids);
  return (document) =>
    decodeFigureDocument({
      ...document,
      objects: document.objects.map((object) =>
        targets.has(object.id) ? { ...object, ...flags } : object,
      ),
    });
}

/** Groups the selection, absorbing any groups it touches. Needs two or more objects. */
export function groupObjectsCommand(groupId: string, ids: ReadonlyArray<string>): Command {
  return (document) => {
    const members = expandSelection(document, ids);
    if (members.length < 2) return document;
    const memberSet = new Set(members);
    return decodeFigureDocument({
      ...document,
      groups: [
        ...document.groups.filter((group) => !group.objectIds.some((id) => memberSet.has(id))),
        { id: groupId, objectIds: members },
      ],
    });
  };
}

/** Dissolves every group that contains one of the given objects. */
export function ungroupObjectsCommand(ids: ReadonlyArray<string>): Command {
  const targets = new Set(ids);
  return (document) =>
    decodeFigureDocument({
      ...document,
      groups: document.groups.filter((group) => !group.objectIds.some((id) => targets.has(id))),
    });
}

/**
 * Points a copied object's attachment at copied targets. A label whose target was not copied
 * becomes plain text; other attached objects are dropped, since they cannot exist detached.
 */
function remapAttachment(copy: FigureObject, idMap: Map<string, string>): FigureObject | undefined {
  const mapped = (id: string) => idMap.get(id);
  switch (copy.type) {
    case "text": {
      if (!copy.panelLabel) return copy;
      const target = mapped(copy.panelLabel.targetObjectId);
      if (target) return { ...copy, panelLabel: { ...copy.panelLabel, targetObjectId: target } };
      const { panelLabel: _detached, ...plain } = copy;
      return plain;
    }
    case "scale-bar": {
      const target = mapped(copy.scaleBar.targetObjectId);
      return target
        ? { ...copy, scaleBar: { ...copy.scaleBar, targetObjectId: target } }
        : undefined;
    }
    case "lane-table": {
      const target = mapped(copy.laneTable.targetObjectId);
      return target
        ? { ...copy, laneTable: { ...copy.laneTable, targetObjectId: target } }
        : undefined;
    }
    case "mw-labels": {
      const target = mapped(copy.mwLabels.targetObjectId);
      return target
        ? { ...copy, mwLabels: { ...copy.mwLabels, targetObjectId: target } }
        : undefined;
    }
    case "zoom-link": {
      const from = mapped(copy.zoomLink.sourceObjectId);
      const inset = mapped(copy.zoomLink.insetObjectId);
      return from && inset
        ? { ...copy, zoomLink: { ...copy.zoomLink, sourceObjectId: from, insetObjectId: inset } }
        : undefined;
    }
    default:
      return copy;
  }
}

/**
 * Copies the selection (with groups and attached labels) above everything else on its artboard,
 * offset by a delta. Labels keep their link only when their target was copied too, and image
 * copies keep `sourceAssetId`, so they stay provenance siblings of the original crop.
 */
export function duplicateObjects(
  document: FigureDocument,
  ids: ReadonlyArray<string>,
  newId: () => string,
  offsetPt = { x: 10, y: 10 },
): { document: FigureDocument; idMap: Map<string, string> } {
  const selected = new Set(expandSelection(document, ids));
  const idMap = new Map<string, string>();
  for (const object of document.objects) if (selected.has(object.id)) idMap.set(object.id, newId());
  const topZ = new Map<string, number>();
  for (const object of document.objects)
    topZ.set(object.artboardId, Math.max(topZ.get(object.artboardId) ?? -1, object.zIndex));
  const originals = document.objects
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => selected.has(object.id))
    .sort((left, right) => left.object.zIndex - right.object.zIndex || left.index - right.index)
    .map(({ object }) => object);
  const copies = originals
    .map((object) => {
      const zIndex = (topZ.get(object.artboardId) ?? -1) + 1;
      topZ.set(object.artboardId, zIndex);
      const copy = {
        ...translate(structuredClone(object), offsetPt.x, offsetPt.y),
        id: idMap.get(object.id) as string,
        zIndex,
        locked: false,
      } as FigureObject;
      return remapAttachment(copy, idMap);
    })
    .filter((copy): copy is FigureObject => copy !== undefined);
  const groups = document.groups
    .filter((group) => group.objectIds.every((id) => idMap.has(id)))
    .map((group) => ({
      id: newId(),
      objectIds: group.objectIds.map((id) => idMap.get(id) as string),
    }));
  return {
    document: decodeFigureDocument({
      ...document,
      objects: [...document.objects, ...copies],
      groups: [...document.groups, ...groups],
    }),
    idMap,
  };
}
