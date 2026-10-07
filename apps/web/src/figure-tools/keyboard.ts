import {
  duplicateObjects,
  groupObjectsCommand,
  moveObjectsCommand,
  ungroupObjectsCommand,
} from "@figlab/editor-core";
import type { StoreApi } from "zustand/vanilla";

import type { EditorSessionState } from "../editor/session-store";

const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Figure-editing shortcuts. Returns true when it handled the event. Callers skip events from
 * text fields so typing never moves objects.
 */
export function handleFigureShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  session: StoreApi<EditorSessionState>,
): boolean {
  const state = session.getState();
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.key === "Escape") {
    state.cancelObjectGesture();
    state.setTool("select");
    state.select([]);
    return true;
  }
  if (command && key === "a") {
    state.select(
      state.document.objects
        .filter((object) => object.artboardId === state.activeArtboardId && !object.hidden)
        .map((object) => object.id),
    );
    return true;
  }
  if (state.selectedIds.length === 0) return false;
  if (command && key === "d") {
    const { document, idMap } = duplicateObjects(state.document, state.selectedIds, () =>
      crypto.randomUUID(),
    );
    state.apply(() => document, {
      selectedIds: state.selectedIds.map((id) => idMap.get(id) ?? id),
    });
    return true;
  }
  if (command && key === "g") {
    if (event.shiftKey) state.apply(ungroupObjectsCommand(state.selectedIds));
    else state.apply(groupObjectsCommand(`group-${crypto.randomUUID()}`, state.selectedIds));
    return true;
  }
  const nudge = NUDGE[event.key];
  if (nudge && !command) {
    const step = event.shiftKey ? 10 : 1;
    state.apply(moveObjectsCommand(state.selectedIds, nudge[0] * step, nudge[1] * step));
    return true;
  }
  return false;
}
