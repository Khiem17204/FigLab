import {
  addArtboardCommand,
  duplicateArtboardCommand,
  removeArtboardCommand,
  updateArtboardCommand,
} from "@figlab/editor-core";
import {
  ARTBOARD_SIZE_PRESETS,
  type ArtboardV1,
  mmToPt,
  presetSizePt,
  ptToMm,
} from "@figlab/figure-schema";
import { Button, useDialogs } from "@figlab/ui";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { EditorSessionState } from "../editor/session-store";

const newId = () => crypto.randomUUID();
const mm = (pt: number) => Number(ptToMm(pt).toFixed(1));

/** Which preset (if any) an artboard's size matches, to within a tenth of a millimetre. */
export function matchingPresetId(artboard: Pick<ArtboardV1, "widthPt" | "heightPt">): string {
  const preset = ARTBOARD_SIZE_PRESETS.find((candidate) => {
    const size = presetSizePt(candidate, artboard.heightPt);
    return (
      Math.abs(size.widthPt - artboard.widthPt) < 0.3 &&
      Math.abs(size.heightPt - artboard.heightPt) < 0.3
    );
  });
  return preset?.id ?? "custom";
}

export function nextFigureName(artboards: ReadonlyArray<Pick<ArtboardV1, "name">>): string {
  const used = new Set(artboards.map((artboard) => artboard.name));
  let index = artboards.length + 1;
  while (used.has(`Figure ${index}`)) index += 1;
  return `Figure ${index}`;
}

/** Lists the project's figures (artboards) and edits the active one's name and size. */
export function FiguresBar({ session }: { session: StoreApi<EditorSessionState> }) {
  const dialogs = useDialogs();
  const state = useStore(session);
  const { artboards } = state.document;
  const active = artboards.find((artboard) => artboard.id === state.activeArtboardId);
  const apply = session.getState().apply;
  return (
    <section aria-label="Figures" className="figures-bar">
      {artboards.map((artboard) => (
        <Button
          aria-pressed={artboard.id === active?.id}
          key={artboard.id}
          onClick={() => session.getState().setActiveArtboard(artboard.id)}
        >
          {artboard.name}
        </Button>
      ))}
      <Button
        onClick={() => {
          const id = newId();
          apply(
            addArtboardCommand({
              id,
              name: nextFigureName(artboards),
              widthPt: active?.widthPt ?? 612,
              heightPt: active?.heightPt ?? 792,
              backgroundHex: "#FFFFFF",
            }),
            { selectedIds: [], activeArtboardId: id },
          );
        }}
      >
        Add figure
      </Button>
      {active && (
        <>
          <Button
            onClick={() => {
              const id = newId();
              apply(
                duplicateArtboardCommand(active.id, { id, name: `${active.name} copy` }, newId),
                {
                  selectedIds: [],
                  activeArtboardId: id,
                },
              );
            }}
          >
            Duplicate figure
          </Button>
          <Button
            disabled={artboards.length < 2}
            onClick={async () => {
              const confirmed = await dialogs.confirm({
                title: `Delete “${active.name}”?`,
                description: "Everything on this figure is removed. Undo brings it back.",
                confirmLabel: "Delete figure",
                destructive: true,
              });
              if (confirmed) apply(removeArtboardCommand(active.id), { selectedIds: [] });
            }}
          >
            Delete figure
          </Button>
          <label>
            Figure name
            <input
              key={`name-${active.id}`}
              defaultValue={active.name}
              maxLength={120}
              onBlur={(event) => {
                const name = event.currentTarget.value.trim();
                if (name && name !== active.name) apply(updateArtboardCommand(active.id, { name }));
              }}
            />
          </label>
          <label>
            Figure size
            <select
              onChange={(event) => {
                const preset = ARTBOARD_SIZE_PRESETS.find(
                  (candidate) => candidate.id === event.target.value,
                );
                if (preset)
                  apply(updateArtboardCommand(active.id, presetSizePt(preset, active.heightPt)));
              }}
              value={matchingPresetId(active)}
            >
              <option value="custom">Custom</option>
              {ARTBOARD_SIZE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label} ({preset.widthMm} mm)
                </option>
              ))}
            </select>
          </label>
          {(["widthPt", "heightPt"] as const).map((key) => (
            <label key={`${active.id}-${key}-${active[key]}`}>
              {key === "widthPt" ? "Width (mm)" : "Height (mm)"}
              <input
                defaultValue={mm(active[key])}
                min="1"
                onBlur={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (
                    Number.isFinite(value) &&
                    value > 0 &&
                    Math.abs(mmToPt(value) - active[key]) > 0.01
                  )
                    apply(updateArtboardCommand(active.id, { [key]: mmToPt(value) }));
                }}
                step="0.1"
                type="number"
              />
            </label>
          ))}
        </>
      )}
    </section>
  );
}
