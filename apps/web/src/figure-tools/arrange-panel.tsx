import {
  type AlignEdge,
  addPanelLabelsCommand,
  alignObjectsCommand,
  arrangementUnits,
  artboardBounds,
  distributeObjectsCommand,
  duplicateObjects,
  groupObjectsCommand,
  type LabelSequence,
  type ReorderDirection,
  relabelPanelsCommand,
  reorderObjectsCommand,
  setObjectFlagsCommand,
  ungroupObjectsCommand,
} from "@figlab/editor-core";
import type { FigureObject } from "@figlab/figure-schema";
import type { TextMetrics } from "@figlab/image-processing";
import { Button } from "@figlab/ui";
import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { EditorSessionState, EditorTool } from "../editor/session-store";

const TOOLS: [EditorTool, string][] = [
  ["select", "Select"],
  ["text", "Text"],
  ["line", "Line"],
  ["arrow", "Arrow"],
  ["rect", "Rectangle"],
  ["ellipse", "Ellipse"],
  ["bracket", "Bracket"],
];
const ALIGN: [AlignEdge, string][] = [
  ["left", "Align left"],
  ["center", "Align centers"],
  ["right", "Align right"],
  ["top", "Align top"],
  ["middle", "Align middles"],
  ["bottom", "Align bottom"],
];
const ORDER: [ReorderDirection, string][] = [
  ["front", "Bring to front"],
  ["forward", "Bring forward"],
  ["backward", "Send backward"],
  ["back", "Send to back"],
];

export function objectLabel(object: FigureObject): string {
  if (object.type === "text")
    return `${object.panelLabel ? "Label" : "Text"} “${object.text.content.slice(0, 24)}”`;
  if (object.type === "line") return object.line.heads === "none" ? "Line" : "Arrow";
  if (object.type === "shape")
    return object.shape.kind === "rect"
      ? "Rectangle"
      : object.shape.kind === "ellipse"
        ? "Ellipse"
        : "Bracket";
  if (object.type === "composite") return "Merged channels";
  if (object.type === "scale-bar") return "Scale bar";
  if (object.type === "lane-table") return "Lane labels";
  if (object.type === "mw-labels") return "MW labels";
  if (object.type === "zoom-link") return "Zoom outline";
  return "Image panel";
}

/** Tools, arrangement, panel lettering, and the layer list for the active figure. */
export function ArrangePanel({
  session,
  metrics,
}: {
  session: StoreApi<EditorSessionState>;
  metrics: TextMetrics;
}) {
  const state = useStore(session);
  const [alignTo, setAlignTo] = useState<"selection" | "figure">("selection");
  const [sequence, setSequence] = useState<LabelSequence>("upper");
  const board = state.document.artboards.find((artboard) => artboard.id === state.activeArtboardId);
  const { apply } = session.getState();
  const ids = state.selectedIds;
  const units = arrangementUnits(state.document, ids).length;
  const onBoard = state.document.objects
    .filter((object) => object.artboardId === board?.id)
    .sort((left, right) => right.zIndex - left.zIndex);
  const selectedObjects = onBoard.filter((object) => ids.includes(object.id));
  const grouped = state.document.groups.some((group) =>
    group.objectIds.some((id) => ids.includes(id)),
  );
  const allLocked = selectedObjects.length > 0 && selectedObjects.every((object) => object.locked);
  const panelTargets = (selectedObjects.length > 0 ? selectedObjects : onBoard).filter(
    (object) => object.type === "image-view",
  );

  return (
    <section aria-label="Figure tools" className="figure-tools-panel">
      <fieldset>
        <legend>Tools</legend>
        {TOOLS.map(([tool, label]) => (
          <Button
            aria-pressed={state.tool === tool}
            key={tool}
            onClick={() => session.getState().setTool(tool)}
          >
            {label}
          </Button>
        ))}
      </fieldset>
      <fieldset>
        <legend>Arrange</legend>
        <label className="inline">
          Align to
          <select
            onChange={(event) => setAlignTo(event.target.value as "selection" | "figure")}
            value={alignTo}
          >
            <option value="selection">Selection</option>
            <option value="figure">Figure</option>
          </select>
        </label>
        {ALIGN.map(([edge, label]) => (
          <Button
            disabled={alignTo === "selection" ? units < 2 : units < 1}
            key={edge}
            onClick={() =>
              apply(
                alignObjectsCommand(
                  ids,
                  edge,
                  alignTo === "figure" && board ? artboardBounds(board) : undefined,
                ),
              )
            }
          >
            {label}
          </Button>
        ))}
        <Button
          disabled={units < 3}
          onClick={() => apply(distributeObjectsCommand(ids, "horizontal"))}
        >
          Distribute horizontally
        </Button>
        <Button
          disabled={units < 3}
          onClick={() => apply(distributeObjectsCommand(ids, "vertical"))}
        >
          Distribute vertically
        </Button>
        {ORDER.map(([direction, label]) => (
          <Button
            disabled={ids.length === 0}
            key={direction}
            onClick={() => apply(reorderObjectsCommand(ids, direction))}
          >
            {label}
          </Button>
        ))}
        <Button
          disabled={ids.length < 2}
          onClick={() => apply(groupObjectsCommand(`group-${crypto.randomUUID()}`, ids))}
        >
          Group
        </Button>
        <Button disabled={!grouped} onClick={() => apply(ungroupObjectsCommand(ids))}>
          Ungroup
        </Button>
        <Button
          disabled={ids.length === 0}
          onClick={() => {
            const { document, idMap } = duplicateObjects(state.document, ids, () =>
              crypto.randomUUID(),
            );
            apply(() => document, { selectedIds: ids.map((id) => idMap.get(id) ?? id) });
          }}
        >
          Duplicate
        </Button>
        <Button
          disabled={ids.length === 0}
          onClick={() => apply(setObjectFlagsCommand(ids, { locked: !allLocked }))}
        >
          {allLocked ? "Unlock" : "Lock"}
        </Button>
        <Button
          disabled={ids.length === 0}
          onClick={() => apply(setObjectFlagsCommand(ids, { hidden: true }), { selectedIds: [] })}
        >
          Hide
        </Button>
        <Button
          disabled={ids.length === 0}
          onClick={() => session.getState().deleteSelectedObject()}
        >
          Delete selection
        </Button>
        <label className="inline">
          <input
            checked={state.snapThresholdPt > 0}
            onChange={(event) => session.getState().setSnapThreshold(event.target.checked ? 4 : 0)}
            type="checkbox"
          />
          Snap to guides
        </label>
      </fieldset>
      <fieldset>
        <legend>Panel labels</legend>
        <label className="inline">
          Style
          <select
            onChange={(event) => setSequence(event.target.value as LabelSequence)}
            value={sequence}
          >
            <option value="upper">A, B, C</option>
            <option value="lower">a, b, c</option>
            <option value="number">1, 2, 3</option>
          </select>
        </label>
        <Button
          disabled={!board || panelTargets.length === 0}
          onClick={() =>
            board &&
            apply(
              addPanelLabelsCommand({
                artboardId: board.id,
                targetIds: panelTargets.map((object) => object.id),
                newId: () => `label-${crypto.randomUUID()}`,
                sequence,
                measure: metrics.measure,
              }),
            )
          }
        >
          Label panels
        </Button>
        <Button
          disabled={!board}
          onClick={() => board && apply(relabelPanelsCommand(board.id, sequence, metrics.measure))}
        >
          Re-letter panels
        </Button>
      </fieldset>
      <fieldset>
        <legend>Layers (top first)</legend>
        <ul className="layer-list">
          {onBoard.map((object) => (
            <li key={object.id}>
              <Button
                aria-pressed={ids.includes(object.id)}
                onClick={(event) =>
                  session.getState().select([object.id], event.shiftKey ? "toggle" : "replace")
                }
              >
                {objectLabel(object)}
              </Button>
              <Button
                aria-label={`${object.hidden ? "Show" : "Hide"} ${object.id}`}
                onClick={() =>
                  apply(setObjectFlagsCommand([object.id], { hidden: !object.hidden }))
                }
              >
                {object.hidden ? "Show" : "Hide"}
              </Button>
              {object.locked && <span>locked</span>}
            </li>
          ))}
        </ul>
      </fieldset>
    </section>
  );
}
