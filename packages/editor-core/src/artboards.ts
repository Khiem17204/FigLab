import {
  type ArtboardV1,
  decodeFigureDocument,
  type FigureDocument,
  type FigureObject,
} from "@figlab/figure-schema";
import { duplicateObjects, pruneGroups } from "./arrange.js";

type Command = (document: FigureDocument) => FigureDocument;

export function addArtboardCommand(artboard: ArtboardV1, index?: number): Command {
  return (document) => {
    const artboards = [...document.artboards];
    artboards.splice(index ?? artboards.length, 0, artboard);
    return decodeFigureDocument({ ...document, artboards });
  };
}

export function updateArtboardCommand(
  id: string,
  patch: Partial<Pick<ArtboardV1, "name" | "widthPt" | "heightPt" | "backgroundHex">>,
): Command {
  return (document) =>
    decodeFigureDocument({
      ...document,
      artboards: document.artboards.map((artboard) =>
        artboard.id === id ? { ...artboard, ...patch } : artboard,
      ),
    });
}

/** Removes an artboard and everything on it. The last artboard cannot be removed. */
export function removeArtboardCommand(id: string): Command {
  return (document) => {
    if (document.artboards.length <= 1 || !document.artboards.some((board) => board.id === id))
      return document;
    const removed = new Set(
      document.objects.filter((object) => object.artboardId === id).map((object) => object.id),
    );
    return decodeFigureDocument({
      ...document,
      artboards: document.artboards.filter((artboard) => artboard.id !== id),
      objects: document.objects.filter((object) => !removed.has(object.id)),
      groups: pruneGroups(document.groups, removed),
    });
  };
}

export function moveArtboardCommand(id: string, toIndex: number): Command {
  return (document) => {
    const from = document.artboards.findIndex((artboard) => artboard.id === id);
    if (from < 0) return document;
    const artboards = [...document.artboards];
    const [moved] = artboards.splice(from, 1);
    artboards.splice(Math.max(0, Math.min(toIndex, artboards.length)), 0, moved as ArtboardV1);
    return decodeFigureDocument({ ...document, artboards });
  };
}

/**
 * Copies an artboard with all of its objects and groups (fresh IDs, same positions), placed
 * right after the original. Image copies keep their source asset, so provenance is preserved.
 */
export function duplicateArtboardCommand(
  sourceId: string,
  artboard: Pick<ArtboardV1, "id" | "name">,
  newId: () => string,
): Command {
  return (document) => {
    const index = document.artboards.findIndex((candidate) => candidate.id === sourceId);
    const source = document.artboards[index];
    if (!source) return document;
    const withBoard = addArtboardCommand({ ...source, ...artboard }, index + 1)(document);
    const ids = document.objects
      .filter((object) => object.artboardId === sourceId)
      .map((object) => object.id);
    // Copies are made unlocked by duplicateObjects; restore each copy's lock afterwards.
    const unlocked = {
      ...withBoard,
      objects: withBoard.objects.map((object) => ({ ...object, locked: false }) as FigureObject),
    };
    const { document: copied, idMap } = duplicateObjects(unlocked, ids, newId, { x: 0, y: 0 });
    const original = new Map(document.objects.map((object) => [object.id, object]));
    const copyOf = new Map([...idMap].map(([from, to]) => [to, from]));
    return decodeFigureDocument({
      ...copied,
      objects: copied.objects.map((object) => {
        const from = copyOf.get(object.id) ?? object.id;
        const source = original.get(from);
        return {
          ...object,
          locked: source?.locked ?? object.locked,
          ...(copyOf.has(object.id) && source
            ? { artboardId: artboard.id, zIndex: source.zIndex }
            : {}),
        } as FigureObject;
      }),
    });
  };
}
